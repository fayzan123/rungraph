/**
 * Timeline — the run as a sequence of events, and the graph at event `n`.
 *
 * Replay is the canvas at a moment: a playhead over the run's events with the
 * canvas, inspector and strip all showing what had happened by then. This file
 * is the ONE place that says what "the run as a sequence" and "the graph at
 * event n" mean. The frontend imports it straight out of `src/` for local
 * scrubbing; `server.js` / `cli.js` / `mcp.js` import the same functions the
 * day an agent needs a timeline. Two copies could disagree about what "at
 * 14:02" means — that is the failure the rule prevents.
 *
 * It also absorbs the run-ordering rule (`runOrder`) that used to exist three
 * times over — `signals.js`, `canvas.jsx` and the landing page's run strip —
 * each with a comment saying it must stay identical to the others. Replay
 * would have been a fourth.
 *
 * PURITY CONTRACT: no Node builtins, no imports at all — the same contract as
 * `src/find.js` and `src/coverage.js`, and for the same reason: the frontend
 * bundle imports this file directly, and a single `node:` import would break
 * the build. `tests/timeline.test.js` asserts it. Every function tolerates a
 * null IR, non-array nodes/edges, nodes without ids and garbage timestamps —
 * replay is an enhancement, never a render dependency, so nothing here throws.
 *
 * PRECISION OVER RECALL applies to time too: no timing is ever invented. A
 * node without an end time has no end event and takes its final status on
 * arrival; a malformed `callOffsets` is ignored rather than repaired; a start
 * time that is missing is carried forward from the previous node — or, when
 * there is no previous node, taken from the next timed one — rather than
 * placed at epoch zero, because "materializes with its neighbour" is the
 * honest reading of "we do not know when", and 1970 is not.
 *
 * @typedef {Object} Event
 * @property {number} t          Milliseconds since epoch (0 throughout when no
 *                               node in the run carries a `startedAt`).
 * @property {string} nodeId
 * @property {'start'|'call'|'end'} kind
 * @property {number} [i]        `call` only: the call's index in the group, ≥ 1.
 *
 * @typedef {Object} NodeIndex
 * @property {number} startIdx           Index of the node's `start` event.
 * @property {number|null} endIdx        Index of its `end` event, or null when
 *                                       it has none.
 * @property {number[]} callIdxs         Indices of its `call` events, ascending.
 */

// --------------------------------------------------------------- ordering

/**
 * Nodes in run order: by `startedAt`, carried forward when absent, tie-broken
 * by index in `ir.nodes`. The tie-break is what makes the order total and
 * stable: agents and workflows are appended to the IR after the conversation
 * walk, so array order alone is wrong, and timestamps alone leave a parallel
 * batch unordered.
 *
 * ONE implementation, three consumers: the signal ranking, the canvas's j/k
 * walk, and the replay timeline. "Earlier" has to mean the same thing in all
 * three or the ranked list reads out of sequence against the walk.
 *
 * @param {Array<{startedAt?: string}>} nodes
 * @returns {Array} the same node objects, reordered. Non-array input → [].
 */
export function runOrder(nodes) {
  return orderKeys(nodes).map((k) => k.n);
}

/**
 * The sort keys behind `runOrder`, kept so `buildTimeline` can reuse the
 * carried-forward `t` for `start` events: the number a node was ORDERED by is
 * the number it materializes at, so starts are non-decreasing in run order by
 * construction rather than by a second, separately-maintained rule.
 *
 * The carry runs in ARRAY order, not sorted order, on purpose — it is the
 * rule the three old copies implemented, and the extraction test pins it.
 * Both readings agree on where an untimed node lands: it takes the time of
 * the last timed node before it in the array, and that node sorts ahead of it
 * (earlier index, same `t`), so "its predecessor in run order" has that `t`.
 */
function orderKeys(nodes) {
  if (!Array.isArray(nodes)) return [];
  let lastT = 0;
  return nodes
    .map((n, i) => {
      const t = Date.parse(n?.startedAt);
      if (Number.isFinite(t)) lastT = t;
      return { n, i, t: Number.isFinite(t) ? t : lastT };
    })
    .sort((a, b) => a.t - b.t || a.i - b.i);
}

