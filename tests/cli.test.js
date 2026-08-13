import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');
const env = { ...process.env, RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT };

const run = async (...args) => {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
};

beforeAll(() => pinFixtureMtimes());

describe('golden CLI (agent contract)', () => {
  it('list --json: data on stdout, exit 0', async () => {
    const r = await run('list', '--json');
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.runs).toHaveLength(FIXTURE_RUN_COUNT);
    for (const e of data.runs) {
      expect(e).toHaveProperty('runId');
      expect(e).toHaveProperty('kind');
      expect(e).toHaveProperty('title');
      expect(e).toHaveProperty('active');
    }
  });

  it('graph <runId> --json: full IR on stdout, exit 0', async () => {
    const r = await run('graph', SESSION_RUN_ID, '--json');
    expect(r.code).toBe(0);
    const ir = JSON.parse(r.stdout);
    expect(ir.irVersion).toBe(1);
    expect(ir.meta.runId).toBe(SESSION_RUN_ID);
    expect(ir.nodes.length).toBeGreaterThan(5);
  });

  // The three deriveSignals call sites (cli, server, watcher) are easy to add a
  // fourth producer to and forget. If an agent reading --json and a human
  // reading the dashboard disagree about what is wrong, neither can be trusted,
  // so a missed call site has to fail CI rather than go unnoticed.
  it('graph --json carries derived signals', async () => {
    const r = await run('graph', TROUBLE_RUN_ID, '--json');
    const ir = JSON.parse(r.stdout);
    expect(Array.isArray(ir.signals)).toBe(true);
    expect(ir.signals.map((s) => s.kind)).toContain('retry-storm');
    for (const s of ir.signals) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('severity');
      expect(s.nodeIds.length).toBeGreaterThan(0);
    }
  });

  it('graph --json carries file attribution', async () => {
    const ir = JSON.parse((await run('graph', TROUBLE_RUN_ID, '--json')).stdout);
    expect(ir.nodes.some((n) => n.files?.some((f) => f.endsWith('token.js')))).toBe(true);
  });

  it('a clean run reports an empty signals array, not a missing one', async () => {
    const ir = JSON.parse((await run('graph', CLEAN_RUN_ID, '--json')).stdout);
    expect(ir.signals).toEqual([]);
  });

  it('find <runId> <query> --json narrows without pulling the whole graph', async () => {
    const r = await run('find', TROUBLE_RUN_ID, 'token.js', '--json');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.matched).toBeGreaterThan(0);
    expect(out.nodeIds).toHaveLength(out.nodes.length);
    const full = JSON.parse((await run('graph', TROUBLE_RUN_ID, '--json')).stdout);
    expect(out.nodes.length).toBeLessThan(full.nodes.length);
  });

  it('find with no matches: exit 2, note on stderr', async () => {
    const r = await run('find', TROUBLE_RUN_ID, 'nothing-matches-this', '--json');
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).nodeIds).toEqual([]);
    expect(r.stderr).toContain('nothing matched');
  });

  it('graph with unknown id: exit 2, error on stderr, empty stdout', async () => {
    const r = await run('graph', 'claude-code:nope:nope', '--json');
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no run found');
  });

  it('list --project with no matches: exit 2', async () => {
    const r = await run('list', '--json', '--project', '/definitely/not/a/project');
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).runs).toHaveLength(0);
  });

  it('--help documents every command for agent self-serve', async () => {
    const r = await run('--help');
    expect(r.code).toBe(0);
    for (const s of ['FOR AGENTS', 'list --json', 'graph <runId>', 'serve', 'mcp', 'EXIT CODES']) {
      expect(r.stdout).toContain(s);
    }
  });

  it('unknown command: exit 1', async () => {
    const r = await run('frobnicate');
    expect(r.code).toBe(1);
  });
});
