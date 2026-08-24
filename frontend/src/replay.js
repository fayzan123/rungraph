/**
 * Replay — the playhead's state transitions and the bar's derived values.
 *
 * Exactly one value lives in App, the FocusSet pattern applied to time:
 *
 *   replay: null                    // closed — renders EXACTLY as today
 *         | { mode: 'edge' }        // open, pinned to the newest event
 *         | { mode: 'at', t, k? }   // open, detached at a moment
 *
 * Every consumer — canvas, inspector, strip, minimap, the bar — derives what
 * it shows from `stateAt()` over ONE cursor that this file derives from that
 * value, so no two of them can describe different moments. Every transition
 * App makes goes through a function here rather than through a literal in a
 * handler, so "opening lands in edge" and "a seek is an `at` that round-trips
 * its cursor" are each decided once and are unit-testable without a DOM.
 *
 * The playhead's stored identity in `at` mode is a TIMESTAMP plus a tie-group
 * ordinal (`k`), never an event index: a live re-parse renumbers events (a
 * truncated line re-read, a new subagent lane) and an index would drift under
 * it; a timestamp does not. `edge` is a MODE rather than a stored timestamp
 * for the mirror reason — the newest event needs no re-derivation because it
 * is the newest by definition.
 *
 * Pure: no preact, no DOM. Imports only the timeline module, the same way
 * focus.js imports find.js.
 */

import {
  buildTimeline,
  indexEvents,
  schedule,
  tickAfter,
  cursorForTime,
  timeAtCursor,
  completionIndexOf,
  revealIndexOf,
} from '../../src/timeline.js';

const EMPTY_INDEX = () => ({ byNode: new Map() });

/** An integer in [0, n] — a cursor is "how many events have happened". */
function clamp(cursor, n) {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return n;
  return Math.min(n, Math.max(0, Math.floor(cursor)));
}

/**
 * The timeline for a graph, or the reason there is none. Built ONCE per
 * graph (`useMemo` in App), never per frame.
 *
 * `timeline.js` is written never to throw, but replay is an enhancement and
 * never a render dependency (spec §9): a run whose timeline cannot be built
 * disables the header button with the reason in its title, and the graph,
 * signals and focus render exactly as before. The try/catch is that promise
 * kept at the one place the timeline is produced.
 *
 * `timed` says whether ANY node carries a real `startedAt`. Without one the
 * events all sit at t = 0 (spec §9's first row): the bar still steps node by
 * node, but the clock readout shows `—` rather than 1970.
 *
 * @param {import('../../src/ir.js').GraphIR} ir
 * @returns {{ events: object[], index: {byNode: Map}, sched: object|null, timed: boolean, error: string|null }}
 */
