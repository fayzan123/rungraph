/**
 * Derived signals — the graph's opinion about a run.
 *
 * Pure over the Graph IR (SCHEMA.md): no adapter, no server, no I/O. It is
 * applied at every point an IR reaches a consumer (`cli.js`, `server.js`,
 * `watcher.js`) rather than in the frontend, so an agent answering in the
 * terminal and the canvas on screen can never disagree about what went wrong.
 *
 * GOVERNING RULE: precision over recall. A false flag costs more than a missed
 * one — the moment the user stops trusting the markers they are back to reading
 * the whole graph. A run with no trouble must derive exactly zero signals.
 *
 * @typedef {'retry-storm'|'unresolved-error'|'intervention'|'outlier'|'course-change'} SignalKind
 *
 * @typedef {Object} Signal
 * @property {string} id          Derived from stable node ids — never a counter.
 * @property {SignalKind} kind
 * @property {'high'|'info'} severity
 * @property {string[]} nodeIds   Never empty; every id exists in `ir.nodes`.
 * @property {string} label       Chip text, e.g. "6 failed Edit calls".
 * @property {string} reason      One sentence on why it matters.
 */

import { snippet } from './ir.js';

export const THRESHOLDS = {
  /** Failed calls on a single tool node that make it a storm by itself. */
  retryErrors: 3,
  /** Multiple of the run's median (tokens or duration) that counts as outsized. */
  outlierFactor: 3,
  // Absolute floors under `outlierFactor`, because in a six-node run everything
  // is 3× the median.
  //
  // CALIBRATED, not guessed: measured over 1,081 real nodes from 60 sessions in
  // ~/.claude/projects, a node's median cost is ~11k tokens / ~3.5 minutes, and
  // p90 is ~64k tokens / ~20 minutes. The first draft of these floors (12k /
  // 5 min) sat at roughly the median, which made them no floor at all — the 3×
  // factor was doing all the work and outliers fired on half of all runs. These
  // values sit near p90, so "outsized" means outsized for this machine's work,
  // not merely bigger than its neighbours.
  outlierMinTokens: 50000,
  outlierMinDurationMs: 900000,
};

/**
 * The tool family a node belongs to, recovered from its display label.
 *
 * Tool nodes carry no plain tool name in the IR — the adapter writes
 * "<ToolName> · <hint>", with " ×N" appended when N calls collapsed. Take the
 * head segment, drop the count.
 *
 * Display-derived heuristic, deliberately: an adapter that does not follow that
 * convention just gets exact-label matching, which groups strictly less and so
 * fires strictly fewer signals. Degrading toward silence is the right failure
 * mode for a feature whose only currency is trust.
 */
export function toolFamily(node) {
  const label = typeof node?.label === 'string' ? node.label : '';
  return label.split(' · ')[0].replace(/ ×\d+$/, '').trim();
}

/**
 * @param {import('./ir.js').GraphIR} ir
 * @returns {Signal[]} `high` before `info`, then by earliest position in the run.
 *   Tolerates a partial or malformed IR by deriving fewer signals — never throws.
 */
