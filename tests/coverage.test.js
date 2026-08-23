import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, rm, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import {
  COVERAGE,
  classifyCoverage,
  coverageLabel,
  coverageNote,
  coveragePercent,
  coverageStats,
  emptyCoverage,
  mergeUnknownTypes,
  strongerCoverage,
  tallyUnknownType,
  unknownTypeSummary,
  unknownTypes,
} from '../src/coverage.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  CLEAN_RUN_ID,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  CODEX_SUBAGENT_RUN_ID,
} from './helpers.js';

/** `meta` for a run with `records` records of which `unrecognized` failed. */
const meta = (records, unrecognized, over = {}) => ({
  coverage: { records, unrecognized, sourcesUnread: 0, ...(over.coverage ?? {}) },
  ...(over.ext ? { ext: over.ext } : {}),
});

let refs;
beforeAll(async () => {
  await pinFixtureMtimes();
  refs = await detect([FIXTURE_ROOT]);
});
const irFor = async (runId) => (await parse(refs.find((r) => r.runId === runId))).ir;

describe('triggers', () => {
  it('quiet: a lightly drifted run with nothing else to say', () => {
    // The `atis-latch` class — ~5% unread, zero signals. The UI would otherwise
    // present this as a confident clean verdict.
    const m = meta(1000, 50);
    expect(classifyCoverage(m, 0)).toBe('quiet');
    expect(coverageLabel(m)).toBe('read 95% of this run');
  });

  it('loud: below the read floor with enough unrecognized records, signals or not', () => {
    const m = meta(100, 40);
    expect(classifyCoverage(m, 0)).toBe('loud');
    expect(classifyCoverage(m, 7)).toBe('loud');
    expect(coverageLabel(m)).toBe('read 60% of this run');
  });

  it('none: a fully-read run, at any signal count', () => {
    for (const n of [0, 1, 12]) expect(classifyCoverage(meta(500, 0), n)).toBe('none');
  });

  it('none: a drifted run that already has signals saying "look here"', () => {
    // Deliberate: the chips carry no implication of completeness to correct.
    expect(classifyCoverage(meta(1000, 50), 3)).toBe('none');
  });

  it('the absolute floor stops a tiny run from shouting', () => {
    // 40% unread, but only 12 records failed — under loudMinRecords.
    expect(classifyCoverage(meta(30, 12), 0)).toBe('quiet');
    // The hermes small-N case: one unrecognized row in a four-row run is 25%,
    // and a rate calibrated on line granularity would scream about it.
    expect(classifyCoverage(meta(4, 1), 0)).toBe('quiet');
  });

  it('loud wins: a run satisfying both returns exactly one verdict', () => {
    expect(classifyCoverage(meta(100, 90), 0)).toBe('loud');
    expect(COVERAGE.loudRead).toBe(0.75);
    expect(COVERAGE.loudMinRecords).toBe(25);
  });

  it('the smallest run that can go loud is ~34 records', () => {
    expect(classifyCoverage(meta(33, 25), 0)).toBe('loud'); // 24% read
    expect(classifyCoverage(meta(34, 25), 0)).toBe('loud');
    expect(classifyCoverage(meta(100, 24), 0)).toBe('quiet'); // one short of the floor
  });
});

describe('display', () => {
  it('floors the percentage, never rounds — coverage is never overstated', () => {
    expect(coveragePercent(meta(1000, 6))).toBe(99); // 99.4 → 99
    expect(coveragePercent(meta(3, 1))).toBe(66); // 66.67 → 66
  });

  it('clamps to 99: "read 100%" is unreachable while anything went unread', () => {
    expect(coveragePercent(meta(1000, 1))).toBe(99); // 99.9, floored to 99 anyway
    expect(coveragePercent(meta(100000, 1))).toBe(99); // 99.999 → would floor to 99…
    expect(coveragePercent(meta(1000, 0))).toBe(100);
    // …and a run whose only blindness is an unopened source is not 100% either.
    expect(coveragePercent({ coverage: { records: 500, unrecognized: 0, sourcesUnread: 1 } })).toBe(99);
  });

  it('sourcesUnread alone makes 100% unreachable and forces the quiet trigger', () => {
    const m = { coverage: { records: 500, unrecognized: 0, sourcesUnread: 1 } };
    expect(classifyCoverage(m, 0)).toBe('quiet');
    expect(coverageLabel(m)).toBe('read 99% of this run');
  });
});

