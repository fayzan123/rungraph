import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildBundle,
  decodeBundle,
  scanEnvelope,
  structureOnly,
  isSensitivePath,
  BUNDLE_VERSION,
} from '../src/bundle.js';
import { SECRET_PATTERNS, scanText } from '../src/secrets.js';
import { startServer } from '../src/server.js';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { attachSignals } from '../src/signals.js';
import { matchNodes } from '../src/find.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  EMPTY_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
  SECRETS_RUN_ID,
} from './helpers.js';

let tmp;
beforeAll(async () => {
  await pinFixtureMtimes();
  process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
  process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
  process.env.RUNGRAPH_HERMES_HOME = '';
  tmp = await mkdtemp(join(tmpdir(), 'rg-bundle-'));
  // Redirect registry discovery so locate tests can never probe (or delete
  // the entry of) a rungraph the developer happens to be running.
  process.env.RUNGRAPH_PORT_DIR = join(tmp, 'servers');
});
afterAll(async () => {
  delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
  delete process.env.RUNGRAPH_CODEX_SESSIONS;
  delete process.env.RUNGRAPH_HERMES_HOME;
  delete process.env.RUNGRAPH_PORT_DIR;
  await rm(tmp, { recursive: true, force: true });
});

const parseFresh = async (runId, opts) => {
  const refs = await detect([process.env.RUNGRAPH_CLAUDE_PROJECTS]);
  return parse(refs.find((r) => r.runId === runId), opts);
};

describe('buildBundle', () => {
  it('embeds the full IR and eager detail payloads, without signals', async () => {
    const { blocked, envelope } = await buildBundle([CLEAN_RUN_ID], { now: '2026-08-15T12:00:00Z' });
    expect(blocked).toBe(false);
    const run = envelope.runs.find((r) => r.runId === CLEAN_RUN_ID);
    const { ir, details } = await parseFresh(CLEAN_RUN_ID, { collectDetails: true });
    expect(run.ir).toEqual(ir);
    // Signals are NOT stored — the viewer derives them at view time.
    expect(run.ir.signals).toBeUndefined();
    // Detail payloads are embedded eagerly: a bundle has no transcript files.
    expect(Object.keys(run.details).sort()).toEqual([...details.keys()].sort());
    expect(envelope.bundleVersion).toBe(BUNDLE_VERSION);
    expect(envelope.irVersion).toBe(1);
  });

  it('includes workflow runs referenced by runRef transitively, once', async () => {
    const { envelope } = await buildBundle([SESSION_RUN_ID]);
    const ids = envelope.runs.map((r) => r.runId);
    expect(ids).toContain(SESSION_RUN_ID);
    expect(ids.filter((id) => id === WORKFLOW_RUN_ID)).toHaveLength(1);
  });

  it('the clean corpus exports with zero findings — the false-positive guard', async () => {
    const { blocked, findings } = await buildBundle([
      SESSION_RUN_ID,
      EMPTY_RUN_ID,
      CLEAN_RUN_ID,
      TROUBLE_RUN_ID,
    ]);
    expect(findings).toEqual([]);
    expect(blocked).toBe(false);
  });

  it('stamps a snapshot timestamp on a run that looks live at export time', async () => {
    // An isolated copy: touching the shared fixture tree would race the other
    // suites' liveness-sensitive snapshots.
    const liveRoot = join(tmp, 'live-projects');
    await cp(FIXTURE_ROOT, liveRoot, { recursive: true });
    process.env.RUNGRAPH_CLAUDE_PROJECTS = liveRoot;
    try {
      const now = new Date();
      await utimes(join(liveRoot, '-home-dev-acme', `${CLEAN_RUN_ID.split(':').pop()}.jsonl`), now, now);
      const { envelope } = await buildBundle([CLEAN_RUN_ID], { now: '2026-08-15T18:00:00Z' });
      const run = envelope.runs.find((r) => r.runId === CLEAN_RUN_ID);
      expect(run.snapshot).toBe('2026-08-15T18:00:00Z');
      expect(run.ir.meta.endedAt).toBeUndefined();
    } finally {
      process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    }
  });

  it('a settled run carries no snapshot stamp', async () => {
    const { envelope } = await buildBundle([CLEAN_RUN_ID]);
    expect(envelope.runs[0].snapshot).toBeUndefined();
  });

  it('throws on an unknown requested run', async () => {
    await expect(buildBundle(['claude-code:nope:nope'])).rejects.toThrow(/no run found/);
  });
});

