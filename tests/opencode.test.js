import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detect,
  parse,
  scanWarnings,
  resumeInfo,
  fingerprint,
  watchTargets,
} from '../src/adapters/opencode/index.js';
import { toolLabel, filePathsFromInput } from '../src/adapters/opencode/parse.js';
import { scan, toIndexEntry, ADAPTERS } from '../src/scanner.js';
import { deriveSignals } from '../src/signals.js';
import { classifyCoverage, coveragePercent } from '../src/coverage.js';
import { matchNodes } from '../src/find.js';
import { scanText } from '../src/secrets.js';
import { nodeMarks } from '../frontend/src/focus.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  OPENCODE_FIXTURE_ROOT,
  OC_CLEAN_RUN_ID,
  OC_BATCH_RUN_ID,
  OC_TROUBLE_RUN_ID,
  OC_SUBAGENT_RUN_ID,
  OC_CHILD_ID,
  OC_ORPHAN_CHILD_ID,
  OC_MISSING_CHILD_ID,
  OC_DRIFT_QUIET_RUN_ID,
  OC_DRIFT_LOUD_RUN_ID,
  OC_TRUNCATION_RUN_ID,
  OC_SECRETS_RUN_ID,
  OC_ARCHIVED_RUN_ID,
  OC_REVERTED_RUN_ID,
  OC_INTERRUPTED_RUN_ID,
  OC_FORK_RUN_ID,
  OC_COMPACTION_RUN_ID,
  OC_SHAPE_RUN_ID,
  OC_REVERT_LANE_RUN_ID,
  OC_LANE_CHILD_ID,
  OC_DENY_TASK_RUN_ID,
} from './helpers.js';

// The whole file rides on node:sqlite: the Node 20 CI leg skips it (the
// adapter self-disables there — covered by the graceful-degrade block at the
// bottom, which deliberately is NOT skipped), the Node 22 leg runs it. Probed
// with require, not import — vite-node mangles a literal `import('node:sqlite')`
// (see src/sqlite.js).
const requireBuiltin = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    requireBuiltin('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');
const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters', 'opencode');

beforeAll(() => pinFixtureMtimes());

const refFor = async (runId) => {
  const refs = await detect([OPENCODE_FIXTURE_ROOT]);
  return refs.find((r) => r.runId === runId);
};
const irFor = async (runId, opts) => parse(await refFor(runId), opts);
const signalsFor = async (runId) => deriveSignals((await irFor(runId)).ir);
const kindsOf = (signals) => signals.map((s) => `${s.kind}:${s.label}`);

/** A throwaway opencode-shaped DB; returns { dir, db } (caller rm's dir). */
async function buildDb(schema) {
  const dir = await mkdtemp(join(tmpdir(), 'rg-oc-'));
  const { DatabaseSync } = requireBuiltin('node:sqlite');
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(schema);
  return { dir, db };
}

// ---------------------------------------------------------------------------
// Shared SQLite module — the extraction's own guard.
// ---------------------------------------------------------------------------