describe('degradation', () => {
  it('absent coverage is unknown — never rendered, never inferred', () => {
    expect(coverageStats({})).toBe(null);
    expect(coveragePercent({})).toBe(null);
    expect(coverageLabel({})).toBe(null);
    expect(classifyCoverage({}, 0)).toBe('none');
    expect(classifyCoverage(undefined, 0)).toBe('none');
  });

  it('records === 0 is unknown, not 0% — an empty run is not a blind one', () => {
    expect(coverageStats(meta(0, 0))).toBe(null);
    expect(classifyCoverage(meta(0, 0), 0)).toBe('none');
  });

  it('unrecognized > records clamps to 0% read instead of throwing', () => {
    // Hermes can raise several complaints about one row (a tool_calls array of
    // six bad entries), so this is reachable, not merely defensive.
    const s = coverageStats(meta(10, 40));
    expect(s.unrecognized).toBe(10);
    expect(s.read).toBe(0);
    expect(coveragePercent(meta(10, 40))).toBe(0);
  });

  it('a malformed IR degrades toward silence, like deriveSignals', () => {
    for (const bad of [null, undefined, 42, { coverage: 'nope' }, { coverage: { records: 'x' } }]) {
      expect(classifyCoverage(bad, 0)).toBe('none');
      expect(coverageNote(bad, 'loud')).toBe(null);
    }
    expect(classifyCoverage(meta(100, 40), NaN)).toBe('loud');
  });

  it('strongerCoverage ranks the verdicts, and tolerates junk', () => {
    expect(strongerCoverage('none', 'quiet')).toBe('quiet');
    expect(strongerCoverage('loud', 'quiet')).toBe('loud');
    expect(strongerCoverage('quiet', 'loud')).toBe('loud');
    expect(strongerCoverage('quiet', 'none')).toBe('quiet');
    expect(strongerCoverage('quiet', undefined)).toBe('quiet');
  });
});

describe('the sticky rule', () => {
  // A live run's `unrecognized` only ever grows, but the VERDICT can flip to
  // 'none' the moment a signal lands, because quiet requires zero signals. The
  // app keeps the stronger of the two, so a caveat never retracts itself
  // mid-run — coverage did not improve, a different condition changed.
  const stick = (prev, meta, signals) => strongerCoverage(prev, classifyCoverage(meta, signals));

  it('a signal arriving on a later tick does not retract a shown badge', () => {
    const m = meta(1000, 50);
    let verdict = stick('none', m, 0);
    expect(verdict).toBe('quiet');
    verdict = stick(verdict, meta(1000, 52), 2); // next tick: signals appear
    expect(verdict).toBe('quiet');
  });

  it('but it still escalates: quiet becomes loud when coverage collapses', () => {
    expect(stick('quiet', meta(100, 60), 0)).toBe('loud');
  });

  it('a cold open of the same run lands on the same verdict', () => {
    expect(classifyCoverage(meta(1000, 50), 0)).toBe('quiet');
  });
});