export function deriveSignals(ir) {
  const nodes = (Array.isArray(ir?.nodes) ? ir.nodes : []).filter(
    (n) => n && typeof n === 'object' && typeof n.id === 'string' && n.id,
  );
  if (nodes.length === 0) return [];
  const edges = Array.isArray(ir?.edges) ? ir.edges : [];

  const ordered = runOrder(nodes);
  const pos = new Map(ordered.map((n, i) => [n.id, i]));
  const lane = lanesOf(nodes, edges);
  const refused = humanRefused(nodes, edges);

  const out = [];
  const storms = retryStorms(ordered, lane, refused);
  out.push(...storms);
  // One place, one chip: a node inside a storm does not also get an
  // unresolved-error marker for the same failure.
  out.push(...unresolvedErrors(ordered, lane, idsOf(storms), refused));
  out.push(...interventions(ordered));

  const loud = idsOf(out.filter((s) => s.severity === 'high'));
  const hot = outliers(ordered);
  if (hot) out.push(hot);
  const moved = courseChanges(ordered, edges, pos, loud);
  if (moved) out.push(moved);

  const known = new Set(nodes.map((n) => n.id));
  return out
    .filter((s) => s.nodeIds.some((id) => known.has(id)))
    .map((s) => ({ s, at: Math.min(...s.nodeIds.map((id) => pos.get(id) ?? Infinity)) }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.at - b.at)
    .map((k) => k.s);
}

/**
 * Sets `ir.signals` and returns the same (mutated) object, so call sites can
 * write `attachSignals(await parse(...))`. Signals are an enhancement, never a
 * render dependency: a failure here costs the markers, not the graph.
 */
export function attachSignals(ir) {
  if (!ir || typeof ir !== 'object') return ir;
  try {
    ir.signals = deriveSignals(ir);
  } catch (err) {
    process.stderr.write(`rungraph: signal derivation failed — ${err?.message ?? err}\n`);
    ir.signals = [];
  }
  return ir;
}

// ---------------------------------------------------------------- the kinds

/**
 * retry-storm — the run failing repeatedly in one place. Either a single tool
 * node that failed `retryErrors` times, or consecutive same-family tool nodes
 * each carrying errors. One signal per storm, because a storm is a *location*
 * in the run, not a category of problem.
 */
function retryStorms(ordered, lane, refused) {
  const out = [];
  // Walk each FAMILY's own subsequence within a lane, not the whole tool
  // subsequence. Measured against real sessions, a spiral almost never looks
  // like back-to-back Edits: it looks like Edit fails → Read the file → Edit
  // fails → Read → Edit fails. The reads are the agent investigating, not the
  // loop resolving. Only another call of the same tool ends the storm.
  for (const family of groupBy(
    ordered.filter((n) => n.kind === 'tool'),
    (n) => laneFamilyKey(lane, n),
  ).values()) {
    let run = [];
    const flush = () => {
      const s = run.length > 0 ? stormFrom(run) : null;
      if (s) out.push(s);
      run = [];
    };
    for (const n of family) {
      if (!isStormNode(n) || refused.has(n.id)) flush();
      else run.push(n);
    }
    flush();
  }
  return out;
}

/**
 * A node that counts toward a storm: one where every collapsed call failed, or
 * one that failed `retryErrors` times by itself.
 *
 * The `status === 'error'` gate is the precision guard, and it is load-bearing.
 * Real sessions are full of "Bash ×24" nodes carrying two failures among
 * twenty-two successes — a test loop working normally. Calling that a retry
 * storm would burn the user's trust on the first run they opened.
 */
function isStormNode(n) {
  return errorsOf(n) > 0 && (n.status === 'error' || errorsOf(n) >= THRESHOLDS.retryErrors);
}

function stormFrom(run) {
  const errors = run.reduce((t, n) => t + errorsOf(n), 0);
  // A lone node has to have failed enough times to be a storm on its own; two
  // failing attempts at the same tool in a row are a storm however few times
  // each of them failed.
  if (run.length < 2 && errors < THRESHOLDS.retryErrors) return null;
  const family = toolFamily(run[0]) || 'tool';
  const where = run.length === 1 ? 'in a single step' : `across ${run.length} consecutive steps`;
  return {
    id: `sig:retry-storm:${run[0].id}`,
    kind: 'retry-storm',
    severity: 'high',
    nodeIds: run.map((n) => n.id),
    label: `${errors} failed ${family} call${s(errors)}`,
    reason: `${family} failed ${errors}× ${where}${onFiles(filesOf(run))}, so the run was retrying instead of making progress.`,
  };
}

/**
 * unresolved-error — a tool node whose every call failed and which is the last
 * of its family in its lane. Nothing came back to fix it, so whatever it was
 * doing is still broken at the end of the run.
 */
function unresolvedErrors(ordered, lane, covered, refused) {
  const last = new Map();
  for (const n of ordered) {
    if (n.kind !== 'tool') continue;
    last.set(laneFamilyKey(lane, n), n); // run order, so last wins
  }
  const out = [];
  for (const n of last.values()) {
    if (n.status !== 'error' || covered.has(n.id) || refused.has(n.id)) continue;
    const family = toolFamily(n) || 'tool';
    out.push({
      id: `sig:unresolved-error:${n.id}`,
      kind: 'unresolved-error',
      severity: 'high',
      nodeIds: [n.id],
      label: `unresolved ${family} error`,
      reason: `The last ${family} call in this lane failed${onFiles(filesOf([n]))} and nothing came back to fix it.`,
    });
  }
  return out;
}

const INTERVENTIONS = {
  denial: {
    severity: 'high',
    noun: ['denial', 'denials'],
    why: 'Permission was refused, so the run had to abandon that approach mid-flight.',
  },
  interrupt: {
    severity: 'high',
    noun: ['interrupt', 'interrupts'],
    why: 'The user cut the run off mid-turn — it was doing something they did not want.',
  },
  answer: {
    severity: 'info',
    noun: ['answered question', 'answered questions'],
    why: 'The run stopped to ask, and those answers steered everything after them.',
  },
  other: {
    severity: 'info',
    noun: ['intervention', 'interventions'],
    why: 'A person stepped into the run at this point.',
  },
};

/**
 * intervention — grouped by kind rather than per node, because denials cluster
 * (a refused parallel batch is five nodes) and the strip shows four chips.
 */
function interventions(ordered) {
  const byKind = groupBy(
    ordered.filter((n) => n.kind === 'human'),
    (n) => (Object.hasOwn(INTERVENTIONS, n.interventionKind) ? n.interventionKind : 'other'),
  );
  const out = [];
  for (const [kind, group] of byKind) {
    const spec = INTERVENTIONS[kind];
    const n = group.length;
    out.push({
      id: `sig:intervention:${kind}`,
      kind: 'intervention',
      severity: spec.severity,
      nodeIds: group.map((x) => x.id),
      label: `${n} ${spec.noun[n === 1 ? 0 : 1]}`,
      reason: `${n} ${spec.noun[n === 1 ? 0 : 1]} in this run. ${spec.why}`,
    });
  }
  return out;
}

/**
 * outlier — one signal for the whole run, never per node. The spec forbids
 * badging outliers on the canvas (in a large session the biggest node is
 * usually just the biggest node), and one chip keeps the strip honest.
 */
function outliers(ordered) {
  // Medians over only the nodes that carry the metric at all: half the nodes
  // having no token count must not drag the median to zero.
  const medTokens = median(ordered.map(tokensOf).filter((v) => v > 0));
  const medDuration = median(ordered.map(durationOf).filter((v) => v > 0));

  const ranked = [];
  for (const n of ordered) {
    const tk = tokensOf(n);
    const du = durationOf(n);
    const byTokens = medTokens > 0 && tk >= THRESHOLDS.outlierMinTokens ? tk / medTokens : 0;
    const byDuration =
      medDuration > 0 && du >= THRESHOLDS.outlierMinDurationMs ? du / medDuration : 0;
    const ratio = Math.max(byTokens, byDuration);
    if (ratio < THRESHOLDS.outlierFactor) continue;
    ranked.push({ n, ratio, metric: byTokens >= byDuration ? 'tokens' : 'runtime' });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.ratio - a.ratio); // stable, so ties keep run order
  const top = ranked[0];
  const rest = ranked.length - 1;
  return {
    id: 'sig:outlier',
    kind: 'outlier',
    severity: 'info',
    nodeIds: ranked.map((r) => r.n.id),
    label: `${ranked.length} outsized step${s(ranked.length)}`,
    reason: `“${snippet(top.n.label, 40)}” is ${Math.round(top.ratio)}× the run's median ${top.metric}${
      rest > 0 ? `, and ${rest} other step${s(rest)} run comparably hot` : ''
    }.`,
  };
}

/**
 * course-change — promotes existing `edge.reason` lineage and nothing else. No
 * speculative "it abandoned an approach" inference: the adapter either recorded
 * why the run moved or it did not.
 */
function courseChanges(ordered, edges, pos, loud) {
  const byId = new Map(ordered.map((n) => [n.id, n]));
  const picked = new Map();
  for (const e of edges) {
    const why = typeof e?.reason === 'string' ? e.reason.trim() : '';
    if (!why || !byId.has(e.to) || picked.has(e.to)) continue;
    // A reason landing on a node that is already badged high is nearly always
    // "after X error" — said louder, and in the right place, by that signal.
    if (loud.has(e.to)) continue;
    picked.set(e.to, why);
  }
  if (picked.size === 0) return null;
  const nodeIds = [...picked.keys()].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
  const distinct = [...new Set(nodeIds.map((id) => picked.get(id)))];
  const named = distinct
    .slice(0, 3)
    .map((r) => `“${snippet(r, 48)}”`)
    .join(', ');
  const subject = nodeIds.length === 1 ? 'this step' : `these ${nodeIds.length} steps`;
  return {
    id: 'sig:course-change',
    kind: 'course-change',
    severity: 'info',
    nodeIds,
    label: `${nodeIds.length} course change${s(nodeIds.length)}`,
    reason: `The run's own lineage explains ${subject}: ${named}${distinct.length > 3 ? ', and others' : ''}.`,
  };
}

// --------------------------------------------------------------- structure

/**
 * Nodes in run order: by `startedAt`, carried forward when absent, tie-broken by
 * index in `ir.nodes`. Deliberately identical to `orderedNodes` in
 * frontend/src/canvas.jsx — signal ordering and the canvas's j/k walk have to
 * agree on what "earlier" means or the ranked list reads out of sequence.
 */
function runOrder(nodes) {
  let lastT = 0;
  return nodes
    .map((n, i) => {
      const t = Date.parse(n.startedAt);
      if (Number.isFinite(t)) lastT = t;
      return { n, i, t: Number.isFinite(t) ? t : lastT };
    })
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((k) => k.n);
}

/**
 * Lane = the connected component of the `sequence` edge graph a node sits in —
 * the session backbone, or one workflow agent's own chain. Union-find over
 * sequence edges only; a node touched by none is a lane of one.
 *
 * @returns {Map<string, string>} node id → lane key
 */
function lanesOf(nodes, edges) {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const e of edges) {
    if (e?.kind !== 'sequence' || !parent.has(e.from) || !parent.has(e.to)) continue;
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b);
  }
  return new Map(nodes.map((n) => [n.id, find(n.id)]));
}