describe('the blocking secrets scan', () => {
  it('blocks the secrets fixture with a finding for every pattern kind', async () => {
    const { blocked, findings, buffer } = await buildBundle([SECRETS_RUN_ID]);
    expect(blocked).toBe(true);
    expect(buffer).toBeUndefined(); // blocked means nothing left to write
    const kinds = new Set(findings.map((f) => f.kind));
    for (const p of SECRET_PATTERNS) {
      expect(kinds, `pattern kind ${p.kind}`).toContain(p.kind);
    }
  });

  it('findings carry run, node, and where — the fix is a decision, not a search', async () => {
    const { findings } = await buildBundle([SECRETS_RUN_ID]);
    const wheres = new Set(findings.map((f) => f.where));
    expect(wheres).toContain('your prompt'); // AWS key in the turn prompt
    expect(wheres).toContain('Bash output'); // env dump in a tool result
    expect(wheres).toContain('Edit input'); // key landing in an edit
    expect(wheres).toContain('Read output'); // PEM block read back
    for (const f of findings) {
      expect(f.runId).toBe(SECRETS_RUN_ID);
      expect(f.count).toBeGreaterThan(0);
      expect(f.name.length).toBeGreaterThan(2);
    }
  });

  it('redact-secrets replaces every match and the output re-scans clean', async () => {
    const { blocked, buffer } = await buildBundle([SECRETS_RUN_ID], { redaction: 'redact-secrets' });
    expect(blocked).toBe(false);
    const json = JSON.stringify(decodeBundle(buffer));
    expect(json).toContain('[REDACTED:aws-access-key]');
    expect(json).toContain('[REDACTED:private-key-block]');
    expect(scanText(json)).toEqual([]);
  });

  it('allow-secrets exports verbatim — a deliberate, named act', async () => {
    const { blocked, findings, buffer } = await buildBundle([SECRETS_RUN_ID], { allowSecrets: true });
    expect(blocked).toBe(false);
    expect(findings.length).toBeGreaterThan(0); // still reported, no longer blocking
    expect(JSON.stringify(decodeBundle(buffer))).toContain('AKIA' + 'FAKE'.repeat(4));
  });

  it('the scan runs on whatever actually leaves — file paths included', () => {
    const findings = scanEnvelope({
      runs: [
        {
          runId: 'r1',
          ir: {
            meta: {},
            nodes: [{ id: 'n1', kind: 'tool', label: 'Read', files: [`/tmp/ghp_${'A'.repeat(36)}.txt`] }],
            edges: [],
            groups: [],
          },
        },
      ],
    });
    expect(findings).toMatchObject([{ runId: 'r1', nodeId: 'n1', where: 'file path', kind: 'github-token' }]);
  });

  it('the inventory counts prompts and calls out credential-looking paths', async () => {
    const { inventory } = await buildBundle([SECRETS_RUN_ID], { allowSecrets: true });
    expect(inventory.promptCount).toBe(1);
    expect(inventory.sensitiveFiles).toContain('/home/dev/acme/.env.local');
    expect(inventory.sensitiveFiles).toContain('/home/dev/acme/ops/deploy.key');
    // ordinary source paths are NOT called out — a noisy inventory is skimmed
    expect(isSensitivePath('/home/dev/acme/src/auth/token.js')).toBe(false);
  });
});

