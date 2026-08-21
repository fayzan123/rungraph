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
  SECRETS_RUN_ID,
  DRIFT_QUIET_RUN_ID,
  DRIFT_LOUD_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';
import { scanText } from '../src/secrets.js';

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
const env = { ...process.env, RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT, RUNGRAPH_CODEX_SESSIONS: CODEX_FIXTURE_ROOT, RUNGRAPH_HERMES_HOME: '', RUNGRAPH_OPENCODE_HOME: '' };

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
  // Same reason, for the OTHER persistent thing an mcp process writes: every
  // `initialize` in this file records a breadcrumb, and the default state dir
  // is the developer's own ~/.rungraph — where a stray write would silence
  // the `serve` nudge on their real machine.
  env.RUNGRAPH_STATE_DIR = join(tmp, 'state');
  // Fail-safe for the `--install` case below: it is expected to reject its
  // flag before spawning anything, and if it ever stops doing so it must not
  // reach the developer's real agent configs. XDG_CONFIG_HOME is the one that
  // protects opencode; OPENCODE_CONFIG is its read path only.
  env.CLAUDE_CONFIG_DIR = join(tmp, 'vendor');
  env.CODEX_HOME = join(tmp, 'vendor');
  env.HERMES_HOME = join(tmp, 'vendor');
  env.XDG_CONFIG_HOME = join(tmp, 'vendor');
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

  it('ships the proactive-loop instructions in the initialize result', async () => {
    // Hosts that lazy-load tool schemas surface only this field up front, so it
    // must carry the "answer, then focus_nodes" contract itself.
    const res = await mcp.send('initialize', { protocolVersion: '2025-03-26' });
    expect(res.result.instructions).toContain('focus_nodes');
    expect(res.result.instructions).toContain('after answering');
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

  // Spec §9: the agent end of the loop must be told what it could not see. A
  // run rungraph only partly read looks exactly like a run where nothing went
  // wrong, and the field alone is not enough — models act on an instruction far
  // more reliably than on a number they were never told to care about.
  describe('coverage', () => {
    it('rides all three read tools', async () => {
      const graph = (await mcp.call('get_graph', { runId: DRIFT_QUIET_RUN_ID })).payload;
      expect(graph.coverage).toEqual({ records: 23, unrecognized: 1, sourcesUnread: 0 });
      const full = (await mcp.call('get_graph', { runId: DRIFT_QUIET_RUN_ID, detail: 'full' })).payload;
      expect(full.coverage).toEqual(graph.coverage);
      const found = (await mcp.call('find_nodes', { runId: DRIFT_QUIET_RUN_ID, query: 'Edit' })).payload;
      expect(found.coverage).toEqual(graph.coverage);
      const node = graph.nodes.find((n) => n.kind === 'tool');
      const detail = (await mcp.call('get_detail', { runId: DRIFT_QUIET_RUN_ID, nodeId: node.id })).payload;
      expect(detail.coverage).toEqual(graph.coverage);
    });

    it('notes quietly on a lightly drifted run, and names what went unread', async () => {
      const { payload } = await mcp.call('get_graph', { runId: DRIFT_QUIET_RUN_ID });
      expect(payload.note).toBe(
        "5% of this run's records could not be parsed (flux-marker ×1). Mention this if you characterize the run as a whole.",
      );
    });

    it('turns imperative when most of a run could not be read', async () => {
      const { payload } = await mcp.call('get_graph', { runId: DRIFT_LOUD_RUN_ID });
      expect(payload.note).toContain('do not call it clean');
      expect(payload.note).toContain('21%');
      // Same phrase family, different force — quiet must not read like loud.
      const quiet = (await mcp.call('get_graph', { runId: DRIFT_QUIET_RUN_ID })).payload.note;
      expect(payload.note).not.toBe(quiet);
    });

    it('says nothing at all about a fully-read run', async () => {
      const { payload } = await mcp.call('get_graph', { runId: CLEAN_RUN_ID });
      expect(payload.coverage.unrecognized).toBe(0);
      expect(payload.note).toBeUndefined();
      // …nor about a drifted run whose chips already say "look here".
      const trouble = (await mcp.call('get_graph', { runId: SESSION_RUN_ID })).payload;
      expect(trouble.note).toBeUndefined();
    });

    it('keeps the truncation note when both have something to say', async () => {
      const { payload } = await mcp.call('find_nodes', {
        runId: DRIFT_QUIET_RUN_ID,
        query: 'e',
        limit: 1,
      });
      expect(payload.truncated).toBe(true);
      expect(payload.note).toContain('matched');
      expect(payload.note).toContain('could not be parsed');
    });
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
    process.env.RUNGRAPH_HERMES_HOME = '';
  process.env.RUNGRAPH_OPENCODE_HOME = '';
    server = await startServer({ preferredPort: 4712 });
    await registerServer(server.port);
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    delete process.env.RUNGRAPH_CODEX_SESSIONS;
    delete process.env.RUNGRAPH_HERMES_HOME;
  delete process.env.RUNGRAPH_OPENCODE_HOME;
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
    process.env.RUNGRAPH_HERMES_HOME = '';
  process.env.RUNGRAPH_OPENCODE_HOME = '';
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
    delete process.env.RUNGRAPH_HERMES_HOME;
  delete process.env.RUNGRAPH_OPENCODE_HOME;
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

describe('secrets never reach the model', () => {
  // The export path blocks this run outright. The MCP path is the OTHER way
  // content leaves the machine — into an API request to a model provider, and
  // into the calling session's own transcript — so it gets the same guard.
  // Redaction happens at the single callTool choke point, which is why these
  // tests cover a tool that returns payloads AND one that returns only labels.

  it('get_detail redacts the env dump instead of handing it over', async () => {
    const { nodes } = (await mcp.call('find_nodes', { runId: SECRETS_RUN_ID, query: 'Find what else' })).payload;
    const { raw } = await mcp.call('get_detail', { runId: SECRETS_RUN_ID, nodeId: nodes[0].id });
    const text = raw.result.content[0].text;
    expect(text).toContain('[REDACTED:slack-token]');
    expect(text).toContain('[REDACTED:anthropic-key]');
    expect(scanText(text)).toEqual([]); // fails closed, exactly as export does
  });

  it('find_nodes redacts node labels — reachable without get_detail', async () => {
    // The prompt label carries an AWS key and a GitHub token at snippet()'s
    // 80-char cap, and a description-less Bash label carries the AWS key at 40.
    // A get_detail-only fix would leave both of these on the wire.
    const { raw } = await mcp.call('find_nodes', { runId: SECRETS_RUN_ID, query: 'AKIA' });
    const text = raw.result.content[0].text;
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(scanText(text)).toEqual([]);
  });

  it('says it redacted, so a redacted run is not read as a clean one', async () => {
    const { nodes } = (await mcp.call('find_nodes', { runId: SECRETS_RUN_ID, query: 'Find what else' })).payload;
    const { payload } = await mcp.call('get_detail', { runId: SECRETS_RUN_ID, nodeId: nodes[0].id });
    expect(payload.note).toMatch(/redact/i);
  });

  it('leaves a run with no secrets byte-for-byte untouched', async () => {
    // Precision over recall: the guard must be invisible on the clean run, or
    // it is one more marker nobody trusts.
    const { raw } = await mcp.call('get_graph', { runId: CLEAN_RUN_ID });
    expect(raw.result.content[0].text).not.toContain('[REDACTED:');
    expect((await mcp.call('get_graph', { runId: CLEAN_RUN_ID })).payload.note ?? '').not.toMatch(/redact/i);
  });
});

describe('rungraph mcp --check', () => {
  // The question the tool could not previously answer about itself. The
  // registration and dashboard rows depend on the machine, so this asserts
  // the shape and the one check that is entirely ours: that the MCP server
  // starts, speaks JSON-RPC over real stdio, and lists its tools.
  //
  // The per-provider rows themselves — including "two detected, one
  // registered" against PATH shims, and the four vendor integration cases —
  // live in tests/clients.test.js, where they can be driven deterministically.
  it('reports every check, and proves the server answers over stdio', async () => {
    const r = await exec('node', [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
    const report = JSON.parse(r.stdout);
    const names = report.checks.map((c) => c.name);
    // The first two and the last are fixed; between them sits one row per
    // DETECTED provider, which is the whole point of §3 — the single check
    // literally named `registered with claude` was a false negative for
    // anyone who had wired rungraph into a different agent correctly.
    expect(names[0]).toBe('runs on disk');
    expect(names[1]).toBe('mcp server');
    expect(names.at(-1)).toBe('dashboard server');
    expect(names).not.toContain('registered with claude');
    // The fixture corpus is claude + codex, so exactly those two rows.
    expect(names.slice(2, -1)).toEqual(['registered · claude', 'registered · codex']);

    const server = report.checks.find((c) => c.name === 'mcp server');
    expect(server.ok).toBe(true);
    expect(server.detail).toContain('7 tools');
    expect(report.checks.find((c) => c.name === 'runs on disk')).toMatchObject({ ok: true });

    for (const c of report.checks) {
      // Every per-provider row carries its client and is advisory: the loop is
      // usable as soon as ONE provider is wired up, so a stale second agent
      // must never be able to fail a working machine.
      if (c.name.startsWith('registered ·')) {
        expect(c.client).toBeTruthy();
        expect(c.advisory).toBe(true);
        expect(['ok', 'absent', 'broken']).toContain(c.state);
      }
      // A failing row hands back its one next step — unless there is none
      // worth printing, which is the "detected but the CLI is gone" case.
      if (!c.ok && c.fix !== undefined) expect(c.fix.length).toBeGreaterThan(10);
    }
    // 120s, not 90: the check now spawns one vendor CLI per detected provider
    // (in parallel), and `claude mcp list` health-checks every server it finds.
  }, 120000);
});

describe('rungraph mcp --install', () => {
  // Usage guards only. The install paths themselves are exercised against
  // throwaway config homes in tests/clients.test.js — every one of the four
  // vendors turned out to be integration-testable, which is what retired the
  // old "this would edit the developer's real config" excuse.
  it('rejects an invalid scope without touching anything', async () => {
    // Still a PRE-FLIGHT check, and it has to stay one: a bare `--install` now
    // means "install into every detected provider", so a scope check that ran
    // after selection would spawn vendor CLIs before rejecting the flag.
    const err = await exec('node', [BIN, 'mcp', '--install', '--scope', 'nonsense'], { env }).catch(
      (e) => e,
    );
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('invalid --scope');
    expect(err.stdout).toBe('');
  });
});