/**
 * Tool nodes whose "errors" are a person saying no — a denied or interrupted
 * call, which the adapter records as an error on the tool node and as a `human`
 * node right after it in the lane.
 *
 * Those must not read as retries or as unresolved failures. "The last Edit call
 * failed and nothing came back to fix it" is a lie about a call the user
 * refused, and the intervention signal already says the true thing, louder. The
 * first false flag is the one that costs the whole feature its credibility.
 *
 * @returns {Set<string>} node ids to exclude from retry-storm / unresolved-error
 */
function humanRefused(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set();
  for (const e of edges) {
    if (e?.kind !== 'sequence') continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || from.kind !== 'tool' || to?.kind !== 'human') continue;
    if (to.interventionKind === 'denial' || to.interventionKind === 'interrupt') out.add(from.id);
  }
  return out;
}

/**
 * Composite key for "this tool, in this lane".
 *
 * JSON rather than a delimiter: node ids and tool families both come from a
 * provider, so any separator character could in principle appear in one of them
 * and merge two lanes. The first version used a literal NUL byte to make that
 * impossible — which worked, and turned this file into "binary" as far as grep
 * and ripgrep are concerned, so searching it silently returned nothing. A
 * correctness trick that blinds every tool you use to read the code is a bad
 * trade.
 */
