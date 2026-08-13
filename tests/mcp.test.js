import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
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
let portFile;
let tmp;
const env = { ...process.env, RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT };

beforeAll(async () => {
  await pinFixtureMtimes();
  tmp = await mkdtemp(join(tmpdir(), 'rg-mcp-'));
  // Point port discovery at a scratch file so the suite can never find — or
  // stomp on — a rungraph the developer happens to be running.
  portFile = join(tmp, 'server.json');
  env.RUNGRAPH_PORT_FILE = portFile;
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

  it('ignores a stale port file left by a crashed server', async () => {
    await writeFile(portFile, JSON.stringify({ port: 1, pid: 999999, startedAt: 'x' }));
    const { payload } = await mcp.call('get_current_view');
    expect(payload.runs).toEqual([]); // liveness probe failed → treated as no server
    await rm(portFile, { force: true });
  }, 20000);
});

describe('MCP tools (server running)', () => {
  let server;
  beforeAll(async () => {
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    server = await startServer({ preferredPort: 4712 });
    await writeFile(portFile, JSON.stringify({ port: server.port, pid: process.pid }));
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    await rm(portFile, { force: true });
    await server.close();
  });

  // `open: false` matters here: without it this call would open a real browser
  // window on the developer's machine every time the suite runs.
  it('finds the server through the port file and posts a focus', async () => {
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
    expect(payload.url).toContain('?run=');
  }, 20000);

  it('get_current_view talks to the live server', async () => {
    const { payload } = await mcp.call('get_current_view');
    expect(payload.serverUrl).toBe(server.url);
    expect(payload.runs).toEqual([]);
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