export function safeTimeline(ir) {
  try {
    const events = buildTimeline(ir);
    const index = indexEvents(events);
    const sched = schedule(events);
    const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
    const timed = nodes.some((n) => Number.isFinite(Date.parse(n?.startedAt)));
    return { events, index, sched, timed, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { events: [], index: EMPTY_INDEX(), sched: null, timed: false, error };
  }
}

/**
 * The cursor for a replay value. Closed and `edge` are both "every event has
 * happened" — the graph as it renders today — which is the identity guard
 * `stateAt` pins. `at` re-derives from its timestamp on every call, so a
 * re-parse that moved events under the playhead never moves the playhead;
 * past the new edge it clamps to the edge. A mode this file has not heard of
 * degrades to the end, never to an empty canvas.
 *
 * @param {null|{mode:string,t?:number,k?:number}} replay
 * @param {object[]} events
 * @returns {number}
 */
export function cursorOf(replay, events) {
  const n = Array.isArray(events) ? events.length : 0;
  if (!replay || replay.mode !== 'at') return n;
  return cursorForTime(events, replay.t, replay.k ?? Infinity);
}

/**
 * Opening always lands in `edge`. On a finished run that is simply "the end";
 * on a live run it is the newest event with follow engaged. One opening rule,
 * and "at the end" and "pinned to the edge" are the same state — so a play
 * that runs off the end (`applyTick`) and the `live` button both produce
 * exactly this and there is no second way to be at the end.
 */
export function openReplay() {
  return { mode: 'edge' };
}

/**
 * Detach at a cursor. Stores the moment as { t, k } — the timestamp of the
 * event just before the cursor and its ordinal within the events sharing
 * that millisecond — so `cursorOf` round-trips it exactly and a step stays
 * one event through a parallel batch. Drag, scrubber click, marker click,
 * ⏮, `←`/`→` and the agent hook all end here.
 *
 * @param {object[]} events
 * @param {number} cursor  clamped into [0, events.length]
 */
export function seekTo(events, cursor) {
  return { mode: 'at', ...timeAtCursor(events, cursor) };
}

/**
 * One event in either direction, clamped at both ends. Never `stride` —
 * stepping is the user reading the run one event at a time; only playback
 * consults the schedule.
 *
 * A step that does not move returns the value UNCHANGED. `→` at the edge
 * used to hand back an `at` at the same cursor — nothing had moved, but
 * `at` means "detached", so the live follow disengaged and the bar's `live`
 * went dark for a keypress that did nothing, and events arriving after it
 * appended past a playhead that no longer followed. Same rule at 0 for `←`:
 * an equal `at` would only re-render.
 *
 * @param {null|object} replay
 * @param {object[]} events
 * @param {number} dir  +1 / −1
 */
export function stepFrom(replay, events, dir) {
  const n = Array.isArray(events) ? events.length : 0;
  const d = typeof dir === 'number' && Number.isFinite(dir) ? Math.trunc(dir) : 0;
  const c = cursorOf(replay, events);
  const next = clamp(c + d, n);
  return next === c ? replay : seekTo(events, next);
}

/**
 * Plan the next play tick from wherever the playhead is now. Playing is the
 * loop `plan → setTimeout(delayMs) → applyTick → repeat until done`; the
 * App's effect reads `replay` from a ref so a seek made mid-play (a marker
 * click) is where the next tick continues from.
 *
 * @returns {{ cursor: number, delayMs: number, done: boolean }}
 */
export function planTick(replay, events, sched, rate) {
  return tickAfter(sched, cursorOf(replay, events), rate);
}

/**
 * The replay value a planned tick lands on. Reaching the end hands back to
 * `edge`: on a finished run that is "the end"; on a live run it is the
 * newest event, and the CALLER re-engages the live follow (`setFollow(true)`)
 * — this module cannot, because follow is canvas state, not playhead state.
 *
 * @param {object[]} events
 * @param {{cursor:number, done:boolean}} tick  from `planTick`
 */
export function applyTick(events, tick) {
  return tick?.done ? openReplay() : seekTo(events, tick?.cursor);
}

/**
 * The node the playhead is on: the one whose event happened last. Null at
 * cursor 0 — nothing has happened, so nothing is selected — which is why the
 * App's selection-follows-cursor rule deselects there instead of pointing at
 * the first node before it exists.
 *
 * @param {object[]} events
 * @param {number} cursor
 * @returns {string|null}
 */
export function currentNodeId(events, cursor) {
  const list = Array.isArray(events) ? events : [];
  const c = clamp(cursor, list.length);
  return c > 0 ? (list[c - 1]?.nodeId ?? null) : null;
}

/**
 * The signals that have been REVEALED by `cursor`: those whose evidence is
 * complete (`revealIndexOf` — a storm at its last node's end, a "3 denials"
 * chip at the third). Nothing is re-derived and no label changes; the
 * server's opinion is only shown later. A signal that cannot be positioned
 * (reveal −1: none of its nodes on the timeline) stays shown at every cursor,
 * which is how it renders today. The strip, the canvas badges and the
 * inspector's ranked list all read this one list.
 *
 * @param {object[]|null|undefined} signals
 * @param {{byNode: Map}} index
 * @param {number} cursor
 */
export function visibleSignals(signals, index, cursor) {
  return (Array.isArray(signals) ? signals : []).filter((s) => revealIndexOf(s, index) < cursor);
}

/**
 * The bar's markers: human nodes at their start, signals at their reveal —
 * the observed acts of the divergence discussion (denial, interrupt, revert)
 * on the bar for free, because they are nodes and signals, never a
 * heuristic. Sorted by index then kind so the bar draws them in one pass;
 * `cursor` is `idx + 1`, the cursor at which the marked event HAS happened,
 * so a click lands on the moment rather than the instant before it. Entries
 * the timeline cannot place (index −1) are omitted: a marker at "nowhere"
 * would be a lie about when.
 *
 * `glyphs` is passed in because `SIGNAL_GLYPHS` lives in strip.jsx, which a
 * pure module cannot import.
 *
 * @param {import('../../src/ir.js').GraphIR} ir
 * @param {{byNode: Map}} index
 * @param {Record<string,string>} glyphs
 * @returns {Array<{idx:number, cursor:number, kind:'human'|'signal', glyph:string, label:string, id:string}>}
 */
export function markersFor(ir, index, glyphs = {}) {
  const byNode = index?.byNode instanceof Map ? index.byNode : new Map();
  const out = [];
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  for (const n of nodes) {
    if (!n || n.kind !== 'human' || typeof n.id !== 'string') continue;
    const e = byNode.get(n.id);
    if (!e) continue;
    out.push({ idx: e.startIdx, cursor: e.startIdx + 1, kind: 'human', glyph: '✋', label: n.label ?? '', id: n.id });
  }
  const signals = Array.isArray(ir?.signals) ? ir.signals : [];
  for (const s of signals) {
    if (!s || typeof s.id !== 'string') continue;
    const idx = revealIndexOf(s, index);
    if (idx < 0) continue;
    out.push({ idx, cursor: idx + 1, kind: 'signal', glyph: glyphs?.[s.kind] ?? '•', label: s.label ?? '', id: s.id });
  }
  // 'human' < 'signal' alphabetically, so a denial's ✋ precedes the chip it
  // triggers when both land on one index.
  return out.sort((a, b) => a.idx - b.idx || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** The readout's clock: local wall time, 24-hour, to the second. */
export function fmtClock(t) {
  return new Date(t).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * The bar's readout at a cursor: "14:02:31 · 143 / 612". An untimed run
 * (spec §9) shows `—` for the clock rather than an epoch-zero time.
 *
 * @param {object[]} events
 * @param {number} cursor
 * @param {boolean} timed  from `safeTimeline`
 */
export function readoutFor(events, cursor, timed) {
  const list = Array.isArray(events) ? events : [];
  const c = clamp(cursor, list.length);
  return { clock: timed ? fmtClock(timeAtCursor(list, c).t) : '—', step: c, total: list.length };
}

/**
 * The agent hook (spec §7): the cursor at which a focused set is COMPLETE —
 * the tick after the last of its nodes ended (or started, where it has no
 * end), the same rule as signal reveal — so the user steps `←` to watch the
 * lead-up. Null when none of the ids are on the timeline: the focus applies
 * as today and the playhead does not move.
 *
 * @param {string[]} nodeIds
 * @param {{byNode: Map}} index
 * @returns {number|null}
 */
export function completionCursor(nodeIds, index) {
  const at = completionIndexOf(nodeIds, index);
  return at < 0 ? null : at + 1;
}

/**
 * The label a tool group shows at the playhead: its trailing ` ×N` rewritten
 * to ` ×k` while `callsShown` is still short of `callCount`. Display only,
 * and via the SAME regex `toolFamily()` strips, so the convention every
 * adapter writes is the one convention this reads. A label that does not end
 * in ` ×N` (an adapter that deviates — spec open question 1) is shown
 * unchanged, which degrades toward the current rendering rather than
 * inventing a count the label never carried. With `callsShown` undefined
 * (replay closed) the label is the node's own — the identity guard.
 *
 * @param {object} node
 * @param {number|undefined} callsShown  from `stateAt().callsShown`
 * @returns {string}
 */
export function replayLabel(node, callsShown) {
  const label = typeof node?.label === 'string' ? node.label : '';
  if (node?.kind !== 'tool' || typeof callsShown !== 'number' || !Number.isFinite(callsShown)) return label;
  const total = typeof node.callCount === 'number' ? node.callCount : 1;
  if (callsShown >= total || callsShown < 1) return label;
  return label.replace(/ ×\d+$/, ` ×${Math.floor(callsShown)}`);
}

/**
 * The inspector's ghost rows: the first call index (≥ 1) whose call event is
 * at or past the cursor, or Infinity when every call has happened. Call 0 IS
 * the start, so it is never future while the node is present; `callIdxs` is
 * ascending (one pass over the sorted timeline), so a binary search does. An
 * empty list — a single call, an untimed adapter, an old bundle — is Infinity:
 * the detail shows whole, as today.
 *
 * @param {number[]} callIdxs  from `index.byNode.get(id).callIdxs`
 * @param {number} cursor
 * @returns {number}
 */
export function firstFutureCall(callIdxs, cursor) {
  const list = Array.isArray(callIdxs) ? callIdxs : [];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? lo + 1 : Infinity;
}

/**
 * The rate toggle's cycle. `rate` multiplies the schedule's fixed speed (60×
 * real time at 1×), so the four stops are 30× · 60× · 120× · 240× — and that
 * is what the button SAYS (`rateLabel`), because "1×" told nobody anything
 * about how fast the run was going by.
 */
export const RATES = [0.5, 1, 2, 4];

/** The next rate in the cycle; an unknown value resets to 1× rather than guessing. */
export function nextRate(r) {
  const i = RATES.indexOf(r);
  return i === -1 ? 1 : RATES[(i + 1) % RATES.length];
}

/** The speed the button shows: real-time compression, e.g. "60×". */
export function rateLabel(sched, rate) {
  const base = typeof sched?.speed === 'number' && Number.isFinite(sched.speed) ? sched.speed : 60;
  const r = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
  return `${Math.round(base * r)}×`;
}