function laneFamilyKey(lane, node) {
  return JSON.stringify([lane.get(node.id), toolFamily(node)]);
}

// ----------------------------------------------------------------- helpers

const rank = (sig) => (sig.severity === 'high' ? 0 : 1);
const s = (n) => (n === 1 ? '' : 's');
const errorsOf = (n) => (Number.isFinite(n?.errorCount) && n.errorCount > 0 ? n.errorCount : 0);
const durationOf = (n) => (Number.isFinite(n?.durationMs) && n.durationMs > 0 ? n.durationMs : 0);

function tokensOf(n) {
  const t = n?.tokens;
  if (!t || typeof t !== 'object') return 0;
  const total = (Number(t.input) || 0) + (Number(t.output) || 0);
  return total > 0 ? total : 0;
}

function idsOf(signals) {
  const out = new Set();
  for (const sig of signals) for (const id of sig.nodeIds) out.add(id);
  return out;
}

/** De-duplicated `files[]` union across a group of nodes, in first-seen order. */
function filesOf(nodes) {
  const out = [];
  const seen = new Set();
  for (const n of nodes) {
    for (const f of Array.isArray(n?.files) ? n.files : []) {
      if (typeof f !== 'string' || !f || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/**
 * The " on token.js" clause of a reason. Basenames, not absolute paths: the
 * reason is display text and the full paths are right there in `node.files`.
 */
function onFiles(files) {
  if (files.length === 0) return '';
  if (files.length === 1) return ` on ${baseName(files[0])}`;
  return ` on ${baseName(files[0])} and ${files.length - 1} other file${s(files.length - 1)}`;
}

function baseName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(p);
}

function groupBy(items, key) {
  const out = new Map();
  for (const item of items) {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
