/**
 * Coverage — how much of a run rungraph could actually read.
 *
 * The signal layer answers "what went wrong in this run"; it can only ever
 * speak about records it parsed. Coverage answers the question underneath it:
 * "how much of this run did I see at all". Without it, a transcript that was
 * 40% unreadable renders exactly like a run that was read completely and found
 * clean — "nothing went wrong" and "I could not see part of this" collapse into
 * the same empty strip.
 *
 * ONE IMPLEMENTATION, per the shared-code rule: the badge the human reads and
 * the note the agent reads come from the same `classifyCoverage` call. Two
 * copies could disagree about whether a run is quiet or loud, which is the
 * exact failure this file exists to prevent.
 *
 * PURITY CONTRACT: no Node builtins, no imports at all — the same contract as
 * `src/find.js`, and for the same reason: the frontend bundle imports this file
 * straight out of `src/`, and a single `node:` import would break the build.
 * `tests/coverage.test.js` asserts it.
 *
 * VENDOR NEUTRALITY: nothing here names an adapter. Unknown record-type names
 * are vendor vocabulary, so they live in the namespaced `meta.ext.<adapter>`
 * bags and are read back by shape (`bag.unknownTypes`), never by vendor key.
 */

/**
 * Calibrated against the 2026-08-19 corpus measurement: 224 runs, 129k records
 * across three adapters, one real drift event.
 *
 * `loudRead` — the naive threshold is ~5%, and the measurement says it is
 * wrong. A single benign metadata type (`atis-latch`) already produced 6.45%
 * unread at zero cost to graph content, while a drift that actually removes
 * content (assistant/user records going unparseable) lands at 30–60% because
 * those are the bulk of every transcript. 0.75 sits ~4× above the worst benign
 * drift measured and well below "half the run is gone"; the benign class is
 * caught by the quiet trigger instead, which is the correct severity for it.
 *
 * HONEST LIMITATION: 4× headroom is measured on one machine containing exactly
 * one drift event. If a second benign drift is ever observed above 25% unread,
 * this number is wrong and must be RE-DERIVED, not nudged.
 *
 * `loudMinRecords` — A JUDGMENT CALL, NOT A CALIBRATION. No data constrains it;
 * it is recorded as a judgment so nobody later mistakes it for measurement. Its
 * only job is stopping tiny runs from shouting (the smallest run that can go
 * loud is ~34 records). It gave no protection in the drift that actually
 * occurred — 58 unrecognized, stopped by the rate gate instead — and that is
 * fine: the two gates cover different failures.
 */
export const COVERAGE = {
  /** Below this fraction of records read → loud. */
  loudRead: 0.75,
  /** …but only with at least this many unrecognized records. */
  loudMinRecords: 25,
};

/**
 * `obj.type` is written by whatever produced the transcript and is unvalidated
 * by definition — an unknown type is unknown. These bounds keep both the IR's
 * size and any chance of a transcript smuggling content through a type string
 * under control.
 *
 * DO NOT RELAX THIS ALPHABET. These names are interpolated into `coverageNote`,
 * which the MCP read tools hand straight to an agent as an instruction — so a
 * type string is untrusted input landing in a model's context. No whitespace
 * and a 40-character cap means an injected instruction cannot be written in it
 * at all. Allowing spaces "because it is just a type name" reopens that path,
 * and nothing downstream would catch it.
 */
export const UNKNOWN_TYPE_KEY_RE = /^[a-z0-9_.:-]{1,40}$/i;
export const MAX_UNKNOWN_TYPE_KEYS = 10;

/**
 * Names that are legal by the regex but hazardous as plain-object keys:
 * `__proto__` reassigns a prototype instead of storing a count, and
 * `constructor` / `prototype` read back a function from the prototype chain
 * that arithmetic then turns into a STRING inside the IR. A transcript chooses
 * these names, so they fold into `other` exactly like any other name the
 * sanitizer will not carry verbatim.
 */
const HAZARDOUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Verdict ordering — loud wins over quiet wins over none. Null-prototype so a
 *  junk verdict reads as `undefined`, never as an inherited function. */