/** The nodes an IR actually has: objects with a non-empty string id — the same filter `deriveSignals` applies. */
function nodesOf(ir) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  return nodes.filter((n) => n && typeof n === 'object' && typeof n.id === 'string' && n.id);
}

// ------------------------------------------------------------- callOffsets

/**
 * A tool node's `callOffsets`, or null when it has none worth trusting.
 *
 * VALID means every invariant SCHEMA.md states for the field: an array whose
 * length is the node's `callCount`, at least two entries (a single-call node
 * carries nothing — call 0 IS the start), every entry a finite number ≥ 0,
 * `[0] === 0`, non-decreasing. Anything else is treated as ABSENT, never
 * partially used: a malformed list must not desynchronise the `×k` count from
 * the calls the node actually collapsed (spec §9). A list with the wrong
 * length would leave the counter short or over; a decreasing one would make
 * the count go backwards while the playhead goes forwards.
 *
 * @param {object} node
 * @returns {number[]|null}
 */
export function validCallOffsets(node) {
  const offs = node?.callOffsets;
  if (!Array.isArray(offs) || offs.length < 2) return null;
  if (offs.length !== node.callCount) return null;
  if (offs[0] !== 0) return null;
  for (let i = 0; i < offs.length; i++) {
    const v = offs[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    if (i > 0 && v < offs[i - 1]) return null;
  }
  return offs;
}

// ---------------------------------------------------------------- timeline

// Within one node, at one instant, this is the order events read in. It is
// the LAST sort key: `t` first, then the node's run-order position, then this.
// Position before kind is what lets a turn that ends at the exact instant the
// next one begins read "A ends, B starts" — A is earlier in run order, so all
// of A's events at that instant precede all of B's — and what guarantees a
// node's own end never sorts ahead of its own start.
const KIND_RANK = { start: 0, call: 1, end: 2 };

/**
 * The run as a sorted event list. Built ONCE per graph (`useMemo` on the IR
 * in the frontend, together with `indexEvents`); never per frame.
 *
 * - `start` — every node gets exactly one, at its `startedAt` or the
 *   carried-forward time when that is absent or unparseable; a LEADING
 *   untimed node, which has nothing to carry from, materializes with the
 *   first timed node instead (`raiseLeadingUntimed`).
 * - `call` — one per call i ≥ 1 of a tool group with a valid `callOffsets`, at
 *   `start.t + callOffsets[i]`. Call 0 is the start. A node without the field
 *   has no call events and appears whole.
 * - `end` — at `endedAt`; else at `startedAt + durationMs` when BOTH are real;
 *   else there is no end event. The duration fallback needs the node's own
 *   parsed `startedAt`, not the carried-forward one — a duration hung off a
 *   borrowed start would be an invented end. An end earlier than its start is
 *   contradictory data and is dropped rather than reordered.
 *
 * @param {import('./ir.js').GraphIR} ir
 * @returns {Event[]}
 */
export function buildTimeline(ir) {
  const keys = orderKeys(nodesOf(ir));
  raiseLeadingUntimed(keys);
  const out = [];
  keys.forEach(({ n, t }, pos) => {
    out.push({ t, nodeId: n.id, kind: 'start', pos, rank: 0, i: 0 });

    const offs = n.kind === 'tool' ? validCallOffsets(n) : null;
    if (offs) {
      for (let i = 1; i < offs.length; i++) {
        out.push({ t: t + offs[i], nodeId: n.id, kind: 'call', pos, rank: 1, i });
      }
    }

    const endT = endTimeOf(n);
    if (endT !== null && endT >= t) {
      out.push({ t: endT, nodeId: n.id, kind: 'end', pos, rank: 2, i: 0 });
    }
  });
  out.sort((a, b) => a.t - b.t || a.pos - b.pos || a.rank - b.rank || a.i - b.i);
  // The sort keys were scaffolding; the published Event carries only what the
  // contract names, and `i` only on calls, so an event's shape says its kind.
  return out.map((e) =>
    e.kind === 'call' ? { t: e.t, nodeId: e.nodeId, kind: e.kind, i: e.i } : { t: e.t, nodeId: e.nodeId, kind: e.kind },
  );
}

/**
 * A LEADING untimed node has no predecessor to materialize with. The carry in
 * `orderKeys` starts at 0, which is the right SORT KEY — it puts the node
 * first, and the extraction test pins that order — but the wrong INSTANT: a
 * `start` at epoch zero hands `schedule()` a 56-year span, so a real
 * 30-minute run plays at the floor in two seconds and the readout says 1970.
 * It is not a hypothetical: a live claude-code workflow's root carries no
 * `startedAt` until its manifest is written, and it is first in the IR.
 *
 * Such a node materializes with its SUCCESSOR — the first node in run order
 * that has a real time — the mirror of the carry-forward rule and the same
 * honest reading of "we do not know when". Nothing about the order changes:
 * the sort already happened, and the raised `t` equals the successor's, so
 * `t` stays non-decreasing by construction (every leading key sits at the
 * carry's initial 0, which is never above a real time). With no timed node
 * anywhere there is nothing to raise to, and the run stays at `t = 0`
 * throughout (spec §9's first row).
 *
 * Mutates the keys in place; they are `buildTimeline`'s own scaffolding.
 */
function raiseLeadingUntimed(keys) {
  const first = keys.findIndex((k) => Number.isFinite(Date.parse(k.n?.startedAt)));
  if (first <= 0) return;
  for (let i = 0; i < first; i++) keys[i].t = keys[first].t;
}

/** When the node ended, in epoch ms — or null when nothing on it says. */
function endTimeOf(n) {
  const ended = Date.parse(n.endedAt);
  if (Number.isFinite(ended)) return ended;
  const started = Date.parse(n.startedAt);
  const dur = n.durationMs;
  if (Number.isFinite(started) && typeof dur === 'number' && Number.isFinite(dur) && dur >= 0) {
    return started + dur;
  }
  return null;
}

/**
 * Per-node lookup over a built timeline, precomputed once per graph so
 * `stateAt` never walks the event list.
 *
 * @param {Event[]} events
 * @returns {{ byNode: Map<string, NodeIndex> }}
 */
export function indexEvents(events) {
  const byNode = new Map();
  const list = Array.isArray(events) ? events : [];
  const started = new Set();
  for (let idx = 0; idx < list.length; idx++) {
    const e = list[idx];
    if (!e || typeof e !== 'object' || typeof e.nodeId !== 'string') continue;
    let entry = byNode.get(e.nodeId);
    if (!entry) {
      // A hand-built list can lead with a call or an end; buildTimeline never
      // does. The first sighting stands in for the start until a real one
      // arrives, so a node is never "present before its first event".
      entry = { startIdx: idx, endIdx: null, callIdxs: [] };
      byNode.set(e.nodeId, entry);
    }
    if (e.kind === 'start') {
      if (!started.has(e.nodeId)) {
        started.add(e.nodeId);
        entry.startIdx = idx;
      }
    } else if (e.kind === 'call') {
      entry.callIdxs.push(idx);
    } else if (e.kind === 'end') {
      entry.endIdx = idx;
    }
  }
  return { byNode };
}

// ------------------------------------------------------------------ state

/**
 * `cursor` is "the number of events that have happened": an integer in
 * [0, events.length]. Anything else clamps; a non-number reads as "all of
 * them", which is the graph as it renders today — replay degrades toward
 * the current rendering, never toward an empty canvas.
 */
function clampCursor(cursor, n) {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return n;
  return Math.min(n, Math.max(0, Math.floor(cursor)));
}

/** Index of the first entry ≥ `x` in an ascending number array (lower bound). */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The graph at `cursor`.
 *
 * O(nodes + edges) per call, never O(events): a 10 000-event run costs the
 * same per frame as a 500-event one. The one per-node loop that touches a
 * call list is a binary search over its ascending indices, so a `Bash ×500`
 * costs nine comparisons, not five hundred.
 *
 * INVARIANT: `stateAt(ir, events, events.length)` reproduces the graph exactly
 * as it renders today — every node present, every status the node's own,
 * every count full, every edge drawn. That is the guard that replay-closed
 * changes nothing, and it is the first test in `tests/timeline.test.js`.
 *
 * @param {import('./ir.js').GraphIR} ir
 * @param {Event[]} events
 * @param {number} cursor
 * @param {{ byNode: Map<string, NodeIndex> }} [index]  from `indexEvents`; pass
 *   the memoized one — the default rebuilds it, which is O(events).
 * @returns {{
 *   cursor: number,
 *   present: Set<string>,
 *   status: Map<string, import('./ir.js').NodeStatus>,
 *   callsShown: Map<string, number>,
 *   edgePresent: Set<string>,
 * }}
 */
export function stateAt(ir, events, cursor, index = indexEvents(events)) {
  const n = Array.isArray(events) ? events.length : 0;
  const c = clampCursor(cursor, n);
  const byNode = index?.byNode instanceof Map ? index.byNode : new Map();
  // A node the timeline never saw counts as present: the renderer showed it
  // yesterday, and a replay that hid it would be a regression, not a moment.
  const isPresent = (id) => {
    const e = byNode.get(id);
    return e ? e.startIdx < c : true;
  };

  const present = new Set();
  const status = new Map();
  const callsShown = new Map();
  for (const node of nodesOf(ir)) {
    if (!isPresent(node.id)) continue;
    present.add(node.id);
    const e = byNode.get(node.id);
    // Running while its end is still ahead. A node that has no end event, or
    // is `running` in the IR, keeps its own status: a live run looks live at
    // every moment past its start.
    const running = e !== undefined && e.endIdx !== null && e.endIdx >= c;
    status.set(node.id, running ? 'running' : node.status);
    if (node.kind === 'tool') {
      // Validity was decided ONCE, in buildTimeline: a valid list has ≥ 2
      // entries, so it always produced at least one call event, and a
      // malformed one produced none. Reading that back keeps this loop free
      // of the O(callCount) re-validation that would make a frame cost scale
      // with the call-event count after all.
      const counted = e !== undefined && e.callIdxs.length > 0;
      callsShown.set(node.id, counted ? 1 + lowerBound(e.callIdxs, c) : node.callCount ?? 1);
    }
  }

  const edgePresent = new Set();
  const edges = Array.isArray(ir?.edges) ? ir.edges : [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object' || typeof edge.id !== 'string') continue;
    const both = isPresent(edge.from) && isPresent(edge.to);
    if (edge.kind === 'return') {
      // A result arrow drawn the instant a subagent spawns would be the
      // replay-time equivalent of badging a storm before it was one: the
      // return exists once the child's END has happened. A child with no end
      // event at all falls back to both-ends-present rather than never drawing.
      const from = byNode.get(edge.from);
      const shown = from && from.endIdx !== null ? from.endIdx < c : both;
      if (shown) edgePresent.add(edge.id);
    } else if (both) {
      // `sequence`, `spawn`, and any kind this file has not heard of.
      edgePresent.add(edge.id);
    }
  }
  return { cursor: c, present, status, callsShown, edgePresent };
}

// ----------------------------------------------------------------- reveal

/**
 * The event index at which a set of nodes is COMPLETE: the max over the known
 * ids of the node's end, or its start where it has no end. −1 when none of
 * the ids is in the index — a set that cannot be positioned on the timeline
 * degrades to "always shown", which is how it renders today.
 *
 * @param {string[]} nodeIds
 * @param {{ byNode: Map<string, NodeIndex> }} index
 * @returns {number}
 */
export function completionIndexOf(nodeIds, index) {
  const byNode = index?.byNode instanceof Map ? index.byNode : new Map();
  let max = -1;
  for (const id of Array.isArray(nodeIds) ? nodeIds : []) {
    const e = byNode.get(id);
    if (!e) continue;
    const at = e.endIdx !== null ? e.endIdx : e.startIdx;
    if (at > max) max = at;
  }
  return max;
}

/**
 * When a signal becomes visible: the moment its evidence is complete. It is
 * shown iff `revealIndexOf(signal, index) < cursor` — the same comparison
 * presence uses. ONE rule for every kind, clustered interventions included:
 * a "3 denials" chip appears at the third, because at the first the count is
 * not yet true, and a label the strip re-derived on the client would be a
 * statement the server never made. Nothing is re-derived here — only revealed.
 *
 * @param {{nodeIds?: string[]}} signal
 * @param {{ byNode: Map<string, NodeIndex> }} index
 * @returns {number}
 */
export function revealIndexOf(signal, index) {
  return completionIndexOf(signal?.nodeIds, index);
}

// ------------------------------------------------------------ time ↔ cursor

/**
 * The cursor for a timestamp. The playhead's stable identity is a TIMESTAMP,
 * never an index: indices shift under a live re-parse (a truncated line
 * re-read moves a group's id, a new subagent lane inserts events); a
 * timestamp does not. Deep links carry `t=`, and the app re-derives the
 * cursor from it on every graph change.
 *
 * `k` addresses a position INSIDE a tie group. Real runs have many events at
 * one millisecond — a parallel batch, a Hermes `[0, 0, 0]` — and a timestamp
 * alone cannot say "the third of them", yet stepping must stay one event.
 * The default `k = Infinity` is the spec's "count of events with t ≤ T"
 * reading, which is what a deep link means.
 *
 * Binary search over `t`: the list is sorted by construction.
 *
 * @param {Event[]} events
 * @param {number} t
 * @param {number} [k]
 * @returns {number} in [0, events.length]; a non-finite `t` reads as the end.
 */
export function cursorForTime(events, t, k = Infinity) {
  const list = Array.isArray(events) ? events : [];
  if (typeof t !== 'number' || !Number.isFinite(t)) return list.length;
  // A cursor is an integer; a fractional `k` (a hand-edited URL) must not
  // produce one. Infinity stays Infinity — it is the deep-link reading.
  const kk = typeof k === 'number' && !Number.isNaN(k) ? Math.max(0, Number.isFinite(k) ? Math.floor(k) : k) : Infinity;
  const lb = lowerBoundT(list, t);
  const ub = upperBoundT(list, t);
  return Math.min(list.length, Math.max(0, lb + Math.min(kk, ub - lb)));
}

/**
 * The inverse: the timestamp a cursor sits at, plus its position `k` inside
 * that timestamp's tie group. Round-trip law, asserted over every corpus:
 * `cursorForTime(events, r.t, r.k) === cursor` for every cursor.
 *
 * @param {Event[]} events
 * @param {number} cursor
 * @returns {{ t: number, k: number }}
 */
export function timeAtCursor(events, cursor) {
  const list = Array.isArray(events) ? events : [];
  const c = clampCursor(cursor, list.length);
  if (c === 0) return { t: list[0]?.t ?? 0, k: 0 };
  const t = list[c - 1].t;
  return { t, k: c - lowerBoundT(list, t) };
}

/** First index whose `t` ≥ x. */
function lowerBoundT(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]?.t < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose `t` > x. */
function upperBoundT(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]?.t <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// --------------------------------------------------------------- playback

/** A finite number ≥ `min`, or the default — options come from UI code and URLs. */
function num(v, dflt, min) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : dflt;
}

