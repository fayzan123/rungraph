import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  SESSION_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');

/**
 * A live MCP client speaking the real thing over stdio: no mocks, because the
 * bug this suite exists to catch is a stray write to stdout corrupting the
 * channel, and only the real transport can show that.
 */
function client(env) {
  const child = spawn('node', [BIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const extra = []; // anything on stdout that was not a JSON-RPC response
  let stderr = '';
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        extra.push(line);
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      } else extra.push(line);
    }
  });

  let nextId = 0;
  const send = (method, params) => {
    const id = ++nextId;
    const p = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  return {
    send,
    notify: (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    raw: (line) => child.stdin.write(line + '\n'),
    get extra() {
      return extra;
    },
    get stderr() {
      return stderr;
    },
    async call(name, args = {}) {
      const res = await this.send('tools/call', { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { isError: Boolean(res.result?.isError), payload: parsed, raw: res };
    },
    close: () =>
      new Promise((resolve) => {
        child.once('close', resolve);
        child.stdin.end();
      }),
  };
}

let mcp;
let portDir;
let tmp;
const env = { ...process.env, RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT, RUNGRAPH_CODEX_SESSIONS: CODEX_FIXTURE_ROOT };

/** Write a registry entry the way a live server would. */
const registerServer = async (port, sources = ['local'], startedAt = new Date().toISOString(), pid = process.pid) => {
  await mkdir(portDir, { recursive: true });
  await writeFile(
    join(portDir, `${port}.json`),
    JSON.stringify({ port, pid, startedAt, sources }) + '\n',
  );
};

beforeAll(async () => {
  await pinFixtureMtimes();
  tmp = await mkdtemp(join(tmpdir(), 'rg-mcp-'));
  // Point port discovery at a scratch registry so the suite can never find —
  // or stomp on — a rungraph the developer happens to be running.
  portDir = join(tmp, 'servers');
  env.RUNGRAPH_PORT_DIR = portDir;
  mcp = client(env);
  const init = await mcp.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0' },
  });
  expect(init.result.serverInfo.name).toBe('rungraph');
  mcp.notify('notifications/initialized');
}, 30000);

afterAll(async () => {
  await mcp?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('MCP transport', () => {
  it('answers initialize with a protocol version and tool capability', async () => {
    const res = await mcp.send('initialize', { protocolVersion: '2025-03-26' });
    expect(res.result.protocolVersion).toBe('2025-03-26'); // echoes the dialect the client speaks
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('falls back to its own protocol version for a nonsense one', async () => {
    const res = await mcp.send('initialize', { protocolVersion: 'banana' });
    expect(res.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('answers ping', async () => {
    expect((await mcp.send('ping', {})).result).toEqual({});
  });

  it('lists every tool with a usable schema', async () => {
    const { result } = await mcp.send('tools/list', {});
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      'find_nodes',
      'focus_nodes',
      'get_current_view',
      'get_detail',
      'get_graph',
      'list_runs',
      'open_visualization',
    ]);
    for (const t of result.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(40); // the model's only docs
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('returns -32601 for an unknown method', async () => {
    const res = await mcp.send('frobnicate', {});
    expect(res.error.code).toBe(-32601);
  });

  it('survives garbage on stdin without answering it', async () => {
    mcp.raw('{not json at all');
    mcp.raw('42');
    mcp.notify('notifications/cancelled', { requestId: 99 });
    expect((await mcp.send('ping', {})).result).toEqual({}); // still alive, still in sync
  });

  // The single worst bug this file can ship: anything on stdout that is not a
  // JSON-RPC response desynchronises the client for the whole conversation.
  it('writes nothing but JSON-RPC to stdout', () => {
    expect(mcp.extra).toEqual([]);
    expect(mcp.stderr).toContain('rungraph mcp:'); // logs went to stderr instead
  });
});

describe('MCP tools (no server running)', () => {
  it('list_runs works straight off disk', async () => {
    const { payload } = await mcp.call('list_runs');
    expect(payload.runs).toHaveLength(FIXTURE_RUN_COUNT);
    expect(payload.runs[0]).toHaveProperty('runId');
  });

  it('get_graph defaults to a compact projection that keeps signals and files', async () => {
    const { payload } = await mcp.call('get_graph', { runId: TROUBLE_RUN_ID });
    expect(payload.detail).toBe('compact');
    expect(payload.signals.map((s) => s.kind)).toContain('retry-storm');
    expect(payload.nodes.some((n) => n.files)).toBe(true);
    // the expensive fields are what compact drops
    expect(payload.nodes.every((n) => n.tokens === undefined)).toBe(true);
    expect(payload.nodes.every((n) => n.durationMs === undefined)).toBe(true);
  });

  it('get_graph detail:"full" restores timings and tokens', async () => {
    const { payload } = await mcp.call('get_graph', { runId: TROUBLE_RUN_ID, detail: 'full' });
    expect(payload.nodes.some((n) => n.durationMs != null)).toBe(true);
    expect(payload.signals.length).toBeGreaterThan(0);
  });

  it('compact is materially cheaper than full', async () => {
    const compact = await mcp.call('get_graph', { runId: SESSION_RUN_ID });
    const full = await mcp.call('get_graph', { runId: SESSION_RUN_ID, detail: 'full' });
    expect(JSON.stringify(compact.payload).length).toBeLessThan(
      JSON.stringify(full.payload).length,
    );
  });

  it('find_nodes narrows to matches, including by file path', async () => {
    const { payload } = await mcp.call('find_nodes', { runId: TROUBLE_RUN_ID, query: 'token.js' });
    expect(payload.matched).toBeGreaterThan(0);
    expect(payload.nodeIds).toHaveLength(payload.nodes.length);
    const graph = (await mcp.call('get_graph', { runId: TROUBLE_RUN_ID })).payload;
    expect(payload.nodes.length).toBeLessThan(graph.nodes.length);
  });

  it('find_nodes reports truncation instead of silently dropping matches', async () => {
    const { payload } = await mcp.call('find_nodes', {
      runId: SESSION_RUN_ID,
      query: 'e',
      limit: 1,
    });
    expect(payload.nodeIds).toHaveLength(1);
    expect(payload.truncated).toBe(true);
    expect(payload.note).toContain('matched');
  });

  it('get_detail returns the lazy payload for a node', async () => {
    const graph = (await mcp.call('get_graph', { runId: SESSION_RUN_ID })).payload;
    const node = graph.nodes.find((n) => n.kind === 'tool');
    const { payload } = await mcp.call('get_detail', { runId: SESSION_RUN_ID, nodeId: node.id });
    expect(payload.detail.kind).toBe('tool');
    expect(payload.detail.calls.length).toBeGreaterThan(0);
  });

  it('reports a bad runId as a readable tool error, not a protocol error', async () => {
    const { isError, payload } = await mcp.call('get_graph', { runId: 'claude-code:nope' });
    expect(isError).toBe(true);
    expect(String(payload)).toContain('list_runs'); // tells the model how to recover
  });

  // Spec §9: with no server, the agent answers in the terminal and says the
  // highlight was skipped. That is a normal result, not a failure.
  it('focus_nodes degrades to "skipped" when nothing is serving', async () => {
    const { isError, payload } = await mcp.call('focus_nodes', {
      runId: SESSION_RUN_ID,
      nodeIds: ['a:toolu_fxA001'],
      label: 'x',
      reason: 'y',
    });
    expect(isError).toBe(false);
    expect(payload.focused).toBe(false);
    expect(payload.reason).toContain('no rungraph server');
  });

  it('get_current_view reports nothing when no browser is connected', async () => {
    const { payload } = await mcp.call('get_current_view');
    expect(payload.runs).toEqual([]);
  });

  it('skips AND deletes a stale registry entry left by a crashed server', async () => {
    // Nothing listens on port 1, and pid 999999 does not exist — a crash.
    await registerServer(1, ['local'], new Date().toISOString(), 999999);
    const { payload } = await mcp.call('get_current_view');
    expect(payload.runs).toEqual([]); // liveness probe failed → treated as no server
    // Opportunistic cleanup: whoever finds a dead entry removes it.
    expect(await readdir(portDir)).not.toContain('1.json');
  }, 20000);

  it('skips but KEEPS the entry of a live-but-unresponsive server', async () => {
    // Port 1 answers nothing, but the recorded pid (this test) is alive — a
    // slow parse, not a crash. Entries are written once, so deleting here
    // would make a running server permanently undiscoverable.
    await registerServer(2, ['local'], new Date().toISOString(), process.pid);
    const { payload } = await mcp.call('get_current_view');
    expect(payload.runs).toEqual([]);
    expect(await readdir(portDir)).toContain('2.json');
    await rm(join(portDir, '2.json'), { force: true });
  }, 20000);
});

describe('MCP tools (server running)', () => {
  let server;
  beforeAll(async () => {
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
    server = await startServer({ preferredPort: 4712 });
    await registerServer(server.port);
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    delete process.env.RUNGRAPH_CODEX_SESSIONS;
    await rm(join(portDir, `${server.port}.json`), { force: true });
    await server.close();
  });

  // `open: false` matters here: without it this call would open a real browser
  // window on the developer's machine every time the suite runs.
  it('finds the server through the registry and posts a focus', async () => {
    const { isError, payload } = await mcp.call('focus_nodes', {
      runId: SESSION_RUN_ID,
      nodeIds: ['a:toolu_fxA001'],
      label: '1 agent',
      reason: 'the audit',
      open: false,
    });
    expect(isError).toBe(false);
    // Nobody is watching, so focused is false — but the POST reached the server
    // and handed back the url the agent should give the user.
    expect(payload.clientCount).toBe(0);
    expect(payload.focused).toBe(false);
    expect(payload.reason).toContain('not requested');
    expect(payload.url).toContain(`:${server.port}`);
    // The url is a deep link now: hash-encoded run + agent focus descriptor.
    expect(payload.url).toContain('#run=');
    expect(payload.url).toContain('&f=');
  }, 20000);

  it('get_current_view talks to the live server', async () => {
    const { payload } = await mcp.call('get_current_view');
    expect(payload.serverUrl).toBe(server.url);
    expect(payload.runs).toEqual([]);
  }, 20000);
});

describe('MCP aggregation (two servers, one a bundle viewer)', () => {
  // The flagship share scenario: the user's own dashboard AND a colleague's
  // opened bundle are live at once. The bundle's runs exist on NO disk here,
  // so every tool has to route by runId to the server that owns them.
  const FOREIGN_RUN_ID = 'claude-code:-work-bilal-acme:99999999-9999-4999-8999-999999999999';
  let local;
  let bundled;

  beforeAll(async () => {
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
    const { buildBundle } = await import('../src/bundle.js');
    const { gzipSync } = await import('node:zlib');
    const { envelope } = await buildBundle([CLEAN_RUN_ID], {
      sharedBy: 'Bilal',
      now: '2026-08-15T18:02:11Z',
    });
    // Re-key the run so it cannot exist locally — B's machine, not ours.
    const foreign = JSON.parse(
      JSON.stringify(envelope).replaceAll(CLEAN_RUN_ID, FOREIGN_RUN_ID),
    );
    const bundlePath = join(tmp, 'team-work.rungraph');
    await writeFile(bundlePath, gzipSync(JSON.stringify(foreign)));

    local = await startServer({ preferredPort: 4720 });
    bundled = await startServer({ preferredPort: 4725, bundles: [bundlePath] });
    await registerServer(local.port, ['local'], '2026-08-15T10:00:00.000Z');
    await registerServer(bundled.port, ['bundle:team-work.rungraph'], '2026-08-15T11:00:00.000Z');
  });
  afterAll(async () => {
    await rm(join(portDir, `${local.port}.json`), { force: true });
    await rm(join(portDir, `${bundled.port}.json`), { force: true });
    await local.close();
    await bundled.close();
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    delete process.env.RUNGRAPH_CODEX_SESSIONS;
  });

  it('list_runs merges both servers, tagging the bundle run with provenance and its dashboard', async () => {
    const { payload } = await mcp.call('list_runs');
    expect(payload.runs).toHaveLength(FIXTURE_RUN_COUNT + 1);
    const foreign = payload.runs.find((r) => r.runId === FOREIGN_RUN_ID);
    expect(foreign.provenance).toMatchObject({ sharedBy: 'Bilal', bundle: 'team-work.rungraph' });
    expect(foreign.dashboard).toBe(bundled.url);
    // local runs are deduplicated, not listed once per server
    expect(payload.runs.filter((r) => r.runId === SESSION_RUN_ID)).toHaveLength(1);
  }, 20000);

  it('get_graph routes a bundle-only run to its owning server', async () => {
    const { isError, payload } = await mcp.call('get_graph', { runId: FOREIGN_RUN_ID });
    expect(isError).toBe(false);
    expect(payload.meta.runId).toBe(FOREIGN_RUN_ID);
    expect(payload.signals).toEqual([]); // the clean run — derived at view time, still zero
  }, 20000);

  it('find_nodes and get_detail work on the routed run', async () => {
    const found = await mcp.call('find_nodes', { runId: FOREIGN_RUN_ID, query: 'CHANGELOG' });
    expect(found.payload.matched).toBeGreaterThan(0);
    const graph = (await mcp.call('get_graph', { runId: FOREIGN_RUN_ID })).payload;
    const turn = graph.nodes.find((n) => n.kind === 'turn');
    const detail = await mcp.call('get_detail', { runId: FOREIGN_RUN_ID, nodeId: turn.id });
    expect(detail.isError).toBe(false);
    expect(detail.payload.detail.kind).toBe('turn');
  }, 20000);

  it('focus_nodes lands on the owning server and returns its deep link', async () => {
    const graph = (await mcp.call('get_graph', { runId: FOREIGN_RUN_ID })).payload;
    const { isError, payload } = await mcp.call('focus_nodes', {
      runId: FOREIGN_RUN_ID,
      nodeIds: [graph.nodes[0].id],
      label: 'x',
      reason: 'y',
      open: false,
    });
    expect(isError).toBe(false);
    expect(payload.url).toContain(`:${bundled.port}/`);
    expect(payload.url).toContain('#run=');
  }, 20000);

  it('a run served by no one still errors helpfully', async () => {
    const { isError, payload } = await mcp.call('get_graph', { runId: 'claude-code:gone:gone' });
    expect(isError).toBe(true);
    expect(String(payload)).toContain('list_runs');
  }, 20000);

  // Spec §4: the same runId on two live servers routes to the most recently
  // started (identical reconstructions of the same files), and list_runs
  // lists it once.
  it('a runId served by two servers routes to the newest, deduped in list_runs', async () => {
    const { buildBundle } = await import('../src/bundle.js');
    const { envelope } = await buildBundle([SESSION_RUN_ID], { sharedBy: 'Bilal' });
    const { gzipSync } = await import('node:zlib');
    const dupePath = join(tmp, 'dupe.rungraph');
    await writeFile(dupePath, gzipSync(JSON.stringify(envelope)));
    // Serves SESSION_RUN_ID — which the local server (10:00) also serves.
    const dupe = await startServer({ preferredPort: 4730, bundles: [dupePath] });
    await registerServer(dupe.port, ['bundle:dupe.rungraph'], '2026-08-15T12:00:00.000Z');
    try {
      const { payload } = await mcp.call('list_runs');
      expect(payload.runs.filter((r) => r.runId === SESSION_RUN_ID)).toHaveLength(1);
      const focus = await mcp.call('focus_nodes', {
        runId: SESSION_RUN_ID,
        nodeIds: ['a:toolu_fxA001'],
        label: 'x',
        reason: 'y',
        open: false,
      });
      expect(focus.isError).toBe(false);
      expect(focus.payload.url).toContain(`:${dupe.port}/`); // newest owner wins
    } finally {
      await rm(join(portDir, `${dupe.port}.json`), { force: true });
      await dupe.close();
    }
  }, 20000);
});

describe('rungraph mcp --check', () => {
  // The question the tool could not previously answer about itself. The
  // registration and dashboard checks depend on the machine, so this asserts
  // the shape and the one check that is entirely ours: that the MCP server
  // starts, speaks JSON-RPC over real stdio, and lists its tools.
  it('reports every check, and proves the server answers over stdio', async () => {
    const r = await exec('node', [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
    const report = JSON.parse(r.stdout);
    expect(report.checks.map((c) => c.name)).toEqual([
      'runs on disk',
      'mcp server',
      'registered with claude',
      'dashboard server',
    ]);
    const server = report.checks.find((c) => c.name === 'mcp server');
    expect(server.ok).toBe(true);
    expect(server.detail).toContain('7 tools');
    expect(report.checks.find((c) => c.name === 'runs on disk')).toMatchObject({ ok: true });
    // every failing check hands back the one next step that fixes it
    for (const c of report.checks) if (!c.ok) expect(c.fix.length).toBeGreaterThan(10);
  }, 90000);
});

describe('rungraph mcp --install', () => {
  // The success path shells out to `claude mcp add`, which would edit the
  // developer's real MCP config — so only the guarded path is exercised here.
  it('rejects an invalid scope without touching anything', async () => {
    const err = await exec('node', [BIN, 'mcp', '--install', '--scope', 'nonsense'], { env }).catch(
      (e) => e,
    );
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('invalid --scope');
  });
});