describe('structure-only', () => {
  it('derived and mechanical survives; authored text dies', async () => {
    const { ir } = await parseFresh(SESSION_RUN_ID);
    const g = structureOnly(ir);
    expect(g).toMatchSnapshot();
  });

  it('drops detail payloads entirely and prompts count zero', async () => {
    const { envelope, inventory, blocked } = await buildBundle([SECRETS_RUN_ID], {
      redaction: 'structure-only',
    });
    // The secrets all lived in payloads and authored labels — stripped, so
    // structure-only is a real resolution for a blocked export.
    expect(blocked).toBe(false);
    for (const run of envelope.runs) {
      expect(run.details).toBeUndefined();
      for (const n of run.ir.nodes) expect(n.hasDetail).toBeUndefined();
      for (const e of run.ir.edges) {
        expect(e.label).toBeUndefined();
        expect(e.reason).toBeUndefined();
      }
    }
    expect(inventory.promptCount).toBe(0);
  });

  it('the scan runs on structure-only output too, through buildBundle', async () => {
    // A token living in a MECHANICAL field — a file path — survives the strip
    // and must still block. Discriminates "buildBundle skips the scan at this
    // tier" from "nothing scannable was left".
    const { mkdir, writeFile } = await import('node:fs/promises');
    const scanRoot = join(tmp, 'scan-root');
    const proj = join(scanRoot, '-tmp-proj');
    await mkdir(proj, { recursive: true });
    const tokenPath = `/tmp/ghp_${'A'.repeat(36)}/config.js`;
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'touch the file' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-08-01T10:00:01.000Z', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Edit', input: { file_path: tokenPath, old_string: 'a', new_string: 'b' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'user', uuid: 'u2', timestamp: '2026-08-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', content: 'ok' }] }, toolUseResult: {} },
    ];
    await writeFile(
      join(proj, '66666666-6666-4666-8666-666666666666.jsonl'),
      lines.map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    process.env.RUNGRAPH_CLAUDE_PROJECTS = scanRoot;
    try {
      const { blocked, findings } = await buildBundle(
        ['claude-code:-tmp-proj:66666666-6666-4666-8666-666666666666'],
        { redaction: 'structure-only' },
      );
      expect(blocked).toBe(true);
      expect(findings).toMatchObject([{ kind: 'github-token', where: 'file path' }]);
    } finally {
      process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    }
  });

  it('matchNodes still hits file paths and tool labels in the stripped IR', async () => {
    const { ir } = await parseFresh(TROUBLE_RUN_ID);
    const g = structureOnly(ir);
    expect(matchNodes(g, 'token.js').length).toBeGreaterThan(0);
    expect(matchNodes(g, 'Edit').length).toBeGreaterThan(0);
    // authored prompt text is gone
    expect(matchNodes(g, 'refresh API')).toEqual([]);
  });
});

describe('decodeBundle degradation', () => {
  it('names each failure instead of blank-screening', () => {
    expect(() => decodeBundle(Buffer.from('not gzip at all'))).toThrow(/not a \.rungraph bundle/);
    expect(() => decodeBundle(gzipSync('{"truncated'))).toThrow(/corrupt/);
    expect(() => decodeBundle(gzipSync('"a string"'))).toThrow(/no bundleVersion/);
    expect(() =>
      decodeBundle(gzipSync(JSON.stringify({ bundleVersion: BUNDLE_VERSION + 1, runs: [] }))),
    ).toThrow(/newer than this rungraph.*upgrade/);
    expect(() =>
      decodeBundle(gzipSync(JSON.stringify({ bundleVersion: 1, irVersion: 99, runs: [] }))),
    ).toThrow(/irVersion 99.*upgrade/);
    expect(() => decodeBundle(gzipSync(JSON.stringify({ bundleVersion: 1 })))).toThrow(/no runs/);
  });
});

