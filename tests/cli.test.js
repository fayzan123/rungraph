import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  SESSION_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
  SECRETS_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');
let tmp;
const env = { ...process.env, RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT, RUNGRAPH_CODEX_SESSIONS: CODEX_FIXTURE_ROOT };

const run = async (...args) => {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
};

beforeAll(async () => {
  await pinFixtureMtimes();
  tmp = await mkdtemp(join(tmpdir(), 'rg-cli-'));
  // Keep registry writes (rungraph open) away from the developer's real one.
  env.RUNGRAPH_PORT_DIR = join(tmp, 'servers');
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

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

  it('--help documents export and open', async () => {
    const r = await run('--help');
    for (const s of ['export <runId…>', 'open <bundle…>', '--structure-only', '--allow-secrets']) {
      expect(r.stdout).toContain(s);
    }
  });
});

describe('rungraph export (agent contract)', () => {
  it('writes a bundle: data on stdout, inventory on stderr, exit 0', async () => {
    const out = join(tmp, 'clean.rungraph');
    const r = await run('export', CLEAN_RUN_ID, '--out', out, '--as', 'Bilal', '--json');
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.written).toBe(out);
    expect(data.runs).toBe(1);
    expect(data.bytes).toBeGreaterThan(0);
    expect(r.stderr).toContain('export inventory');
    expect(r.stderr).toContain('of your prompts included');
    expect((await stat(out)).size).toBe(data.bytes);
  });

  it('--last <n> exports the recent sessions of the project, workflows riding along', async () => {
    const out = join(tmp, 'last.rungraph');
    const r = await run('export', '--last', '1', '--project', '/home/dev/acme', '--out', out, '--json');
    expect(r.code).toBe(0);
    // one session picked, its workflow included transitively via runRef
    expect(JSON.parse(r.stdout).runs).toBe(2);
  });

  it('blocks on secrets: exit 1, findings listed, the three resolutions named, no file', async () => {
    const out = join(tmp, 'blocked.rungraph');
    const r = await run('export', SECRETS_RUN_ID, '--out', out, '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).blocked).toBe(true);
    expect(r.stderr).toContain('export blocked');
    expect(r.stderr).toContain('AWS access key');
    for (const s of ['--redact-secrets', '--structure-only', '--allow-secrets']) {
      expect(r.stderr).toContain(s);
    }
    await expect(stat(out)).rejects.toThrow(); // nothing left the machine
  });

  it('--redact-secrets resolves the block', async () => {
    const out = join(tmp, 'redacted.rungraph');
    const r = await run('export', SECRETS_RUN_ID, '--redact-secrets', '--out', out, '--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('redacted');
    await stat(out);
  });

  it('no run ids and no --last is usage: exit 2', async () => {
    const r = await run('export', '--json');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage');
  });

  it('an unknown run id fails with exit 1', async () => {
    const r = await run('export', 'claude-code:nope:nope', '--json');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no run found');
  });
});

describe('rungraph open (agent contract)', () => {
  it('serves a bundle in the foreground with --json data on stdout', async () => {
    const bundleFile = join(tmp, 'serve-me.rungraph');
    await run('export', SESSION_RUN_ID, '--out', bundleFile);
    const child = spawn('node', [BIN, 'open', bundleFile, '--no-open', '--port', '4685', '--json'], { env });
    try {
      const firstLine = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`no stdout from open. stderr: ${errBuf}`)), 15000);
        let errBuf = '';
        child.stderr.on('data', (d) => (errBuf += d));
        child.stdout.on('data', (d) => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl !== -1) {
            clearTimeout(timer);
            resolve(buf.slice(0, nl));
          }
        });
        child.on('error', reject);
      });
      const data = JSON.parse(firstLine);
      expect(data.runs).toBe(2); // session + its workflow
      // The signal-call-site guard on the open path: the graph an agent or a
      // browser fetches from a bundle server must carry derived signals.
      const graph = await (
        await fetch(`${data.url}/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`)
      ).json();
      expect(Array.isArray(graph.signals)).toBe(true);
      expect(graph.signals.length).toBeGreaterThan(0);
      const index = await (await fetch(`${data.url}/api/index`)).json();
      expect(index.runs[0].provenance.bundle).toBe('serve-me.rungraph');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  }, 30000);

  it('a missing bundle file exits 1 with the failure named', async () => {
    const r = await run('open', join(tmp, 'does-not-exist.rungraph'), '--no-open');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does-not-exist.rungraph');
    expect(r.stderr).toContain('no runs could be loaded');
  });

  it('no bundle argument is usage: exit 2', async () => {
    const r = await run('open');
    expect(r.code).toBe(2);
  });
});