describe('shared sqlite module', () => {
  it('both SQLite adapters get the SAME functions, not two copies', async () => {
    const shared = await import('../src/sqlite.js');
    const hermesDb = await import('../src/adapters/hermes/db.js');
    const opencodeDb = await import('../src/adapters/opencode/db.js');
    // Identity, not equivalence: a second copy of the Node ≥22.13 gate or the
    // crash-recovery policy could disagree with the first, which is the exact
    // failure CLAUDE.md's shared-code rule exists to prevent.
    for (const name of ['loadSqlite', 'tableColumns', 'selectList']) {
      expect(hermesDb[name], name).toBe(shared[name]);
      expect(opencodeDb[name], name).toBe(shared[name]);
    }
    // …but the two `iso` helpers must NOT be the same function: Hermes stores
    // epoch SECONDS and opencode epoch MILLISECONDS, and one shared `iso`
    // would be off by a factor of 1000 for whichever adapter lost the coin toss.
    expect(opencodeDb.iso).toBe(shared.isoMillis);
    expect(hermesDb.iso).toBe(shared.isoSeconds);
    expect(opencodeDb.iso(1785585600000)).toBe('2026-08-01T12:00:00.000Z');
    expect(hermesDb.iso(1785585600)).toBe('2026-08-01T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode detect', () => {
  it('indexes every ROOT session, newest first, with no warnings', async () => {
    const refs = await detect([OPENCODE_FIXTURE_ROOT]);
    const index = refs.map(({ runId, kind, title, project, projectFromCwd, agent, version, archived, startedAt, modifiedAt, sizeBytes }) => ({
      runId,
      kind,
      title,
      project,
      projectFromCwd,
      agent,
      version,
      archived,
      startedAt,
      modifiedAt,
      sizeBytes,
    }));
    expect(index).toMatchSnapshot();
    expect(scanWarnings()).toEqual([]);
  });

  it('subagent sessions are NOT independent runs — they live inside their parent', async () => {
    const refs = await detect([OPENCODE_FIXTURE_ROOT]);
    for (const child of [OC_CHILD_ID, OC_ORPHAN_CHILD_ID]) {
      expect(refs.some((r) => r.runId.includes(child)), child).toBe(false);
    }
  });

  it('orders by time_created, NOT by id — opencode ids sort backwards', async () => {
    const refs = await detect([OPENCODE_FIXTURE_ROOT]);
    const times = refs.map((r) => r.modifiedAt);
    expect([...times].sort().reverse()).toEqual(times);
    // …and the id order is genuinely different, so this is a real test.
    const ids = refs.map((r) => r.runId);
    expect([...ids].sort().reverse()).not.toEqual(ids);
  });

  it('project comes from the git worktree, and grouping is path-based', async () => {
    const ref = await refFor(OC_CLEAN_RUN_ID);
    expect(ref.project).toBe('/home/dev/acme');
    expect(ref.projectFromCwd).toBe(true);
    const notes = await refFor(OC_SECRETS_RUN_ID);
    expect(notes.project).toBe('/home/dev/notes');
    // No vendor bucket label: every opencode session has a real path, so the
    // adapter exports no matchesProject hook at all.
    const adapter = ADAPTERS.find((a) => a.name === 'opencode');
    expect(adapter.matchesProject).toBeUndefined();
  });

  it('archived sessions are indexed and flagged, never hidden', async () => {
    const ref = await refFor(OC_ARCHIVED_RUN_ID);
    expect(ref.archived).toBe(true);
    const { ir } = await parse(ref);
    expect(ir.meta.ext.opencode.archived).toBe(true);
    expect(ir.meta.ext.opencode.archivedAtMs).toBe(1787258000000);
    expect(ir.meta.ext.opencode.archivedAt).toBe(new Date(1787258000000).toISOString());
  });

  it('an untitled session takes its title from the first HUMAN prompt', async () => {
    // The compaction run's first user message is a fabricated one carrying a
    // `compaction` part and no text. A naive "first user message" title would
    // read `(empty prompt)` or the raw id.
    const ref = await refFor(OC_COMPACTION_RUN_ID);
    expect(ref.title).toBe('Carry on with the migration');
  });

  it('an unreadable DB degrades to a scan warning, never a crash', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-oc-bad-'));
    try {
      await writeFile(join(tmp, 'opencode.db'), 'this is not a sqlite database at all');
      expect(await detect([tmp])).toEqual([]);
      expect(scanWarnings()).toHaveLength(1);
      expect(scanWarnings()[0].adapter).toBe('opencode');
      const out = await scan({ rootDirs: { opencode: [tmp] } });
      expect(out.warnings).toHaveLength(1);
      expect(out.runs).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('the same session in two data dirs dedupes WITH a warning, never silently', async () => {
    const a = await mkdtemp(join(tmpdir(), 'rg-oc-a-'));
    const b = await mkdtemp(join(tmpdir(), 'rg-oc-b-'));
    try {
      for (const dir of [a, b]) {
        await copyFile(join(OPENCODE_FIXTURE_ROOT, 'opencode.db'), join(dir, 'opencode.db'));
      }
      const refs = await detect([a, b]);
      const warnings = scanWarnings();
      const single = await detect([a]);
      expect(refs).toHaveLength(single.length);
      expect(warnings).toHaveLength(single.length);
      expect(warnings[0].reason).toContain('exists in both');
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('a legacy pre-SQLite store is WARNED about, never parsed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-oc-legacy-'));
    try {
      await mkdir(join(tmp, 'storage', 'session'), { recursive: true });
      expect(await detect([tmp])).toEqual([]);
      expect(scanWarnings()).toHaveLength(1);
      expect(scanWarnings()[0].reason).toContain('launch opencode once');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode parse', () => {
  it('clean-run IR matches the snapshot', async () => {
    expect((await irFor(OC_CLEAN_RUN_ID)).ir).toMatchSnapshot();
  });

  it('trouble-run IR matches the snapshot', async () => {
    expect((await irFor(OC_TROUBLE_RUN_ID)).ir).toMatchSnapshot();
  });

  it('subagent-run IR matches the snapshot', async () => {
    expect((await irFor(OC_SUBAGENT_RUN_ID)).ir).toMatchSnapshot();
  });

  it('parse is deterministic: two parses yield byte-identical IR', async () => {
    const ref = await refFor(OC_SUBAGENT_RUN_ID);
    const a = await parse(ref, { collectDetails: true });
    const b = await parse(ref, { collectDetails: true });
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
  });

  it('holds graph invariants across the whole fixture corpus', async () => {
    for (const ref of await detect([OPENCODE_FIXTURE_ROOT])) {
      const { ir } = await parse(ref);
      const ids = new Set(ir.nodes.map((n) => n.id));
      expect(ids.size, ref.runId).toBe(ir.nodes.length);
      const groupIds = new Set(ir.groups.map((g) => g.id));
      for (const e of ir.edges) {
        expect(ids.has(e.from), `${ref.runId}: edge from ${e.from}`).toBe(true);
        expect(ids.has(e.to), `${ref.runId}: edge to ${e.to}`).toBe(true);
      }
      for (const n of ir.nodes) {
        if (n.group) expect(groupIds.has(n.group), `group ${n.group}`).toBe(true);
      }
      expect(ir.irVersion).toBe(1);
      expect(ir.meta.adapter).toBe('opencode');
    }
  });

  it('every run carries the opencode version that wrote it', async () => {
    for (const ref of await detect([OPENCODE_FIXTURE_ROOT])) {
      const { ir } = await parse(ref);
      expect(ir.meta.ext.opencode.version, ref.runId).toBe('1.18.19');
    }
  });

  // THE token test. A regression here silently reintroduces outlier false
  // positives on ordinary work and would not be obvious from a diff.
  it('a multi-step turn reports MAX context, never SUM and never raw input', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    const turn = ir.nodes.find((n) => n.kind === 'turn');
    // Six steps, true context climbing 8k → 13k while raw input is noise.
    expect(turn.tokens.input).toBe(13000); // MAX(input + cache.read + cache.write)
    expect(turn.tokens.input).not.toBe(63000); // the SUM — 4.85× too big
    expect(turn.tokens.input).not.toBe(8000); // MAX(raw input) — the COLD first step
    expect(turn.tokens.output).toBe(300); // output IS additive
  });

  it('billed figures live in ext and are EXPECTED to disagree with the IR total', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    // `opencode stats` sums; rungraph reports peak context. Both are right,
    // and they must be visibly different numbers rather than one silently
    // overwriting the other.
    expect(ir.meta.ext.opencode.billed).toEqual({
      input: 12900,
      output: 340,
      cacheRead: 50100,
      cacheWrite: 0,
    });
    expect(ir.meta.totals.tokens).toBe(16340);
  });

  it('exact file attribution from patch files and filePath inputs', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    expect(matchNodes(ir, 'CHANGELOG.md').length).toBeGreaterThan(0);
    const edit = ir.nodes.find((n) => n.label.startsWith('edit'));
    expect(edit.files).toEqual(['/home/dev/acme/CHANGELOG.md']);
    // Absent, never [], when a tool touched nothing.
    const bash = ir.nodes.find((n) => n.label.startsWith('bash'));
    expect('files' in bash).toBe(false);
  });

  it('collapses consecutive same-tool calls, and labels from title or input', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    const labels = ir.nodes.filter((n) => n.kind === 'tool').map((n) => n.label);
    expect(labels).toContain('read · CHANGELOG.md'); // state.title as the subject
    expect(labels).toContain('edit · CHANGELOG.md'); // derived from input.filePath
    expect(labels).toContain('bash · Run the suite'); // description over command
  });

  it('serves detail payloads for turns, tools and agents', async () => {
    const { ir, details } = await irFor(OC_TROUBLE_RUN_ID, { collectDetails: true });
    const turn = ir.nodes.find((n) => n.kind === 'turn');
    expect(details.get(turn.id).prompt).toBe('Wire the deploy script into CI');
    const edit = ir.nodes.find((n) => n.label.startsWith('edit'));
    const d = details.get(edit.id);
    expect(d.calls).toHaveLength(3);
    expect(d.calls[0].isError).toBe(true);
    expect(d.calls[0].output).toContain('Could not find oldString');
    // The narration immediately before the group is its "why".
    expect(d.context).toContain('Patching the deploy script');
  });
});

// ---------------------------------------------------------------------------
// Signals — inputs only, no threshold changes.
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode signals', () => {
  // The opencode precision guard, same role as the Claude/Codex/Hermes clean
  // runs. If this ever fires, a threshold or an adapter input has drifted.
  it('the clean run derives ZERO signals and ZERO unread records', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    expect(ir.nodes.length).toBeGreaterThan(3);
    expect(deriveSignals(ir)).toEqual([]);
    expect(ir.meta.coverage).toEqual({
      records: ir.meta.coverage.records,
      unrecognized: 0,
      sourcesUnread: 0,
    });
    expect(ir.meta.coverage.records).toBeGreaterThan(20);
    expect(coveragePercent(ir.meta)).toBe(100);
  });

  it('the trouble run derives one of every reachable high-severity signal', async () => {
    const kinds = kindsOf(await signalsFor(OC_TROUBLE_RUN_ID));
    expect(kinds).toContain('retry-storm:3 failed edit calls');
    expect(kinds).toContain('unresolved-error:unresolved bash error');
    expect(kinds).toContain('intervention:1 denial');
    expect(kinds).toContain('intervention:1 interrupt');
    expect(kinds).toContain('intervention:1 answered question');
    expect(kinds).toContain('outlier:1 outsized step');
  });

  it('denials are human nodes with a tool→human edge, and are excluded from failures', async () => {
    const { ir, details } = await irFor(OC_TROUBLE_RUN_ID, { collectDetails: true });
    const denial = ir.nodes.find((n) => n.interventionKind === 'denial');
    expect(denial.label).toBe('denied glob');
    expect(details.get(denial.id).answer).toBe(
      'The user rejected permission to use this specific tool call.',
    );
    // The edge is not decoration: humanRefused() in signals.js walks exactly
    // this shape to excuse the refused call. Emit the node without it and the
    // exclusion silently never happens.
    const edge = ir.edges.find((e) => e.kind === 'sequence' && e.to === denial.id);
    const tool = ir.nodes.find((n) => n.id === edge.from);
    expect(tool.kind).toBe('tool');
    expect(tool.errorCount).toBe(1);
    expect(tool.status).toBe('error');
    // …and no failure chip is claimed about a call a person refused.
    const kinds = kindsOf(deriveSignals(ir));
    expect(kinds.some((k) => k.includes('unresolved glob'))).toBe(false);
    expect(kinds.some((k) => k.includes('failed glob'))).toBe(false);
  });

  it('an answered question is a human node, never a tool node', async () => {
    const { ir, details } = await irFor(OC_TROUBLE_RUN_ID, { collectDetails: true });
    const answer = ir.nodes.find((n) => n.interventionKind === 'answer');
    expect(answer.label).toBe('answered: GitHub Actions');
    expect(details.get(answer.id).context).toContain('Which CI provider');
    expect(details.get(answer.id).context).toContain('- Buildkite');
    expect(ir.nodes.some((n) => n.kind === 'tool' && n.label.startsWith('question'))).toBe(false);
  });

  // THE node-status invariant, on the shape that made it concrete.
  it('a 14-call batch with 5 errors on DIFFERENT paths is completed, and fires nothing', async () => {
    const { ir } = await irFor(OC_BATCH_RUN_ID);
    const node = ir.nodes.find((n) => n.kind === 'tool');
    expect(node.callCount).toBe(14);
    expect(node.errorCount).toBe(5);
    // `error` only when EVERY collapsed call failed. Under the naive reading
    // this node clears retryErrors: 3 and reports a storm that did not happen.
    expect(node.status).toBe('completed');
    expect(deriveSignals(ir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode interrupts', () => {
  it('MessageAbortedError yields exactly one interrupt node with its tool→human edge', async () => {
    const { ir } = await irFor(OC_INTERRUPTED_RUN_ID);
    const interrupts = ir.nodes.filter((n) => n.interventionKind === 'interrupt');
    expect(interrupts).toHaveLength(1);
    const edge = ir.edges.find((e) => e.kind === 'sequence' && e.to === interrupts[0].id);
    expect(ir.nodes.find((n) => n.id === edge.from).kind).toBe('tool');
    expect(kindsOf(deriveSignals(ir))).toContain('intervention:1 interrupt');
  });

  it('a merely-missing `finish` fires nothing — it also means "still generating"', async () => {
    const { ir } = await irFor(OC_INTERRUPTED_RUN_ID);
    // The run's second turn has a null `finish` and no error. Firing an
    // interrupt chip at a run in progress is exactly the false flag the
    // precision rule forbids, so only MessageAbortedError triggers.
    expect(ir.nodes.filter((n) => n.interventionKind === 'interrupt')).toHaveLength(1);
    const secondTurn = ir.nodes.filter((n) => n.kind === 'turn')[1];
    expect(secondTurn.label).toBe('Just show me the config instead');
    const after = ir.edges.filter((e) => e.from === secondTurn.id).map((e) => e.to);
    expect(after.some((id) => id.includes('interrupt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode revert', () => {
  it('marks every node at or after the boundary, hides nothing, and leaves coverage alone', async () => {
    const { ir } = await irFor(OC_REVERTED_RUN_ID);
    expect(ir.meta.ext.opencode.revert).toEqual({
      messageID: expect.any(String),
      snapshot: '72752f23e1e5fd98ead02b11d98dcc903c7c7095',
    });
    const before = ir.nodes.filter((n) => !n.reverted);
    const after = ir.nodes.filter((n) => n.reverted === true);
    expect(before.map((n) => n.label)).toEqual([
      'Add a health endpoint to the server',
      'read · server.ts',
      'edit · server.ts',
    ]);
    expect(after.map((n) => n.label)).toEqual([
      'Now rip out the old router',
      'edit · router.ts ×3',
      'bash · Delete the old router',
      'denied bash',
    ]);
    // Nodes at the boundary are MARKED, never removed: hiding them would
    // collapse the layout and destroy the spatial memory of the run.
    expect(ir.nodes).toHaveLength(before.length + after.length);
    // Revert is an ACCURACY failure, not a READABILITY one. Collapsing the two
    // would corrupt the single meaning coverage has.
    expect(ir.meta.coverage.unrecognized).toBe(0);
    expect(ir.meta.coverage.sourcesUnread).toBe(0);
    expect(classifyCoverage(ir.meta, 1)).toBe('none');
  });

  it('`reverted` is absent — not false — on a run with no revert', async () => {
    const { ir } = await irFor(OC_CLEAN_RUN_ID);
    for (const n of ir.nodes) expect('reverted' in n, n.id).toBe(false);
    expect(ir.meta.ext.opencode.revert).toBeUndefined();
  });

  // AC 8, BOTH HALVES. Asserting only the first would let a blanket exclusion
  // pass, and a blanket exclusion would silently delete real interventions.
  it('suppresses work-quality signals on reverted nodes while interventions still fire', async () => {
    const { ir } = await irFor(OC_REVERTED_RUN_ID);
    const kinds = kindsOf(deriveSignals(ir));
    // Three failing edits in a row would be a textbook retry-storm — but the
    // user threw that turn away, so the claim "the run was retrying instead of
    // making progress" is about work that no longer stands.
    const storm = ir.nodes.find((n) => n.label === 'edit · router.ts ×3');
    expect(storm.status).toBe('error');
    expect(storm.errorCount).toBe(3);
    expect(kinds.some((k) => k.startsWith('retry-storm'))).toBe(false);
    expect(kinds.some((k) => k.startsWith('unresolved-error'))).toBe(false);
    // …and the denial INSIDE the reverted region still fires, because a revert
    // rolls back work, not the record of what a person decided.
    expect(kinds).toContain('intervention:1 denial');
    expect(ir.nodes.find((n) => n.interventionKind === 'denial').reverted).toBe(true);
  });

  it('an outlier never counts a reverted node', () => {
    // Built here rather than in a fixture: the shape needs one huge reverted
    // node against a small median, which no realistic opencode run produces.
    const node = (id, tokens, reverted) => ({
      id,
      kind: 'turn',
      label: id,
      status: 'completed',
      tokens: { input: tokens, output: 0 },
      ...(reverted ? { reverted: true } : {}),
    });
    const nodes = [node('a', 5000), node('b', 6000), node('c', 7000), node('d', 900000, true)];
    expect(deriveSignals({ nodes, edges: [] }).filter((s) => s.kind === 'outlier')).toEqual([]);
    // …and the same graph without the revert DOES fire, so the test is real.
    const live = [...nodes.slice(0, 3), node('d', 900000)];
    expect(deriveSignals({ nodes: live, edges: [] }).some((s) => s.kind === 'outlier')).toBe(true);
  });

  // AC 27. Pinned on the pure helper so a future change cannot quietly route
  // revert through opacity — the FocusSet's exclusive channel.
  it('focus and revert are independent channels, in all four combinations', () => {
    const plain = { id: 'n1' };
    const rolled = { id: 'n2', reverted: true };
    const focus = new Set(['n1', 'n2']);
    const elsewhere = new Set(['n9']);

    expect(nodeMarks(plain, null)).toEqual({ focused: false, dim: false, reverted: false });
    expect(nodeMarks(rolled, null)).toEqual({ focused: false, dim: false, reverted: true });
    // A focus MEMBER that was reverted renders LIT, with its mark.
    expect(nodeMarks(rolled, focus)).toEqual({ focused: true, dim: false, reverted: true });
    // A non-member renders dimmed BECAUSE it is unfocused, mark unchanged.
    expect(nodeMarks(rolled, elsewhere)).toEqual({ focused: false, dim: true, reverted: true });
    expect(nodeMarks(plain, elsewhere)).toEqual({ focused: false, dim: true, reverted: false });
  });

  it('the stylesheet never routes revert through opacity', async () => {
    const css = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'styles.css'),
      'utf8',
    );
    // Every rule whose selector mentions data-reverted, and its body.
    const rules = [...css.matchAll(/([^}]*data-reverted[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect(body, `opacity in "${selector.trim()}"`).not.toMatch(/(^|[^-])opacity\s*:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent lanes
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode subagent lanes', () => {
  it('a task part materialises a lane with spawn and return edges', async () => {
    const { ir, details } = await irFor(OC_SUBAGENT_RUN_ID, { collectDetails: true });
    const agent = ir.nodes.find((n) => n.agentId === OC_CHILD_ID);
    expect(agent.id).toBe(`a:${OC_CHILD_ID}`);
    expect(agent.label).toBe('Explore project structure');
    expect(agent.status).toBe('completed');
    expect(agent.group).toBe(`lane:a:${OC_CHILD_ID}`);
    expect(ir.groups.some((g) => g.id === agent.group)).toBe(true);
    expect(agent.tokens).toEqual({ input: 5000, output: 120 });
    expect(agent.files).toEqual(['/home/dev/acme/src/auth/token.js']);
    const spawn = ir.edges.find((e) => e.kind === 'spawn' && e.to === agent.id);
    expect(spawn.label).toBe('Explore project structure');
    const ret = ir.edges.find((e) => e.kind === 'return' && e.from === agent.id);
    // opencode wraps the answer in <task_result>…</task_result>; the label is
    // the answer, not the wrapper.
    expect(ret.label).toBe('token.js owns refresh; session.ts:41 resets the TTL.');
    expect(details.get(agent.id).prompt).toBe('Map src/auth and report each file.');
    // The child's own messages walk into the lane by the same rules.
    const lane = ir.nodes.filter((n) => n.group === agent.group && n.id !== agent.id);
    expect(lane.some((n) => n.kind === 'turn')).toBe(true);
    expect(lane.some((n) => n.kind === 'tool')).toBe(true);
  });

  // The two reconciliation mismatches resolve DIFFERENTLY and deliberately.
  it('an orphan child gets a lane with NO coverage penalty; a dangling task part is sourcesUnread', async () => {
    const { ir } = await irFor(OC_SUBAGENT_RUN_ID);
    const orphan = ir.nodes.find((n) => n.agentId === OC_ORPHAN_CHILD_ID);
    expect(orphan).toBeDefined();
    const spawn = ir.edges.find((e) => e.kind === 'spawn' && e.to === orphan.id);
    // Said on the LABEL, never on `reason`: courseChanges() promotes `reason`
    // into a chip, and "the run changed course because its spawn record was
    // pruned" is not a thing that happened.
    expect(spawn.label).toBe('(spawn record not retained — compacted)');
    expect(spawn.reason).toBeUndefined();
    expect(ir.meta.ext.opencode.orphanLanes).toBe(1);
    // A child rungraph READ COMPLETELY costs nothing…
    // …while a task part naming a session row that is gone is a source it
    // could not open at all.
    expect(ir.meta.coverage.sourcesUnread).toBe(1);
    expect(ir.meta.ext.opencode.missingChildSessions).toEqual([OC_MISSING_CHILD_ID]);
    expect(ir.meta.totals.agents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode coverage', () => {
  it('counts walked ROWS, names the drifted types, and classifies quiet vs loud', async () => {
    const quiet = (await irFor(OC_DRIFT_QUIET_RUN_ID)).ir;
    expect(quiet.meta.coverage.unrecognized).toBe(1);
    expect(quiet.meta.ext.opencode.unknownTypes).toEqual({ 'flux-marker': 1 });
    expect(quiet.meta.coverage.unrecognized).toBe(quiet.meta.unrecognizedLineCount);
    expect(deriveSignals(quiet)).toEqual([]);
    expect(classifyCoverage(quiet.meta, 0)).toBe('quiet');

    const loud = (await irFor(OC_DRIFT_LOUD_RUN_ID)).ir;
    expect(loud.meta.coverage.unrecognized).toBe(30);
    expect(loud.meta.ext.opencode.unknownTypes).toEqual({ 'turn-capsule': 30 });
    expect(deriveSignals(loud)).toEqual([]);
    expect(classifyCoverage(loud.meta, 0)).toBe('loud');
  });

  // Coverage measures rungraph's READING, not opencode's recording. If
  // opencode never wrote the payload down there is nothing rungraph failed to
  // read, and denting a healthy run's badge for it is the false alarm the
  // whole layer exists to prevent.
  it('truncation is NOT a coverage event, and detail says so in words', async () => {
    const { ir, details } = await irFor(OC_TRUNCATION_RUN_ID, { collectDetails: true });
    expect(ir.meta.coverage.unrecognized).toBe(0);
    expect(ir.meta.coverage.sourcesUnread).toBe(0);
    expect(coveragePercent(ir.meta)).toBe(100);
    expect(classifyCoverage(ir.meta, 0)).toBe('none');
    expect(ir.meta.ext.opencode.truncated).toBe(2);
    const node = ir.nodes.find((n) => n.label.startsWith('bash'));
    expect(node.ext.opencode.truncated).toBe(1);
    const call = details.get(node.id).calls[0];
    expect(call.truncated).toBe(true);
    expect(call.output).toContain('transforming (1) index.html'); // the preview
    expect(call.output).toContain('not recoverable');
  });

  it('the adapter never reads tool-output/, because spill files do not survive', async () => {
    const files = await readdir(ADAPTER_DIR);
    for (const f of files) {
      const src = await readFile(join(ADAPTER_DIR, f), 'utf8');
      expect(src.includes("'tool-output'"), f).toBe(false);
      expect(src.includes('tool-output/'), f).toBe(false);
    }
  });

  // Coverage cannot catch a MISREAD field by construction: it measures
  // unreadable records, not misread ones. One narrow assertion covers the one
  // key every provider reports.
  it('a run whose steps lost tokens.input warns in ext WITHOUT touching coverage', async () => {
    const { ir } = await irFor(OC_SHAPE_RUN_ID);
    expect(ir.meta.ext.opencode.shapeWarnings).toHaveLength(1);
    expect(ir.meta.ext.opencode.shapeWarnings[0]).toContain('tokens.input');
    // The two channels must not be conflated: nothing was UNREADABLE here.
    expect(ir.meta.coverage.unrecognized).toBe(0);
    // …and a healthy run raises no warning at all.
    expect((await irFor(OC_CLEAN_RUN_ID)).ir.meta.ext.opencode.shapeWarnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Forks, compaction, and the agent name
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode forks and compaction', () => {
  it('a fork is its OWN run, reports copied history, and names no origin', async () => {
    const refs = await detect([OPENCODE_FIXTURE_ROOT]);
    const ref = refs.find((r) => r.runId === OC_FORK_RUN_ID);
    expect(ref).toBeDefined(); // a root session, never a lane
    const { ir } = await parse(ref);
    expect(ir.meta.ext.opencode.copiedHistory).toBe(true);
    // Nothing in opencode's schema records where a fork came from, so rungraph
    // states only the provable fact and invents no lineage.
    const bag = JSON.stringify(ir.meta.ext.opencode);
    expect(bag).not.toContain('origin');
    expect(bag).not.toContain('forkedFrom');
    // …and a genuine session never claims it.
    expect((await irFor(OC_CLEAN_RUN_ID)).ir.meta.ext.opencode.copiedHistory).toBeUndefined();
  });

  it('a NULL session.agent resolves from the messages, and never to `compaction`', async () => {
    // The fork inherits neither `agent` nor `model`.
    expect((await refFor(OC_FORK_RUN_ID)).agent).toBe('build');
    // The compaction run's session.agent is NULL and one of its messages is
    // stamped `agent: "compaction"` — a pseudo-agent nobody chose, which must
    // never be presented as one.
    const ref = await refFor(OC_COMPACTION_RUN_ID);
    expect(ref.agent).toBe('build');
    const { ir } = await parse(ref);
    expect(ir.meta.ext.opencode.agent).toBe('build');
    // The pseudo-agent must not reach ANY presented value. (`compaction: 1` is
    // a count, not an agent — asserting on the serialized bag would catch it
    // and prove nothing.)
    const presented = [ref.agent, ir.meta.ext.opencode.agent, ...ir.nodes.map((n) => n.model)];
    expect(presented).not.toContain('compaction');
  });

  it('a compaction renders as its own turn, never as a prompt a human typed', async () => {
    const { ir, details } = await irFor(OC_COMPACTION_RUN_ID, { collectDetails: true });
    const turns = ir.nodes.filter((n) => n.kind === 'turn');
    expect(turns.map((n) => n.label)).toEqual(['⟳ Context compacted', 'Carry on with the migration']);
    expect(details.get(turns[0].id).prompt).toContain('compacted the context');
    expect(ir.meta.ext.opencode.compaction).toBe(1);
    // Compaction is a FACT, not a signal — it must not borrow course-change's
    // meaning, and it is not trouble.
    expect(deriveSignals(ir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schema tolerance and hostile input
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode schema tolerance', () => {
  it('a session table missing a late-migration column parses, that column reading null', async () => {
    // The 1.15.x shape: no `agent`, `model`, `cost`, `tokens_*` or `metadata`.
    const { dir, db } = await buildDb(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
        title TEXT, version TEXT, revert TEXT, time_created INTEGER NOT NULL,
        time_updated INTEGER, time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
    `);
    try {
      db.prepare('INSERT INTO project VALUES (?,?,?,?)').run('p1', '/home/dev/acme', 'git', 'acme');
      db.prepare(
        'INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)',
      ).run('ses_old0001', 'p1', '/home/dev/acme', 'An older opencode', '1.15.6', 1000, 5000);
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
        'msg_o1', 'ses_old0001', 1100, 1100,
        JSON.stringify({ role: 'user', time: { created: 1100 }, agent: 'build' }),
      );
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
        'prt_o1', 'msg_o1', 'ses_old0001', 1105, 1105,
        JSON.stringify({ type: 'text', text: 'check the cron' }),
      );
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
        'msg_o2', 'ses_old0001', 1200, 1200,
        JSON.stringify({ role: 'assistant', parentID: 'msg_o1', agent: 'build', tokens: { input: 500, output: 20, cache: { read: 0, write: 0 } }, finish: 'stop' }),
      );
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
        'prt_o2', 'msg_o2', 'ses_old0001', 1205, 1205,
        JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'crontab -l' }, output: '0 3 * * * backup.sh', time: { start: 1205, end: 1206 } } }),
      );
      db.close();

      const refs = await detect([dir]);
      expect(refs).toHaveLength(1);
      expect(refs[0].agent).toBe('build'); // no column → fell back to messages
      expect(refs[0].model).toBeUndefined(); // no column → literal null
      expect(refs[0].version).toBe('1.15.6');
      const { ir } = await parse(refs[0]);
      expect(ir.meta.unrecognizedLineCount).toBe(0);
      expect(ir.nodes.filter((n) => n.kind === 'tool')).toHaveLength(1);
      expect(ir.meta.ext.opencode.billed).toBeUndefined();
      expect(ir.meta.ext.opencode.cost).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never queries session_message — the table is transient and must not be built on', async () => {
    // It held 18 rows all afternoon and read 0 immediately after one opencode
    // launch, with message/part untouched. A signal derived from it would
    // vanish between two viewings of the same finished run.
    for (const f of await readdir(ADAPTER_DIR)) {
      const src = await readFile(join(ADAPTER_DIR, f), 'utf8');
      expect(src.includes('session_message'), `${f} references session_message`).toBe(false);
    }
    // …and the fixture DB deliberately HAS rows in it, so "not read" is
    // distinguishable from "nothing to read".
    const { DatabaseSync } = requireBuiltin('node:sqlite');
    const db = new DatabaseSync(join(OPENCODE_FIXTURE_ROOT, 'opencode.db'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_message').get().c).toBeGreaterThan(0);
    db.close();
  });

  it('unparseable and unknown payloads are skipped and counted, never thrown', async () => {
    const { dir, db } = await buildDb(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, revert TEXT, time_created INTEGER NOT NULL, time_updated INTEGER, time_archived INTEGER, agent TEXT, model TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
    `);
    try {
      db.prepare('INSERT INTO project VALUES (?,?)').run('p1', '/home/dev/acme');
      db.prepare('INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)')
        .run('ses_junk0001', 'p1', '/home/dev/acme', 'Junk', '1.18.19', 1000, 9000);
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_j1', 'ses_junk0001', 1100, 1100, '{not json');
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_j2', 'ses_junk0001', 1200, 1200, JSON.stringify({ role: 'wizard' }));
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_j1', 'msg_j2', 'ses_junk0001', 1205, 1205, '{{{');
      // A part whose message row is gone: examined, readable, unplaceable.
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_j2', 'msg_gone', 'ses_junk0001', 1206, 1206, JSON.stringify({ type: 'text', text: 'orphan' }));
      // A prototype-pollution attempt through the type name.
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_j3', 'msg_j2', 'ses_junk0001', 1207, 1207, JSON.stringify({ type: '__proto__' }));
      db.close();
      const refs = await detect([dir]);
      const { ir } = await parse(refs[0]);
      expect(ir.meta.coverage.records).toBe(5);
      expect(ir.meta.coverage.unrecognized).toBe(5);
      expect(ir.meta.ext.opencode.unknownTypes).toEqual({
        message: 1,
        'role:wizard': 1,
        part: 1,
        orphan_part: 1,
        other: 1, // `__proto__` folded, never used as a key
      });
      expect(Object.getPrototypeOf(ir.meta.ext.opencode.unknownTypes)).toBe(Object.prototype);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('label and file helpers never throw on hostile input', () => {
    expect(toolLabel('bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(40);
    expect(toolLabel('webfetch', { url: 'https://docs.example.com/a/b' })).toBe('webfetch · docs.example.com');
    expect(toolLabel('webfetch', { url: ':::not a url' })).toBe('webfetch');
    expect(toolLabel('bash', null)).toBe('bash');
    expect(toolLabel('read', { filePath: 42 })).toBe('read');
    expect(toolLabel('mystery', { anything: true })).toBe('mystery');
    expect(toolLabel('read', {}, '  ')).toBe('read'); // blank title falls through
    expect(filePathsFromInput('read', { filePath: '/a/b.js' })).toEqual(['/a/b.js']);
    expect(filePathsFromInput('grep', { path: '/a', pattern: 'x' })).toEqual([]); // a search root
    expect(filePathsFromInput('bash', { command: 'rm /a/b.js' })).toEqual([]); // guesswork
    expect(filePathsFromInput('read', { filePath: 'a\nb' })).toEqual([]);
    expect(filePathsFromInput('read', { filePath: 'x'.repeat(600) })).toEqual([]);
    expect(filePathsFromInput('read', null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live tail, fingerprint, resume
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode live tail / resume', () => {
  it('watch targets are the DB dir, the DB and its WAL', async () => {
    const ref = await refFor(OC_CLEAN_RUN_ID);
    expect(watchTargets(ref)).toEqual([
      // The dir target is what survives SQLite deleting and recreating the
      // -wal across opencode restarts.
      { path: dirname(ref.dbPath), recursive: false },
      { path: ref.dbPath, recursive: false },
      { path: `${ref.dbPath}-wal`, recursive: false },
    ]);
    expect(fingerprint(ref)).toBe(`${ref.modifiedAt}:${ref.messageCount}`);
  });

  it('fingerprint moves for the session that changed, and NOT for the others', async () => {
    // The one-global-DB trap: a file-mtime fingerprint would mark every
    // opencode session live whenever any one of them was written.
    const dir = await mkdtemp(join(tmpdir(), 'rg-oc-fp-'));
    try {
      await copyFile(join(OPENCODE_FIXTURE_ROOT, 'opencode.db'), join(dir, 'opencode.db'));
      const before = new Map((await detect([dir])).map((r) => [r.runId, fingerprint(r)]));
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const db = new DatabaseSync(join(dir, 'opencode.db'));
      const target = OC_CLEAN_RUN_ID.slice('opencode:'.length);
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run('msg_live01', target, 1785599999000, 1785599999000, JSON.stringify({ role: 'user', time: { created: 1785599999000 }, agent: 'build' }));
      db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(1785599999000, target);
      db.close();
      const after = new Map((await detect([dir])).map((r) => [r.runId, fingerprint(r)]));
      expect(after.get(OC_CLEAN_RUN_ID)).not.toBe(before.get(OC_CLEAN_RUN_ID));
      for (const [runId, fp] of before) {
        if (runId === OC_CLEAN_RUN_ID) continue;
        expect(after.get(runId), runId).toBe(fp);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a subagent write moves the PARENT fingerprint — its lane is in the parent graph', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rg-oc-sub-'));
    try {
      await copyFile(join(OPENCODE_FIXTURE_ROOT, 'opencode.db'), join(dir, 'opencode.db'));
      const before = fingerprint((await detect([dir])).find((r) => r.runId === OC_SUBAGENT_RUN_ID));
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const db = new DatabaseSync(join(dir, 'opencode.db'));
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
        .run('msg_child9', OC_CHILD_ID, 1785599999000, 1785599999000, JSON.stringify({ role: 'assistant', parentID: 'x', agent: 'explore' }));
      db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(1785599999000, OC_CHILD_ID);
      db.close();
      const after = (await detect([dir])).find((r) => r.runId === OC_SUBAGENT_RUN_ID);
      expect(fingerprint(after)).not.toBe(before);
      expect(after.modifiedAt).toBe(new Date(1785599999000).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('live tail: appending a message produces a re-parse within the debounce window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rg-oc-tail-'));
    try {
      await copyFile(join(OPENCODE_FIXTURE_ROOT, 'opencode.db'), join(dir, 'opencode.db'));
      const opencode = await import('../src/adapters/opencode/index.js');
      const { watchRun } = await import('../src/watcher.js');
      const ref = (await detect([dir])).find((r) => r.runId === OC_CLEAN_RUN_ID);
      let emits = 0;
      await new Promise((resolve) => {
        const w = watchRun(ref, opencode, {
          onGraph() {
            emits++;
            if (emits >= 2) {
              w.close();
              resolve();
            }
          },
          onError() {},
          debounceMs: 50,
        });
        setTimeout(() => {
          const { DatabaseSync } = requireBuiltin('node:sqlite');
          const db = new DatabaseSync(join(dir, 'opencode.db'));
          db.exec('PRAGMA journal_mode=WAL');
          const target = OC_CLEAN_RUN_ID.slice('opencode:'.length);
          db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
            .run('msg_tail01', target, 1785599999000, 1785599999000, JSON.stringify({ role: 'user', time: { created: 1785599999000 }, agent: 'build' }));
          db.close();
        }, 300);
        setTimeout(() => {
          w.close();
          resolve();
        }, 6000); // fail-safe; the assertion below reports the miss
      });
      expect(emits).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 12000);

  it('every root session resumes, with a fork command as well', async () => {
    const ref = await refFor(OC_CLEAN_RUN_ID);
    const info = resumeInfo(ref);
    const id = ref.sessionId;
    expect(info.argv).toEqual(['opencode', '--session', id]);
    expect(info.forkArgv).toEqual(['opencode', '--session', id, '--fork']);
    // /home/dev does not exist here, so no cd prefix and no launch cwd.
    expect(info.cwd).toBeNull();
    expect(info.copyCommand).toBe(`opencode --session ${id}`);
    expect(info.forkCopyCommand).toBe(`opencode --session ${id} --fork`);
    // …and the index entry is what renders the dashboard's fork checkbox.
    const entry = toIndexEntry(ref);
    expect(entry.resume.forkCopyCommand).toBe(info.forkCopyCommand);
  });
});

// ---------------------------------------------------------------------------
// The cross-adapter invariant. Three adapters implemented this rule in three
// independent copies and asserted it NOWHERE; a fourth written against a
// corpus that reaches errorCount 5 in one node made the risk concrete.
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cross-adapter tool-node invariant', () => {
  it('status is `error` IFF every collapsed call failed, in all four adapters', async () => {
    const [claude, codex, hermes, opencode] = await Promise.all([
      import('../src/adapters/claude-code/index.js'),
      import('../src/adapters/codex/index.js'),
      import('../src/adapters/hermes/index.js'),
      import('../src/adapters/opencode/index.js'),
    ]);
    const here = dirname(fileURLToPath(import.meta.url));
    const corpora = [
      [claude, join(here, 'fixtures', 'projects')],
      [codex, join(here, 'fixtures', 'codex')],
      [hermes, join(here, 'fixtures', 'hermes')],
      [opencode, join(here, 'fixtures', 'opencode')],
    ];
    let checked = 0;
    let sawError = 0;
    let sawPartial = 0;
    for (const [adapter, root] of corpora) {
      for (const ref of await adapter.detect([root])) {
        const { ir } = await adapter.parse(ref);
        for (const n of ir.nodes) {
          if (n.kind !== 'tool') continue;
          // A live run's still-executing group is neither: excluded, because
          // the rule is about SETTLED groups.
          if (n.status === 'running') continue;
          checked++;
          const errors = n.errorCount ?? 0;
          const calls = n.callCount ?? 1;
          const allFailed = errors > 0 && errors >= calls;
          expect(
            n.status === 'error',
            `${ref.runId} ${n.id} "${n.label}": ${errors}/${calls} errors, status ${n.status}`,
          ).toBe(allFailed);
          if (allFailed) sawError++;
          if (errors > 0 && !allFailed) sawPartial++;
        }
      }
    }
    // The assertion is only meaningful if the corpora actually exercise BOTH
    // sides of the iff — a suite that only ever saw clean nodes would pass
    // while asserting nothing.
    expect(checked).toBeGreaterThan(40);
    expect(sawError).toBeGreaterThan(0);
    expect(sawPartial).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The loop: MCP install, and the fields the agent end needs.
// ---------------------------------------------------------------------------

const exec = promisify(execFile);

describe('opencode MCP install (paste tier)', () => {
  it('--client opencode prints the mcp block and the AGENTS.md line, writes nothing, exits 0', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-oc-cfg-'));
    try {
      const cfg = join(tmp, 'opencode.jsonc');
      const original = '{\n  // a comment rungraph must never destroy\n  "model": "x"\n}\n';
      await writeFile(cfg, original);
      const { stdout, stderr } = await exec('node', [BIN, 'mcp', '--install', '--client', 'opencode'], {
        env: { ...process.env, OPENCODE_CONFIG: cfg },
      });
      expect(stdout).toContain('"mcp"'); // the key is `mcp`, NOT `mcpServers`
      expect(stdout).not.toContain('mcpServers');
      expect(stdout).toContain(cfg);
      expect(stdout).toContain('focus_nodes'); // the AGENTS.md snippet
      expect(stdout).toContain('AGENTS.md');
      expect(stderr).toContain('interactive wizard');
      // Nothing was written — opencode config files are JSONC.
      expect(await readFile(cfg, 'utf8')).toBe(original);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('--json emits the same payload machine-readably, with command as an ARRAY', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-oc-cfgj-'));
    try {
      const cfg = join(tmp, 'opencode.json');
      const { stdout } = await exec('node', [BIN, 'mcp', '--install', '--client', 'opencode', '--json'], {
        env: { ...process.env, OPENCODE_CONFIG: cfg },
      });
      const report = JSON.parse(stdout);
      expect(report.client).toBe('opencode');
      expect(report.wrote).toBe(false);
      expect(report.configExists).toBe(false);
      expect(report.configPath).toBe(cfg);
      // Verified against https://opencode.ai/config.json: McpLocalConfig
      // requires `type` and `command`, and `command` is a string ARRAY.
      const entry = report.config.mcp.rungraph;
      expect(entry.type).toBe('local');
      expect(Array.isArray(entry.command)).toBe(true);
      expect(entry.command).toHaveLength(3);
      expect(entry.enabled).toBe(true);
      expect(report.instructions).toContain('focus_nodes');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('the client is never guessed: an unknown one is exit 1, and the default is unchanged', async () => {
    await expect(exec('node', [BIN, 'mcp', '--install', '--client', 'nope'])).rejects.toMatchObject({ code: 1 });
    // A machine with both agents installed has no right answer to sniff for.
    const { stdout } = await exec('node', [BIN, '--help']);
    expect(stdout).toContain('--client <c>');
    expect(stdout).toContain('claude (default) | opencode');
  });
});

describe.skipIf(!hasNodeSqlite)('opencode through the MCP read tools', () => {
  let portDir;
  beforeAll(async () => {
    // Point port discovery at a scratch registry: list_runs MERGES the runs of
    // every live server, so without this the suite would pick up whatever
    // rungraph the developer happens to have open.
    portDir = await mkdtemp(join(tmpdir(), 'rg-oc-reg-'));
  });
  afterAll(() => rm(portDir, { recursive: true, force: true }));

  const mcpEnv = () => ({
    ...process.env,
    RUNGRAPH_CLAUDE_PROJECTS: '',
    RUNGRAPH_CODEX_SESSIONS: '',
    RUNGRAPH_HERMES_HOME: '',
    RUNGRAPH_OPENCODE_HOME: OPENCODE_FIXTURE_ROOT,
    RUNGRAPH_PORT_DIR: portDir,
  });

  /** One tool call over the real stdio transport. */
  const call = (name, args) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [BIN, 'mcp'], { env: mcpEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timeout calling ${name}`));
      }, 20000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== 2) continue;
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? '';
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });

  it('list_runs carries the opencode runs, none of them a subagent session', async () => {
    const out = await call('list_runs', {});
    expect(out.runs.every((r) => r.adapter === 'opencode')).toBe(true);
    expect(out.runs).toHaveLength(16);
    for (const child of [OC_CHILD_ID, OC_ORPHAN_CHILD_ID]) {
      expect(out.runs.some((r) => r.runId.includes(child))).toBe(false);
    }
  });

  // The compact projection is the DEFAULT the tool descriptions steer agents
  // toward, and it carries no `ext` — so `reverted` has to be a core field or
  // the canvas and the agent describe the same run differently.
  it('get_graph (compact) returns reverted:true, plus the run-level note', async () => {
    const out = await call('get_graph', { runId: OC_REVERTED_RUN_ID });
    expect(out.detail).toBe('compact');
    expect(out.nodes.filter((n) => n.reverted === true)).toHaveLength(4);
    expect(out.note).toContain('REVERTED');
    // …and a run with no revert carries neither the key nor the note.
    const clean = await call('get_graph', { runId: OC_CLEAN_RUN_ID });
    expect(clean.nodes.some((n) => 'reverted' in n)).toBe(false);
    expect(clean.note).toBeUndefined();
  });

  it('find_nodes returns reverted:true on the nodes it matches', async () => {
    const out = await call('find_nodes', { runId: OC_REVERTED_RUN_ID, query: 'router.ts' });
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.nodes.every((n) => n.reverted === true)).toBe(true);
    expect(out.note).toContain('REVERTED');
  });

  it('get_detail on a reverted run still warns, though it carries no nodes', async () => {
    const graph = await call('get_graph', { runId: OC_REVERTED_RUN_ID });
    const node = graph.nodes.find((n) => n.label?.startsWith('edit'));
    const out = await call('get_detail', { runId: OC_REVERTED_RUN_ID, nodeId: node.id });
    expect(out.detail.kind).toBe('tool');
    expect(out.note).toContain('REVERTED');
  });

  it('secrets are redacted at callTool — node LABELS included — with a count', async () => {
    // The label is the case that pins redaction to the choke point: it reaches
    // find_nodes and get_graph with no payload fetched at all.
    const { ir } = await irFor(OC_SECRETS_RUN_ID);
    expect(ir.nodes.some((n) => scanText(n.label).length > 0)).toBe(true);

    const out = await call('get_graph', { runId: OC_SECRETS_RUN_ID });
    const asText = JSON.stringify(out);
    expect(asText).toContain('[REDACTED:');
    expect(out.note).toMatch(/secrets? in this payload/);
    for (const node of out.nodes) expect(scanText(node.label ?? '')).toEqual([]);
    expect(scanText(asText)).toEqual([]);

    const found = await call('find_nodes', { runId: OC_SECRETS_RUN_ID, query: 'AKIA' });
    expect(scanText(JSON.stringify(found))).toEqual([]);
  });

  it('a loud opencode run tells the agent so before it can call the run clean', async () => {
    const out = await call('get_graph', { runId: OC_DRIFT_LOUD_RUN_ID });
    expect(out.note).toContain('could be parsed');
    expect(out.note).toContain('do not call it clean');
    expect(out.coverage.unrecognized).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review regressions. Each case builds (or names) the exact shape
// that produced wrong output, and each one passed the whole suite before the
// fix — which is the point: the corpus did not cross these features.
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('opencode review regressions', () => {
  // `revert` is written on the session row the user was looking at, NEVER on
  // the child it dispatched. Reading the child's own column marks the agent
  // node and nothing inside its lane — a struck-through agent over a lane full
  // of unqualified nodes, with work-quality signals firing on discarded work.
  it('a subagent lane inherits its parent\'s revert boundary', async () => {
    const { ir } = await irFor(OC_REVERT_LANE_RUN_ID);
    const agent = ir.nodes.find((n) => n.agentId === OC_LANE_CHILD_ID);
    expect(agent.reverted).toBe(true);
    const lane = ir.nodes.filter((n) => n.group === agent.group && n.id !== agent.id);
    expect(lane.length).toBeGreaterThan(1);
    for (const n of lane) expect(n.reverted, `${n.id} "${n.label}"`).toBe(true);
    // …and the turn BEFORE the boundary is untouched, so this is a boundary,
    // not a blanket.
    const before = ir.nodes.filter((n) => !n.reverted).map((n) => n.label);
    expect(before).toEqual(['Add request logging to the server', 'read · server.ts']);
    // The lane holds a textbook storm — three failing edits in one node — and
    // it must NOT fire, because the user threw that turn away.
    const storm = lane.find((n) => n.label === 'edit · router.ts ×3');
    expect(storm.status).toBe('error');
    expect(storm.errorCount).toBe(3);
    expect(deriveSignals(ir)).toEqual([]);
  });

  // opencode permission-gates `task` BEFORE it creates the child session row,
  // so a refused subagent lands with the exact rejection string and no
  // `metadata.sessionId`. Routing every `task` to the lane builder swallowed
  // the intervention AND charged coverage for a session never written.
  it('a REFUSED task is an intervention, not a phantom lane and not a coverage penalty', async () => {
    const { ir, details } = await irFor(OC_DENY_TASK_RUN_ID, { collectDetails: true });
    const node = ir.nodes.find((n) => n.label.startsWith('task ·'));
    expect(node.kind).toBe('tool'); // a dispatch that failed spawned nothing
    expect(node.status).toBe('error');
    const human = ir.nodes.find((n) => n.id === `h:${node.id.slice(2)}`);
    expect(human.label).toBe('denied task');
    expect(human.interventionKind).toBe('denial');
    expect(details.get(human.id).answer).toBe(
      'The user rejected permission to use this specific tool call.',
    );
    expect(ir.edges.some((e) => e.kind === 'sequence' && e.from === node.id && e.to === human.id)).toBe(true);
    // Nothing was written for rungraph to fail to read.
    expect(ir.meta.coverage.sourcesUnread).toBe(0);
    expect(ir.nodes.some((n) => n.kind === 'agent')).toBe(false);
    expect(kindsOf(deriveSignals(ir))).toContain('intervention:2 denials');
  });

  it('a task with no recorded child costs coverage NOTHING, and says so in ext', async () => {
    const { ir } = await irFor(OC_DENY_TASK_RUN_ID);
    // The live-tail moment between the tool call and `metadata({sessionId})`:
    // no session is NAMED, so this is not a source that could not be opened.
    expect(ir.meta.coverage.sourcesUnread).toBe(0);
    expect(ir.meta.ext.opencode.unresolvedTasks).toBe(1);
    expect(ir.meta.ext.opencode.missingChildSessions).toBeUndefined();
    // …while a task naming a session row that IS gone still costs one.
    const sub = (await irFor(OC_SUBAGENT_RUN_ID)).ir;
    expect(sub.meta.coverage.sourcesUnread).toBe(1);
    expect(sub.meta.ext.opencode.unresolvedTasks).toBeUndefined();
  });

  it('a refused parallel batch reads as ONE person saying no', async () => {
    const { ir } = await irFor(OC_DENY_TASK_RUN_ID);
    const globDenials = ir.nodes.filter((n) => n.label.startsWith('denied glob'));
    expect(globDenials).toHaveLength(1);
    expect(globDenials[0].label).toBe('denied glob, glob, glob');
    // Every refused call still points at it — that adjacency is the whole
    // mechanism by which signals.js excuses them.
    const globs = ir.nodes.filter((n) => n.label.startsWith('glob ·'));
    expect(globs.length).toBeGreaterThan(0);
    for (const g of globs) {
      expect(
        ir.edges.some((e) => e.kind === 'sequence' && e.from === g.id && e.to === globDenials[0].id),
        `${g.id} has no edge to the denial`,
      ).toBe(true);
    }
    const kinds = kindsOf(deriveSignals(ir));
    expect(kinds.some((k) => k.includes('glob error'))).toBe(false);
    expect(kinds.some((k) => k.startsWith('retry-storm'))).toBe(false);
  });

  // SCHEMA.md: "`endedAt` is absent while the run looks live" — bundle.js reads
  // exactly that sentence to stamp an exported live run as a snapshot.
  it('endedAt is absent on an empty run and on a live one, present once quiet', async () => {
    const { dir, db } = await buildDb(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, revert TEXT, time_created INTEGER NOT NULL, time_updated INTEGER, time_archived INTEGER, agent TEXT, model TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
    `);
    try {
      db.prepare('INSERT INTO project VALUES (?,?)').run('p1', '/home/dev/acme');
      const addSession = db.prepare(
        'INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)',
      );
      const addMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
      const user = (id, sid, at) => addMessage.run(id, sid, at, at, JSON.stringify({ role: 'user', time: { created: at }, agent: 'build' }));

      addSession.run('ses_empty01', 'p1', '/home/dev/acme', 'Nothing happened', '1.18.19', 1000, 2000);
      const nowish = Date.now() - 3000; // 3s ago: unmistakably live
      addSession.run('ses_live001', 'p1', '/home/dev/acme', 'Still going', '1.18.19', nowish - 100, nowish);
      user('msg_l1', 'ses_live001', nowish);
      const old = Date.parse('2026-08-01T12:00:00Z');
      addSession.run('ses_over001', 'p1', '/home/dev/acme', 'Long done', '1.18.19', old - 100, old);
      user('msg_o1', 'ses_over001', old);
      db.close();

      const refs = await detect([dir]);
      const irOf = async (id) => (await parse(refs.find((r) => r.sessionId === id))).ir;
      // `isoMillis(0)` is the TRUTHY string '1970-01-01T00:00:00.000Z', so a
      // bare `if (endedAt)` reports a run with no messages as having ended
      // before the epoch of every agent that has ever existed.
      const empty = await irOf('ses_empty01');
      expect(empty.meta.endedAt).toBeUndefined();
      expect(empty.nodes).toEqual([]);
      expect((await irOf('ses_live001')).meta.endedAt).toBeUndefined();
      expect((await irOf('ses_over001')).meta.endedAt).toBe(new Date(old).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // V8 parses deeply-nested JSON iteratively but SERIALIZES it recursively, so
  // a payload the parse guard accepted can still blow the stack on the way back
  // out — turning a detail-collecting parse (which every real consumer uses)
  // into a 500 and a run that cannot be opened.
  it('a pathologically nested tool input degrades instead of throwing', async () => {
    const { dir, db } = await buildDb(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, revert TEXT, time_created INTEGER NOT NULL, time_updated INTEGER, time_archived INTEGER, agent TEXT, model TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL);
    `);
    try {
      db.prepare('INSERT INTO project VALUES (?,?)').run('p1', '/home/dev/acme');
      db.prepare('INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)')
        .run('ses_deep0001', 'p1', '/home/dev/acme', 'Deep', '1.18.19', 1000, 9000);
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
        'msg_d1', 'ses_deep0001', 1100, 1100,
        JSON.stringify({ role: 'user', time: { created: 1100 }, agent: 'build' }),
      );
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
        'msg_d2', 'ses_deep0001', 1200, 1200,
        JSON.stringify({ role: 'assistant', parentID: 'msg_d1', agent: 'build', tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } }, finish: 'stop' }),
      );
      // 60,000 levels — far past V8's serializer budget, built as raw text so
      // nothing in this test has to survive it either.
      const depth = 60000;
      const nested = '['.repeat(depth) + '1' + ']'.repeat(depth);
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
        'prt_d1', 'msg_d2', 'ses_deep0001', 1205, 1205,
        `{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"x","payload":${nested}},"output":"ok","time":{"start":1205,"end":1206}}}`,
      );
      db.close();
      const ref = (await detect([dir]))[0];
      // Both modes must survive; `collectDetails: true` is what every real
      // consumer (server, watcher, bundle, MCP) actually calls.
      const plain = await parse(ref);
      expect(plain.nodes ?? plain.ir.nodes).toBeDefined();
      const { ir, details } = await parse(ref, { collectDetails: true });
      const node = ir.nodes.find((n) => n.kind === 'tool');
      expect(node.label).toBe('bash · x');
      expect(node.status).toBe('completed');
      expect(details.get(node.id).calls[0].input).toContain('could not render');
      expect(ir.meta.coverage.unrecognized).toBe(0); // it PARSED; it just would not re-serialize
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('an exported-but-EMPTY XDG_DATA_HOME reads as unset, never as a relative path', async () => {
    const { defaultRootDirs } = await import('../src/scanner.js');
    const saved = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = '';
      const [root] = defaultRootDirs().opencode;
      // With `??` the empty string survives and the root becomes the RELATIVE
      // path "opencode", resolved against whatever directory rungraph was run
      // from — which finds nothing and reports no opencode runs at all.
      expect(root.startsWith('/')).toBe(true);
      expect(root.endsWith(join('.local', 'share', 'opencode'))).toBe(true);
      process.env.XDG_DATA_HOME = '/tmp/rg-xdg-test';
      expect(defaultRootDirs().opencode).toEqual([join('/tmp/rg-xdg-test', 'opencode')]);
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  });

  // The recipient's server re-derives signals at open time, and rolledBack()
  // reads `reverted` — so dropping the field does not lose a signal, it INVENTS
  // one. Every other structure-only loss is subtractive.
  it('a structure-only bundle keeps `reverted`, so it cannot invent a retry-storm', async () => {
    const { buildBundle } = await import('../src/bundle.js');
    const saved = {
      claude: process.env.RUNGRAPH_CLAUDE_PROJECTS,
      codex: process.env.RUNGRAPH_CODEX_SESSIONS,
      hermes: process.env.RUNGRAPH_HERMES_HOME,
      opencode: process.env.RUNGRAPH_OPENCODE_HOME,
    };
    try {
      process.env.RUNGRAPH_CLAUDE_PROJECTS = '';
      process.env.RUNGRAPH_CODEX_SESSIONS = '';
      process.env.RUNGRAPH_HERMES_HOME = '';
      process.env.RUNGRAPH_OPENCODE_HOME = OPENCODE_FIXTURE_ROOT;
      const out = await buildBundle([OC_REVERTED_RUN_ID], { sharedBy: 'test', redaction: 'structure-only' });
      const run = out.envelope.runs.find((r) => r.runId === OC_REVERTED_RUN_ID);
      expect(run.ir.nodes.filter((n) => n.reverted === true)).toHaveLength(4);
      const signals = deriveSignals(run.ir);
      expect(signals.some((s) => s.kind === 'retry-storm')).toBe(false);
      expect(signals.some((s) => s.kind === 'unresolved-error')).toBe(false);
    } finally {
      for (const [k, v] of [
        ['RUNGRAPH_CLAUDE_PROJECTS', saved.claude],
        ['RUNGRAPH_CODEX_SESSIONS', saved.codex],
        ['RUNGRAPH_HERMES_HOME', saved.hermes],
        ['RUNGRAPH_OPENCODE_HOME', saved.opencode],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The self-disable path, on BOTH CI legs. Deliberately NOT inside a skipIf:
// this is the one opencode behaviour that must hold exactly where node:sqlite
// is missing.
// ---------------------------------------------------------------------------

describe('opencode graceful degrade (adapter self-disables)', () => {
  it('list --json: warnings entry, zero opencode runs, exit 0, one stderr line', async () => {
    const nodeArgs = hasNodeSqlite ? ['--no-experimental-sqlite'] : [];
    // process.execPath, not 'node': the PATH node may be a different major
    // than the one running this suite, and this test is ABOUT the runtime.
    const { stdout, stderr } = await exec(process.execPath, [...nodeArgs, BIN, 'list', '--json'], {
      env: {
        ...process.env,
        RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
        RUNGRAPH_CODEX_SESSIONS: '',
        RUNGRAPH_HERMES_HOME: '',
        RUNGRAPH_OPENCODE_HOME: OPENCODE_FIXTURE_ROOT,
      },
    });
    const data = JSON.parse(stdout);
    expect(data.runs.some((r) => r.adapter === 'opencode')).toBe(false);
    expect(data.runs.length).toBeGreaterThan(0); // other adapters unaffected
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0].adapter).toBe('opencode');
    expect(data.warnings[0].reason).toContain('node:sqlite');
    expect(stderr).toContain('opencode runs need Node 22.13+');
  });

  it('…and says NOTHING at all when there is no opencode install to skip', async () => {
    // A standing false alarm on a machine with no opencode is exactly the
    // trust cost the precision-over-recall rule exists to avoid.
    const tmp = await mkdtemp(join(tmpdir(), 'rg-oc-none-'));
    try {
      const nodeArgs = hasNodeSqlite ? ['--no-experimental-sqlite'] : [];
      const { stdout, stderr } = await exec(process.execPath, [...nodeArgs, BIN, 'list', '--json'], {
        env: {
          ...process.env,
          RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
          RUNGRAPH_CODEX_SESSIONS: '',
          RUNGRAPH_HERMES_HOME: '',
          RUNGRAPH_OPENCODE_HOME: tmp,
        },
      });
      expect(JSON.parse(stdout).warnings).toBeUndefined();
      expect(stderr).not.toContain('opencode runs need');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