describe('unknownTypes', () => {
  it('records a conforming type name verbatim', () => {
    const bag = {};
    tallyUnknownType(bag, 'atis-latch');
    tallyUnknownType(bag, 'atis-latch');
    tallyUnknownType(bag, 'event_msg:quantum_status');
    expect(bag).toEqual({ 'atis-latch': 2, 'event_msg:quantum_status': 1 });
  });

  it('buckets non-conforming type strings into `other`, never verbatim', () => {
    const bag = {};
    const long = 'x'.repeat(41);
    tallyUnknownType(bag, long);
    tallyUnknownType(bag, 'has spaces');
    tallyUnknownType(bag, '{"smuggled":"content"}');
    tallyUnknownType(bag, undefined);
    tallyUnknownType(bag, 12);
    expect(bag).toEqual({ other: 5 });
    expect(JSON.stringify(bag)).not.toContain(long);
    // 40 characters is fine; 41 is not.
    const ok = {};
    tallyUnknownType(ok, 'y'.repeat(40));
    expect(Object.keys(ok)).toEqual(['y'.repeat(40)]);
  });

  // The type string is chosen by whatever wrote the transcript. These names are
  // legal by the regex but poisonous as plain-object keys: `__proto__` reassigns
  // a prototype instead of storing a count, and `constructor`/`prototype` read
  // back a FUNCTION off the prototype chain that `+ 1` turns into a string
  // inside the IR. They fold into `other` like any other name the sanitizer
  // will not carry.
  it('folds prototype-hazard names instead of writing junk into the IR', () => {
    const bag = {};
    for (const name of ['__proto__', 'constructor', 'prototype']) tallyUnknownType(bag, name);
    expect(bag).toEqual({ other: 3 });
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype); // not reassigned
    for (const v of Object.values(bag)) expect(typeof v).toBe('number');
    expect(JSON.stringify(bag)).not.toContain('native code');
  });

  it('counts an inherited name as absent, not as a key it already holds', () => {
    // `key in bag` would say `toString` is already there and skip the budget.
    const bag = {};
    tallyUnknownType(bag, 'toString');
    tallyUnknownType(bag, 'toString');
    expect(bag.toString).toBe(2);
    expect(JSON.parse(JSON.stringify(bag))).toEqual({ toString: 2 });
  });

  it('sanitizes on the way OUT of a bundle too, not only on the way in', () => {
    // A bundle's ext bag was written by another machine; its keys are no more
    // trustworthy here than a raw transcript's are in the adapter.
    const hostile = { ext: { v: { unknownTypes: { constructor: 5, '__proto__': 9, ok: 2 } } } };
    const merged = unknownTypes(hostile);
    for (const v of Object.values(merged)) expect(typeof v).toBe('number');
    expect(merged.ok).toBe(2);
    expect(Object.getPrototypeOf(merged)).toBe(null);
    expect(unknownTypeSummary(hostile)).not.toContain('native code');
  });

  it('folds past 10 distinct keys, and never exceeds 10', () => {
    const bag = {};
    for (let i = 0; i < 30; i++) tallyUnknownType(bag, `type-${i}`);
    expect(Object.keys(bag).length).toBeLessThanOrEqual(10);
    expect(bag.other).toBeGreaterThan(0);
    const total = Object.values(bag).reduce((a, b) => a + b, 0);
    expect(total).toBe(30); // nothing is lost, only named
  });

  it('merges bags across files, re-applying the bounds', () => {
    const a = { 'atis-latch': 2 };
    mergeUnknownTypes(a, { 'atis-latch': 3, 'holo-recap': 1 });
    expect(a).toEqual({ 'atis-latch': 5, 'holo-recap': 1 });
    const capped = {};
    for (let i = 0; i < 12; i++) mergeUnknownTypes(capped, { [`t${i}`]: 1 });
    expect(Object.keys(capped).length).toBeLessThanOrEqual(10);
  });

  it('reads every ext bag by shape, so no adapter is named in shared code', () => {
    const m = {
      ext: { claudeCode: { unknownTypes: { 'atis-latch': 58 } }, hermes: { unknownTypes: { 'role:system': 2 } } },
    };
    expect(unknownTypes(m)).toEqual({ 'atis-latch': 58, 'role:system': 2 });
    expect(unknownTypeSummary(m)).toBe('atis-latch ×58, role:system ×2');
    expect(unknownTypes({})).toEqual({});
    expect(unknownTypes({ ext: { junk: 3, other: { unknownTypes: 'nope' } } })).toEqual({});
  });
});

describe('the MCP note', () => {
  const m = meta(1000, 50, { ext: { claudeCode: { unknownTypes: { 'atis-latch': 50 } } } });

  it('is factual on quiet', () => {
    expect(coverageNote(m, 'quiet')).toBe(
      "5% of this run's records could not be parsed (atis-latch ×50). Mention this if you characterize the run as a whole.",
    );
  });

  it('is imperative on loud, and reads differently', () => {
    const loud = meta(100, 38);
    const note = coverageNote(loud, 'loud');
    expect(note).toBe(
      'Only 62% of this run could be parsed. Say so before describing what the run did or did not do — do not call it clean.',
    );
    expect(note).not.toBe(coverageNote(m, 'quiet'));
  });

  it('is absent on none', () => {
    expect(coverageNote(m, 'none')).toBe(null);
    expect(coverageNote(meta(100, 0), 'none')).toBe(null);
  });

  it('names an unopened source rather than pretending it was a record', () => {
    const withSource = { coverage: { records: 500, unrecognized: 0, sourcesUnread: 2 } };
    expect(coverageNote(withSource, 'quiet')).toBe(
      '2 referenced transcripts could not be opened. Mention this if you characterize the run as a whole.',
    );
  });
});

describe('adapter record counts', () => {
  it('claude-code counts non-blank lines across the run’s whole file set', async () => {
    const ir = await irFor(SESSION_RUN_ID);
    // 45 session lines + 4 in the subagent transcript — coverage aggregates
    // across the run's whole file set, exactly as unrecognizedLineCount does.
    expect(ir.meta.coverage).toEqual({ records: 51, unrecognized: 2, sourcesUnread: 0 });
    expect(ir.meta.coverage.unrecognized).toBe(ir.meta.unrecognizedLineCount);
  });

  it('claude-code workflow runs count the journal plus every attempt file', async () => {
    const ir = await irFor(WORKFLOW_RUN_ID);
    expect(ir.meta.coverage.records).toBe(13); // 5 journal + 3+2+3 attempt lines
    expect(ir.meta.coverage.unrecognized).toBe(0);
  });

  it('codex aggregates child rollouts without double-counting the parent', async () => {
    const { detect: codexDetect, parse: codexParse } = await import('../src/adapters/codex/index.js');
    const codexRefs = await codexDetect([CODEX_FIXTURE_ROOT]);
    const { ir } = await codexParse(codexRefs.find((r) => r.runId === CODEX_SUBAGENT_RUN_ID));
    expect(ir.meta.coverage.records).toBe(57); // 29 parent + 18 child + 10 grandchild
    expect(ir.meta.coverage.unrecognized).toBe(ir.meta.unrecognizedLineCount);
    // A payload type the grammar does not know is qualified by its stream, so
    // an event and a response_item of the same name stay distinguishable.
    expect(ir.meta.ext.codex.unknownTypes).toEqual({ 'holo-sync': 1, 'event_msg:quantum_status': 1 });
  });
});