/**
 * The playback schedule for an event list: how long to wait before each next
 * event. Play is a TIME-LAPSE at a fixed speed, not a run squeezed into a
 * fixed length. The first cut targeted 30 s for every run, and that made a
 * five-minute session crawl while an hour-long one blurred past — neither
 * pace was the run's own (Fayzan, 2026-08-24). At `speed`× real time:
 *
 * - `raw[i] = min(gapCapMs, max(0, (t[i+1] − t[i]) / speed))` — the compressed
 *   gap, CAPPED but not floored: a ten-minute idle stretch is 1.5 s of the
 *   play, and a parallel batch is 0.
 * - `delays[i] = max(floorMs, raw[i])` — the per-event delay. The floor is
 *   what keeps a burst readable: fourteen calls at one millisecond animate as
 *   fourteen visible frames instead of one, and tool calls two seconds apart
 *   play at about three a second rather than thirty.
 * - The rate toggle scales the whole tick (`tickAfter`): 2× is 120× real time
 *   with the floor and the cap halved — the same frames, half the wait.
 *
 * Play length therefore scales with the run: a five-minute session plays in
 * seconds, an hour-long one in about a minute at 1×, and the user picks the
 * speed. There is no stride — nothing is ever skipped to hit a length; a run
 * that is long to watch is long because it was long. `stride` stays in the
 * shape at 1 because `tickAfter` still honours it for a caller that wants it.
 *
 * CALIBRATION of the defaults (2026-08-24): 60× so a typical Claude Code
 * cadence — a tool call every 5–20 s — lands at 80–330 ms an event, the floor
 * taking the dense end and the compression the sparse; the demo run (100
 * events over 29 minutes) plays in about 40 s at 1× and 20 s at 2×.
 *
 * @param {Event[]} events
 * @param {{ speed?: number, gapCapMs?: number, floorMs?: number }} [opts]
 * @returns {{
 *   speed: number, raw: number[], delays: number[], stride: 1,
 *   totalMs: number, floorMs: number, gapCapMs: number, n: number,
 * }}
 */
