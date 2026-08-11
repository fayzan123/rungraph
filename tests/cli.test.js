import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinFixtureMtimes, FIXTURE_ROOT, SESSION_RUN_ID } from './helpers.js';

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
    expect(data.runs).toHaveLength(3);
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
    for (const s of ['FOR AGENTS', 'list --json', 'graph <runId>', 'serve', 'EXIT CODES']) {
      expect(r.stdout).toContain(s);
    }
  });

  it('unknown command: exit 1', async () => {
    const r = await run('frobnicate');
    expect(r.code).toBe(1);
  });
});