describe('atis-latch, recognized by shape', () => {
  it('a contentless latch is recognized: no node, and no coverage cost', async () => {
    const ir = await irFor(CLEAN_RUN_ID);
    expect(ir.meta.coverage.unrecognized).toBe(0);
    expect(ir.meta.ext?.claudeCode?.unknownTypes).toBeUndefined();
    expect(classifyCoverage(ir.meta, 0)).toBe('none');
    // Recognized ≠ rendered: it carries nothing, so it becomes no node.
    expect(ir.nodes.some((n) => /atis/i.test(n.label))).toBe(false);
  });

  it('a POPULATED latch falls through to unrecognized, by name, in the ext bag', async () => {
    const ir = await irFor(SESSION_RUN_ID);
    expect(ir.meta.ext.claudeCode.unknownTypes['atis-latch']).toBe(1);
  });
});

describe('a hostile type string is unread, never read and never fatal', () => {
  // The never-blank-screen rule and the coverage rule meet here: a line whose
  // `type` collides with Object.prototype must be COUNTED, not swallowed as
  // recognized (which would report 100% over content nobody read) and not
  // thrown on (which would take the whole run down).
  it('counts prototype-named record types and keeps parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rg-hostile-'));
    await cp(FIXTURE_ROOT, root, { recursive: true });
    const file = join(root, '-home-dev-acme', '33333333-3333-4333-8333-333333333333.jsonl');
    const { appendFile } = await import('node:fs/promises');
    for (const type of ['constructor', 'valueOf', 'toString', '__proto__']) {
      await appendFile(file, JSON.stringify({ type, sessionId: 'x' }) + '\n');
    }
    await pinTree(root);
    const localRefs = await detect([root]);
    const { ir } = await parse(
      localRefs.find((r) => r.sessionId === '33333333-3333-4333-8333-333333333333'),
    );
    expect(ir.meta.coverage.unrecognized).toBe(4); // all four unread, none swallowed
    expect(ir.nodes.length).toBeGreaterThan(3); // …and the rest of the run still parsed
    const bag = ir.meta.ext.claudeCode.unknownTypes;
    for (const v of Object.values(bag)) expect(typeof v).toBe('number');
    expect(JSON.stringify(bag)).not.toContain('native code');
    await rm(root, { recursive: true, force: true });
  });
});

describe('purity', () => {
  // The frontend bundle imports this file straight out of src/ so the badge the
  // human reads and the note the agent reads come from one classifier. A single
  // `node:` import would break the build — and would fail at build time, not
  // here, so assert it. Mirrors tests/find.test.js.
  it('src/coverage.js imports nothing, so the frontend bundle can consume it', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'coverage.js'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\(|['"]node:|process\./);
  });

  it('names no adapter — record-type vocabulary lives in the ext bags', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'coverage.js'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/claudeCode|claude-code|codex|hermes/i);
  });

  it('emptyCoverage is a fresh object every call', () => {
    const a = emptyCoverage();
    a.records = 5;
    expect(emptyCoverage()).toEqual({ records: 0, unrecognized: 0, sourcesUnread: 0 });
  });
});

describe('sourcesUnread, end to end', () => {
  it('a run with an unopenable agent transcript is never 100%', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rg-cov-'));
    await cp(FIXTURE_ROOT, root, { recursive: true });
    await rm(
      join(root, '-home-dev-acme', '11111111-1111-4111-8111-111111111111', 'subagents', 'agent-a123456789abcdef0.jsonl'),
    );
    await pinTree(root);
    const localRefs = await detect([root]);
    const { ir } = await parse(
      localRefs.find((r) => r.kind === 'session' && r.sessionId === '11111111-1111-4111-8111-111111111111'),
    );
    expect(ir.meta.coverage.sourcesUnread).toBe(1);
    expect(coveragePercent(ir.meta)).toBeLessThan(100);
    // Zero signals is the state this trigger exists for; this run has some, so
    // classify it the way a clean run of the same shape would be classified.
    expect(classifyCoverage(ir.meta, 0)).toBe('quiet');
    await rm(root, { recursive: true, force: true });
  });
});

async function pinTree(dir, when = new Date('2026-08-01T13:00:00Z')) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await pinTree(p, when);
    await utimes(p, when, when);
  }
  await utimes(dir, when, when);
}
