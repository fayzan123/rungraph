import { beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile, appendFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { pinFixtureMtimes, FIXTURE_ROOT } from './helpers.js';

/** Copy the fixture tree somewhere mutable so tests can break it. */
async function mutableFixtures() {
  const root = await mkdtemp(join(tmpdir(), 'rg-fix-'));
  await cp(FIXTURE_ROOT, root, { recursive: true });
  await pinTree(root);
  return root;
}

async function pinTree(dir, when = new Date('2026-08-01T13:00:00Z')) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await pinTree(p, when);
    await utimes(p, when, when);
  }
  await utimes(dir, when, when);
}

beforeAll(() => pinFixtureMtimes());

const PROJ = '-home-dev-acme';
const S1 = '11111111-1111-4111-8111-111111111111';

describe('never blank-screen', () => {
  it('tolerates a truncated FINAL line without counting it as format drift', async () => {
    const root = await mutableFixtures();
    const file = join(root, PROJ, `${S1}.jsonl`);
    await appendFile(file, '{"type":"assistant","uuid":"tru'); // mid-write
    await pinTree(root);
    const refs = await detect([root]);
    const { ir } = await parse(refs.find((r) => r.kind === 'session' && r.sessionId === S1));
    expect(ir.meta.unrecognizedLineCount).toBe(2); // holo-recap + the populated atis-latch
    // Coverage inherits the same rule, so a live session does not flicker: the
    // truncated final line is a record EXAMINED (it counts in `records`) but
    // not one that failed (it stays out of `unrecognized`).
    expect(ir.meta.coverage.records).toBe(50);
    expect(ir.meta.coverage.unrecognized).toBe(2);
    await rm(root, { recursive: true, force: true });
  });

  it('counts a truncated MID-FILE line as unrecognized', async () => {
    const root = await mutableFixtures();
    const file = join(root, PROJ, `${S1}.jsonl`);
    await appendFile(file, '{"type":"garbage-not-clo\n{"type":"mode","mode":"normal","sessionId":"' + S1 + '"}\n');
    await pinTree(root);
    const refs = await detect([root]);
    const { ir } = await parse(refs.find((r) => r.kind === 'session' && r.sessionId === S1));
    expect(ir.meta.unrecognizedLineCount).toBe(3); // holo-recap + atis-latch + the bad mid-file line
    expect(ir.meta.coverage.unrecognized).toBe(3);
    await rm(root, { recursive: true, force: true });
  });

  it('renders a placeholder for a referenced-but-missing agent transcript', async () => {
    const root = await mutableFixtures();
    await rm(join(root, PROJ, S1, 'subagents', 'agent-a123456789abcdef0.jsonl'));
    await pinTree(root);
    const refs = await detect([root]);
    const { ir, details } = await parse(
      refs.find((r) => r.kind === 'session' && r.sessionId === S1),
      { collectDetails: true },
    );
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    expect(agent).toBeDefined();
    expect(agent.ext.transcriptMissing).toBe(true);
    expect(agent.status).toBe('completed'); // notification said completed
    expect(details.get(agent.id).transcript).toEqual([]);
    // The most complete blindness available: a whole subagent nobody could
    // open. It contributes to neither record counter, so without sourcesUnread
    // this run would score 100% read.
    expect(ir.meta.coverage.sourcesUnread).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it('tolerates valid-JSON non-object lines in a workflow journal', async () => {
    const root = await mutableFixtures();
    const journal = join(root, PROJ, S1, 'subagents', 'workflows', 'wf_12345678-abc', 'journal.jsonl');
    const orig = [
      { type: 'started', key: 'v2:' + 'a'.repeat(64), agentId: 'aaaa000000000001f' },
      { type: 'result', key: 'v2:' + 'a'.repeat(64), agentId: 'aaaa000000000001f', result: { ok: true } },
    ];
    await writeFile(journal, 'null\n42\n' + orig.map((x) => JSON.stringify(x)).join('\n') + '\n');
    await pinTree(root);
    const refs = await detect([root]);
    const wf = refs.find((r) => r.kind === 'workflow');
    const { ir } = await parse(wf);
    expect(ir.meta.unrecognizedLineCount).toBe(2); // null and 42, counted not fatal
    expect(ir.meta.coverage.unrecognized).toBe(2);
    expect(ir.nodes.some((n) => n.kind === 'agent' && n.status === 'completed')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('id stability: agent/workflow node ids derive from the spawn tool_use', async () => {
    const refs = await detect([FIXTURE_ROOT]);
    const { ir } = await parse(refs.find((r) => r.kind === 'session' && r.sessionId === S1));
    expect(ir.nodes.find((n) => n.kind === 'agent').id).toBe('a:toolu_fxA001');
    expect(ir.nodes.find((n) => n.kind === 'workflow').id).toBe('w:toolu_fxW001');
  });
});