const RANK = { __proto__: null, none: 0, quiet: 1, loud: 2 };

/** A zeroed counter set. Adapters seed this and count into it as they read. */
export function emptyCoverage() {
  return { records: 0, unrecognized: 0, sourcesUnread: 0 };
}

/**
 * Count one unrecognized record's type into a bag, sanitized.
 *
 * A percentage alone is unactionable: "read 95%, all of it one metadata type"
 * and "read 95%, and 400 assistant turns are missing" are the same number and
 * opposite emergencies.
 *
 * @param {Record<string, number>} bag  mutated in place
 * @param {unknown} type
 */
export function tallyUnknownType(bag, type) {
  if (!bag || typeof bag !== 'object') return bag;
  let key = safeKey(type);
  // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so every
  // inherited name would look like a key the bag already holds.
  if (key !== 'other' && !Object.hasOwn(bag, key)) {
    // The last slot is reserved for `other`, so folding always has somewhere
    // to go and the bag never exceeds MAX_UNKNOWN_TYPE_KEYS keys.
    const budget = MAX_UNKNOWN_TYPE_KEYS - (Object.hasOwn(bag, 'other') ? 0 : 1);
    if (Object.keys(bag).length >= budget) key = 'other';
  }
  bag[key] = count(bag, key) + 1;
  return bag;
}

/** A type name safe to carry verbatim, or `'other'`. */
function safeKey(type) {
  return typeof type === 'string' && UNKNOWN_TYPE_KEY_RE.test(type) && !HAZARDOUS_KEYS.has(type)
    ? type
    : 'other';
}