describe('rungraph open — a server over bundles', () => {
  let server;
  let bundlePath;
  beforeAll(async () => {
    const { buffer } = await buildBundle([SESSION_RUN_ID], {
      sharedBy: 'Bilal',
      now: '2026-08-15T18:02:11Z',
    });
    bundlePath = join(tmp, 'team-work.rungraph');
    await writeFile(bundlePath, buffer);
    server = await startServer({ preferredPort: 4650, bundles: [bundlePath] });
  });
  afterAll(() => server.close());

  const get = async (path) => {
    const res = await fetch(server.url + path);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it('serves the bundle runs with provenance on index entries, never in the IR', async () => {
    const { status, body } = await get('/api/index');
    expect(status).toBe(200);
    const entry = body.runs.find((r) => r.runId === SESSION_RUN_ID);
    expect(entry.provenance).toMatchObject({
      sharedBy: 'Bilal',
      bundle: 'team-work.rungraph',
      exportedAt: '2026-08-15T18:02:11Z',
    });
    expect(entry.active).toBe(false);
    const graph = (await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`)).body;
    expect(JSON.stringify(graph)).not.toContain('sharedBy');
  });

  it('round-trips: served IR identical to the source, plus view-time signals', async () => {
    const { body } = await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`);
    const { ir } = await parseFresh(SESSION_RUN_ID, { collectDetails: true });
    attachSignals(ir);
    // The signal-call-site guard, extended to the open path: a bundle server
    // that skipped attachSignals would be exactly the agent/dashboard
    // disagreement the one-implementation rule exists to prevent.
    expect(body.signals.length).toBeGreaterThan(0);
    expect(body).toEqual(JSON.parse(JSON.stringify(ir)));
  });

  it('drills into the transitively-included workflow run', async () => {
    const { status, body } = await get(`/api/graph/${encodeURIComponent(WORKFLOW_RUN_ID)}`);
    expect(status).toBe(200);
    expect(body.meta.kind).toBe('workflow');
  });

  it('serves detail payloads from the embedded map', async () => {
    const graph = (await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`)).body;
    const node = graph.nodes.find((n) => n.hasDetail);
    const { status, body } = await get(
      `/api/detail/${encodeURIComponent(node.id)}?run=${encodeURIComponent(SESSION_RUN_ID)}`,
    );
    expect(status).toBe(200);
    expect(body.kind).toBe(node.kind);
  });

  it('the focus loop still works on bundle runs', async () => {
    const res = await fetch(server.url + '/api/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: SESSION_RUN_ID, nodeIds: ['t:x'], label: 'x', reason: 'y' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('refuses re-export: send the original file instead', async () => {
    const { status, body } = await get(`/api/export?runs=${encodeURIComponent(SESSION_RUN_ID)}`);
    expect(status).toBe(409);
    expect(body.error).toContain('send the original');
  });

  // The affordance-precision analog of the clean-run test: bundles are other
  // machines' transcripts, so a resume button on them would be a lie.
  it('bundle index entries carry no resume block', async () => {
    const { body } = await get('/api/index');
    expect(body.runs.length).toBeGreaterThan(0);
    for (const r of body.runs) expect(r).not.toHaveProperty('resume');
  });

  it('refuses to resume in bundle mode: nothing here to resume', async () => {
    const res = await fetch(server.url + '/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: SESSION_RUN_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('bundle');
  });

  it('a corrupt bundle degrades to a named banner; other bundles still serve', async () => {
    const badPath = join(tmp, 'mangled.rungraph');
    await writeFile(badPath, 'this is not gzip');
    const both = await startServer({ preferredPort: 4655, bundles: [badPath, bundlePath] });
    try {
      const res = await fetch(both.url + '/api/index');
      const body = await res.json();
      expect(body.errors).toMatchObject([{ file: 'mangled.rungraph' }]);
      expect(body.errors[0].error).toContain('not a .rungraph bundle');
      expect(body.runs.some((r) => r.runId === SESSION_RUN_ID)).toBe(true);
      expect(both.bundleErrors).toHaveLength(1);
    } finally {
      await both.close();
    }
  });
});

describe('GET /api/export — one implementation, two frontends', () => {
  let server;
  beforeAll(async () => {
    server = await startServer({ preferredPort: 4660 });
  });
  afterAll(() => server.close());

  it('produces a bundle IR-equal to the CLI path for the same runs', async () => {
    const res = await fetch(
      `${server.url}/api/export?runs=${encodeURIComponent(CLEAN_RUN_ID)}&as=Bilal`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/\.rungraph"/);
    const served = decodeBundle(Buffer.from(await res.arrayBuffer()));
    const { envelope } = await buildBundle([CLEAN_RUN_ID], { sharedBy: 'Bilal' });
    expect(served.runs).toEqual(JSON.parse(JSON.stringify(envelope.runs)));
    expect(served.sharedBy).toBe('Bilal');
  });

  it('dry=1 returns the inventory and findings for the consent dialog', async () => {
    const res = await fetch(
      `${server.url}/api/export?runs=${encodeURIComponent(SECRETS_RUN_ID)}&dry=1`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.inventory.runCount).toBe(1);
  });

  it('a scan hit returns the findings instead of the file', async () => {
    const res = await fetch(`${server.url}/api/export?runs=${encodeURIComponent(SECRETS_RUN_ID)}`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(body.findings.length).toBeGreaterThan(0);
  });

  it('honors the same resolutions as the CLI', async () => {
    const redacted = await fetch(
      `${server.url}/api/export?runs=${encodeURIComponent(SECRETS_RUN_ID)}&redaction=redact-secrets`,
    );
    expect(redacted.status).toBe(200);
    const allowed = await fetch(
      `${server.url}/api/export?runs=${encodeURIComponent(SECRETS_RUN_ID)}&allow=1`,
    );
    expect(allowed.status).toBe(200);
  });

  it('rejects a missing runs param', async () => {
    expect((await fetch(`${server.url}/api/export`)).status).toBe(400);
  });
});

describe('GET /api/locate — the deep-link jump', () => {
  it('finds the owning server through the registry', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(process.env.RUNGRAPH_PORT_DIR, { recursive: true });
    const local = await startServer({ preferredPort: 4670 });
    const { buffer } = await buildBundle([SESSION_RUN_ID]);
    const bPath = join(tmp, 'locate.rungraph');
    await writeFile(bPath, buffer);
    const bundled = await startServer({ preferredPort: 4671, bundles: [bPath] });
    const register = (port, startedAt) =>
      writeFile(
        join(process.env.RUNGRAPH_PORT_DIR, `${port}.json`),
        JSON.stringify({ port, pid: process.pid, startedAt, sources: ['test'] }),
      );
    await register(local.port, '2026-08-15T10:00:00Z');
    await register(bundled.port, '2026-08-15T11:00:00Z');
    try {
      // The bundle server does not have the CLEAN run — its own registry
      // lookup finds the local server that does.
      const hit = await (
        await fetch(`${bundled.url}/api/locate/${encodeURIComponent(CLEAN_RUN_ID)}`)
      ).json();
      expect(hit).toMatchObject({ found: true, url: local.url, self: false });
      // A run it does serve answers self.
      const self = await (
        await fetch(`${bundled.url}/api/locate/${encodeURIComponent(SESSION_RUN_ID)}`)
      ).json();
      expect(self).toMatchObject({ found: true, url: bundled.url, self: true });
      // Unknown everywhere → empty answer, banner path.
      const miss = await (await fetch(`${bundled.url}/api/locate/claude-code:nope`)).json();
      expect(miss).toEqual({ found: false });
    } finally {
      await local.close();
      await bundled.close();
      await rm(join(process.env.RUNGRAPH_PORT_DIR, `${local.port}.json`), { force: true });
      await rm(join(process.env.RUNGRAPH_PORT_DIR, `${bundled.port}.json`), { force: true });
    }
  }, 20000);
});