export function schedule(events, { speed = 60, gapCapMs = 1500, floorMs = 300 } = {}) {
  const list = Array.isArray(events) ? events : [];
  // A speed under real time would be slow motion; a negative floor or cap is
  // meaningless. Defaults, not throws — see the file header.
  const spd = num(speed, 60, 1);
  const cap = num(gapCapMs, 1500, 0);
  const floor = num(floorMs, 300, 0);
  const n = list.length;
  const tAt = (i) => (typeof list[i]?.t === 'number' && Number.isFinite(list[i].t) ? list[i].t : 0);
  const raw = [];
  const delays = [];
  let totalMs = 0;
  for (let i = 0; i + 1 < n; i++) {
    const r = Math.min(cap, Math.max(0, (tAt(i + 1) - tAt(i)) / spd));
    raw.push(r);
    const d = Math.max(floor, r);
    delays.push(d);
    totalMs += d;
  }
  return { speed: spd, raw, delays, stride: 1, totalMs, floorMs: floor, gapCapMs: cap, n };
}
/**
 * The next playback tick from `cursor`: where the playhead goes and how long
 * to wait before it does. Playing is the loop
 *
 *     { cursor, delayMs, done } = tickAfter(sched, cursor, rate)
 *     setTimeout(delayMs) → advance to cursor → repeat until done
 *
 * The delay is the sum of the RAW (unfloored) gaps the tick crosses, floored
 * once — with the schedule's stride of 1 that is `delays[cursor − 1] / rate`;
 * from cursor 0 the first tick fires after the floor, because there is no gap
 * before the first event. `rate` scales the whole tick — floor and cap
 * included — so 2× is 120× real time: the same frames, half the wait.
 *
 * @param {ReturnType<typeof schedule>} sched
 * @param {number} cursor
 * @param {number} [rate]
 * @returns {{ cursor: number, delayMs: number, done: boolean }}
 */
export function tickAfter(sched, cursor, rate = 1) {
  const raw = Array.isArray(sched?.raw) ? sched.raw : null;
  // `n` is the event count the schedule was built for. A schedule built from
  // zero events has nothing to play; `raw.length + 1` is the fallback for a
  // hand-built schedule that did not record it.
  const n = raw === null ? 0 : typeof sched.n === 'number' && sched.n >= 0 ? sched.n : raw.length + 1;
  const c = clampCursor(cursor, n);
  const stride = Math.max(1, Math.floor(num(sched?.stride, 1, 1)));
  const next = Math.min(n, c + stride);
  if (next === c) return { cursor: c, delayMs: 0, done: true };
  const floor = num(sched?.floorMs, 300, 0);
  const r = num(rate, 1, Number.MIN_VALUE);
  let sum = 0;
  for (let i = Math.max(0, c - 1); i <= next - 2; i++) sum += num(raw[i], 0, 0);
  return { cursor: next, delayMs: Math.max(floor, sum) / r, done: next === n };
}