/** A bag's own count for a key — 0 for anything inherited or non-numeric. */
function count(bag, key) {
  if (!Object.hasOwn(bag, key)) return 0;
  const v = bag[key];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Fold one bag into another, re-applying the sanitizer's bounds. Adapters that
 * read several files aggregate exactly the way `unrecognizedLineCount` does.
 */
export function mergeUnknownTypes(target, extra) {
  if (!target || typeof target !== 'object') return target;
  for (const [k, v] of Object.entries(extra ?? {})) {
    for (let i = 0; i < (Number.isFinite(v) ? v : 0); i++) tallyUnknownType(target, k);
  }
  return target;
}

/**
 * Normalized coverage numbers, or `null` when coverage is unknown.
 *
 * Degradation rules (§11 of the design): absent coverage is unknown, never
 * complete. `records === 0` is unknown too — an empty run is not a blind one,
 * and there is no fraction to divide. `unrecognized > records` should be
 * impossible; it clamps rather than throwing.
 *
 * @param {{coverage?: {records?: number, unrecognized?: number, sourcesUnread?: number}}} meta
 * @returns {{records: number, unrecognized: number, sourcesUnread: number, read: number}|null}
 */
export function coverageStats(meta) {
  const c = meta?.coverage;
  if (!c || typeof c !== 'object') return null;
  const records = int(c.records);
  const sourcesUnread = int(c.sourcesUnread);
  if (records <= 0) return null;
  const unrecognized = Math.min(int(c.unrecognized), records);
  return { records, unrecognized, sourcesUnread, read: (records - unrecognized) / records };
}

/**
 * The percentage the badge shows, or `null` when coverage is unknown.
 *
 * FLOORED, never rounded, so coverage is never overstated — and clamped to 99
 * while anything at all went unread, because "read 100%" must be unreachable
 * with an unread record or an unopened source in the run.
 */
export function coveragePercent(meta) {
  const s = coverageStats(meta);
  if (!s) return null;
  let pct = Math.floor(s.read * 100);
  if (s.unrecognized > 0 || s.sourcesUnread > 0) pct = Math.min(pct, 99);
  return Math.max(0, Math.min(100, pct));
}

/**
 * The badge text. Identical for quiet and loud — the user learns one phrase and
 * reads its prominence, not two messages.
 */
export function coverageLabel(meta) {
  const pct = coveragePercent(meta);
  return pct == null ? null : `read ${pct}% of this run`;
}

/**
 * @param {object} meta  `ir.meta`
 * @param {number} signalCount  how many signals the run derived
 * @returns {'none'|'quiet'|'loud'}
 *
 * LOUD WINS: a run satisfying both tests is loud, never quiet, and a single
 * verdict comes back so no state can render both.
 *
 * Deliberately, a fully-read run with signals shows nothing, and so does a
 * lightly-drifted run with signals: the chips already say "look here", and
 * there is no implication of completeness to correct. The quiet trigger exists
 * for exactly the moment the UI would otherwise imply completeness.
 *
 * A malformed or partial IR lands on 'none' — mirroring how `deriveSignals`
 * degrades toward silence rather than toward false alarms.
 */
export function classifyCoverage(meta, signalCount = 0) {
  const s = coverageStats(meta);
  if (!s) return 'none';
  if (s.read < COVERAGE.loudRead && s.unrecognized >= COVERAGE.loudMinRecords) return 'loud';
  const n = Number.isFinite(signalCount) ? signalCount : 0;
  if ((s.unrecognized > 0 || s.sourcesUnread > 0) && n === 0) return 'quiet';
  return 'none';
}

/** The stronger of two verdicts — how a shown badge stays shown. */
export function strongerCoverage(a, b) {
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

/**
 * Unknown record types across every `ext` bag, merged. Read by SHAPE, never by
 * vendor key, so this file names no adapter.
 *
 * @returns {Record<string, number>}
 */
export function unknownTypes(meta) {
  // Null-prototype accumulator, and the same key sanitizer the adapters use:
  // a bundle's `ext` bags were written by another machine, so its keys are no
  // more trustworthy here than a raw transcript's are there.
  const out = { __proto__: null };
  const ext = meta?.ext;
  if (!ext || typeof ext !== 'object') return out;
  for (const bag of Object.values(ext)) {
    const t = bag && typeof bag === 'object' ? bag.unknownTypes : null;
    if (!t || typeof t !== 'object') continue;
    for (const [k, v] of Object.entries(t)) {
      if (!Number.isFinite(v) || v <= 0) continue;
      const key = safeKey(k);
      out[key] = count(out, key) + v;
    }
  }
  return out;
}

/** `"atis-latch ×58, other ×3"` — the biggest offenders first, or ''. */
export function unknownTypeSummary(meta, max = 3) {
  return Object.entries(unknownTypes(meta))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([k, v]) => `${k} ×${v}`)
    .join(', ');
}

/**
 * The line the MCP read tools hand the model, or `null` on 'none'.
 *
 * Fires on exactly the same verdicts as the badge, from the same
 * `classifyCoverage` call. Matching them is not tidiness: firing only on loud
 * would mean a 95% run shows the human a caveat and tells the agent nothing, so
 * the canvas and the terminal would disagree about the same run — the exact
 * failure server-side derivation exists to prevent, reintroduced by another
 * route.
 *
 * Prose and imperative, in the result body: models act on an instruction far
 * more reliably than on a bare numeric field they were never told to care
 * about, which is also why the field alone is not enough.
 */
export function coverageNote(meta, verdict) {
  const s = coverageStats(meta);
  if (!s || (verdict !== 'quiet' && verdict !== 'loud')) return null;
  const pct = coveragePercent(meta);
  const types = unknownTypeSummary(meta);
  const sources =
    s.sourcesUnread > 0
      ? `${s.sourcesUnread} referenced transcript${s.sourcesUnread === 1 ? '' : 's'} could not be opened`
      : '';

  if (verdict === 'loud') {
    let head = `Only ${pct}% of this run could be parsed${types ? ` (${types})` : ''}`;
    if (sources) head += `, and ${sources}`;
    return `${head}. Say so before describing what the run did or did not do — do not call it clean.`;
  }

  const parts = [];
  if (s.unrecognized > 0) {
    parts.push(`${100 - pct}% of this run's records could not be parsed${types ? ` (${types})` : ''}`);
  }
  if (sources) parts.push(sources);
  if (parts.length === 0) return null;
  return `${parts.join(', and ')}. Mention this if you characterize the run as a whole.`;
}

function int(v) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
