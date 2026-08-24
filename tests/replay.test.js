import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { deriveSignals } from '../src/signals.js';
import { buildTimeline, indexEvents, revealIndexOf, cursorForTime, stateAt } from '../src/timeline.js';
import {
  safeTimeline,
  cursorOf,
  openReplay,
  seekTo,
  stepFrom,
  planTick,
  applyTick,
  currentNodeId,
  visibleSignals,
  markersFor,
  readoutFor,
  fmtClock,
  completionCursor,
  replayLabel,
  firstFutureCall,
  RATES,
  rateLabel,
  nextRate,
} from '../frontend/src/replay.js';
import { pinFixtureMtimes, FIXTURE_ROOT, SESSION_RUN_ID, TROUBLE_RUN_ID, CLEAN_RUN_ID } from './helpers.js';

// ---------------------------------------------------------------------------
// Synthetic IRs — the shapes the state transitions need, built by hand so a
// failure names the transition, not the fixture.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-01T12:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const ir = (nodes, edges = [], signals = []) => ({ irVersion: 1, meta: {}, nodes, edges, groups: [], signals });

/** A three-turn run with a two-call tool group in the middle: 7 events. */
function smallRun() {
  return ir([
    { id: 'h0', kind: 'human', label: 'fix the login bug', status: 'completed', startedAt: at(0) },
    { id: 't1', kind: 'turn', label: 'looking', status: 'completed', startedAt: at(1000), endedAt: at(9000) },
    {
      id: 'g1', kind: 'tool', label: 'Edit · login.js ×2', status: 'completed', callCount: 2, errorCount: 0,
      callOffsets: [0, 1000], startedAt: at(2000), endedAt: at(4000),
    },
    { id: 'h1', kind: 'human', label: 'denied', status: 'completed', interventionKind: 'denial', startedAt: at(10000) },
  ]);
}

const kinds = (events) => events.map((e) => `${e.nodeId}:${e.kind}`);

describe('safeTimeline', () => {
  it('builds events, index and schedule once, and says whether the run is timed', () => {
    const tl = safeTimeline(smallRun());
    expect(tl.error).toBeNull();
    expect(kinds(tl.events)).toEqual(['h0:start', 't1:start', 'g1:start', 'g1:call', 'g1:end', 't1:end', 'h1:start']);
    expect(tl.index.byNode.get('g1').callIdxs).toEqual([3]);
    expect(tl.sched.n).toBe(7);
    expect(tl.timed).toBe(true);
  });

  it('an untimed run is not an error — it steps node by node at t = 0', () => {
    const tl = safeTimeline(ir([
      { id: 'a', kind: 'turn', label: 'a', status: 'completed' },
      { id: 'b', kind: 'turn', label: 'b', status: 'completed' },
    ]));
    expect(tl.error).toBeNull();
    expect(tl.timed).toBe(false);
    expect(tl.events.map((e) => e.t)).toEqual([0, 0]);
  });

  it('a null or garbage IR degrades to an empty timeline, never a throw', () => {
    for (const bad of [null, undefined, 42, { nodes: 'nope' }]) {
      const tl = safeTimeline(bad);
      expect(tl.events).toEqual([]);
      expect(tl.index.byNode.size).toBe(0);
      expect(tl.timed).toBe(false);
    }
  });

  it('a throw inside the build becomes `error`, with the events empty and the index usable (spec §9)', () => {
    // buildTimeline never throws by design; a getter that throws is the only
    // way to make it, and it is exactly what the try/catch exists for.
    const poisoned = { nodes: [{ id: 'x', kind: 'turn', get startedAt() { throw new Error('boom'); } }] };
    const tl = safeTimeline(poisoned);
    expect(tl.error).toBe('boom');
    expect(tl.events).toEqual([]);
    expect(tl.index.byNode).toBeInstanceOf(Map);
    expect(tl.sched).toBeNull();
    // and cursorOf / stateAt consumers still get a coherent "end".
    expect(cursorOf(openReplay(), tl.events)).toBe(0);
  });
});

describe('the replay state transitions (spec §4, §10)', () => {
  const graph = smallRun();
  const { events, sched } = safeTimeline(graph);
  const n = events.length;

  it('cursorOf(null) is the end — closed renders exactly as today', () => {
    expect(cursorOf(null, events)).toBe(n);
    expect(cursorOf(null, [])).toBe(0);
    expect(cursorOf(null, undefined)).toBe(0);
  });

  it('open lands in edge, and edge is the end', () => {
    const r = openReplay();
    expect(r).toEqual({ mode: 'edge' });
    expect(cursorOf(r, events)).toBe(n);
  });

  it('an unknown mode degrades to the end, never to an empty canvas', () => {
    expect(cursorOf({ mode: 'sideways' }, events)).toBe(n);
  });

  it('seek yields `at` with the round-trip cursor, for every cursor', () => {
    for (let c = 0; c <= n; c++) {
      const r = seekTo(events, c);
      expect(r.mode).toBe('at');
      expect(cursorOf(r, events)).toBe(c);
    }
  });

  it('seek stores a timestamp plus tie ordinal, so a re-parse never moves it and a deep link needs only t', () => {
    // Events 3 (g1:call at +3000) has a unique t; events 4/5 share none. Put
    // the ordinal to the test on a batch: three calls at one millisecond.
    const batch = ir([
      { id: 'b', kind: 'tool', label: 'Read ×4', status: 'completed', callCount: 4, errorCount: 0, callOffsets: [0, 0, 0, 0], startedAt: at(0) },
    ]);
    const be = buildTimeline(batch);
    expect(be.map((e) => e.t)).toEqual([T0, T0, T0, T0]);
    for (let c = 0; c <= 4; c++) expect(cursorOf(seekTo(be, c), be)).toBe(c);
    // Without k (a deep link) the same t means "every event at t has happened".
    expect(cursorOf({ mode: 'at', t: T0 }, be)).toBe(4);
    expect(cursorForTime(be, T0)).toBe(4);
  });

  it('a seek past the edge clamps to the edge (a re-parse dropped events)', () => {
    expect(cursorOf(seekTo(events, 999), events)).toBe(n);
    expect(cursorOf(seekTo(events, -3), events)).toBe(0);
    // An `at` whose t is beyond the last event: clamped, not an error.
    expect(cursorOf({ mode: 'at', t: T0 + 1e9 }, events)).toBe(n);
    expect(cursorOf({ mode: 'at', t: T0 - 1e9 }, events)).toBe(0);
  });

  it('stepping is one event and clamps at both ends', () => {
    let r = seekTo(events, 3);
    r = stepFrom(r, events, +1);
    expect(cursorOf(r, events)).toBe(4);
    r = stepFrom(r, events, -1);
    expect(cursorOf(r, events)).toBe(3);
    // A step that does not move leaves the value UNCHANGED: from edge, → is
    // still edge (an `at` at the same cursor would read as detached — the
    // live follow off and the `live` button dark for a keypress that did
    // nothing); from 0, ← is the same `at`.
    const edge = openReplay();
    const end = stepFrom(edge, events, +1);
    expect(end).toBe(edge);
    expect(end.mode).toBe('edge');
    expect(cursorOf(end, events)).toBe(n);
    const zero = seekTo(events, 0);
    const start = stepFrom(zero, events, -1);
    expect(start).toBe(zero);
    expect(cursorOf(start, events)).toBe(0);
    // …and a step that does move from the edge detaches, as it should.
    expect(stepFrom(edge, events, -1).mode).toBe('at');
    expect(cursorOf(stepFrom(edge, events, -1), events)).toBe(n - 1);
    // Closed (null) steps from the end, as edge does.
    expect(cursorOf(stepFrom(null, events, -1), events)).toBe(n - 1);
  });

  it('stepping is always one event — even for a caller whose schedule strides', () => {
    // The schedule itself never strides (play is a fixed-speed time-lapse
    // and nothing is skipped), but tickAfter still honours a stride a caller
    // sets. A step must ignore it either way: stepping is the debugging
    // surface, and it moves by exactly one event.
    const nodes = [];
    for (let i = 0; i < 300; i++) nodes.push({ id: `n${i}`, kind: 'turn', label: 'x', status: 'completed', startedAt: at(i) });
    const tl = safeTimeline(ir(nodes));
    expect(tl.sched.stride).toBe(1);
    const strided = { ...tl.sched, stride: 3 };
    expect(cursorOf(stepFrom(seekTo(tl.events, 100), tl.events, +1), tl.events)).toBe(101);
    // …while a play tick on that strided schedule DOES cross three.
    expect(planTick(seekTo(tl.events, 100), tl.events, strided, 1).cursor).toBe(103);
  });

  it('planTick/applyTick advance through the run and hand back to edge at the end', () => {
    let r = seekTo(events, 0);
    let ticks = 0;
    let lastDelay = null;
    for (;;) {
      const tick = planTick(r, events, sched, 1);
      ticks++;
      expect(tick.delayMs).toBeGreaterThanOrEqual(sched.floorMs);
      lastDelay = tick.delayMs;
      r = applyTick(events, tick);
      if (tick.done) break;
      expect(r.mode).toBe('at');
      expect(cursorOf(r, events)).toBe(tick.cursor);
    }
    expect(ticks).toBe(n); // stride 1 on a 7-event run: one tick per event
    expect(lastDelay).toBeGreaterThan(0);
    expect(r).toEqual({ mode: 'edge' });
  });

  it('planTick from the last cursor is done at once and applyTick yields edge', () => {
    const tick = planTick(seekTo(events, n), events, sched, 1);
    expect(tick).toEqual({ cursor: n, delayMs: 0, done: true });
    expect(applyTick(events, tick)).toEqual({ mode: 'edge' });
    // Playing from edge (the header's play at the end) is likewise a no-op tick;
    // whoever wants "play again" seeks to 0 first, as the embed's play() does.
    expect(planTick(openReplay(), events, sched, 1).done).toBe(true);
  });

  it('a play that reaches the end on a live run also yields edge — the caller re-engages follow', () => {
    // This module cannot tell a live run from a finished one, and does not
    // need to: `edge` IS "the newest event", and the only extra thing a live
    // run wants — the existing follow toggle back on — is canvas state, which
    // App sets (`if (live) setFollow(true)`) in the same tick handler that
    // calls applyTick. The contract here is only that the end is `edge`.
    const live = ir([
      { id: 'a', kind: 'turn', label: 'a', status: 'completed', startedAt: at(0), endedAt: at(1000) },
      { id: 'b', kind: 'turn', label: 'b', status: 'running', startedAt: at(2000) },
    ]);
    const tl = safeTimeline(live);
    let r = seekTo(tl.events, 0);
    for (let guard = 0; guard < 10; guard++) {
      const tick = planTick(r, tl.events, tl.sched, 2);
      r = applyTick(tl.events, tick);
      if (tick.done) break;
    }
    expect(r).toEqual({ mode: 'edge' });
    expect(cursorOf(r, tl.events)).toBe(tl.events.length);
  });

  it('rate scales the wait, never the frames', () => {
    const r = seekTo(events, 2);
    const slow = planTick(r, events, sched, 0.5);
    const fast = planTick(r, events, sched, 2);
    expect(slow.cursor).toBe(fast.cursor);
    expect(slow.delayMs).toBeCloseTo(fast.delayMs * 4);
  });

  it('planTick with no schedule (an errored timeline) is done immediately', () => {
    const tick = planTick(seekTo(events, 0), events, null, 1);
    expect(tick.done).toBe(true);
    expect(applyTick(events, tick)).toEqual({ mode: 'edge' });
  });

  it('currentNodeId is the node whose event happened last, and null at 0', () => {
    expect(currentNodeId(events, 0)).toBeNull();
    expect(currentNodeId(events, 1)).toBe('h0');
    expect(currentNodeId(events, 4)).toBe('g1'); // its call
    expect(currentNodeId(events, 6)).toBe('t1'); // its end — the turn is "current" again
    expect(currentNodeId(events, n)).toBe('h1');
    expect(currentNodeId(events, n + 50)).toBe('h1'); // clamped, not undefined
    expect(currentNodeId([], 0)).toBeNull();
    expect(currentNodeId(undefined, 3)).toBeNull();
  });

  it('the rate toggle cycles 0.5 → 1 → 2 → 4 → 0.5 and resets an unknown value to 1×', () => {
    expect(RATES).toEqual([0.5, 1, 2, 4]);
    expect(nextRate(0.5)).toBe(1);
    expect(nextRate(1)).toBe(2);
    expect(nextRate(2)).toBe(4);
    expect(nextRate(4)).toBe(0.5);
    expect(nextRate(7)).toBe(1);
    expect(nextRate(undefined)).toBe(1);
  });

  it('the rate button says the real-time compression, not a bare multiplier', () => {
    // 1× is 60× real time by the schedule's default; the label is what a
    // person can reason about ("an hour goes by in a minute").
    expect(rateLabel({ speed: 60 }, 1)).toBe('60×');
    expect(rateLabel({ speed: 60 }, 0.5)).toBe('30×');
    expect(rateLabel({ speed: 60 }, 4)).toBe('240×');
    expect(rateLabel(null, 2)).toBe('120×');
    expect(rateLabel({ speed: 60 }, NaN)).toBe('60×');
  });
});

describe('visibleSignals — revealed, never re-derived', () => {
  it('a clustered intervention appears at its LAST member, not its first', () => {
    const humans = [0, 1, 2].map((i) => ({
      id: `h${i}`, kind: 'human', label: 'denied', status: 'completed', interventionKind: 'denial', startedAt: at(1000 * (i + 1)),
    }));
    const tail = { id: 'tail', kind: 'turn', label: 'after', status: 'completed', startedAt: at(9000) };
    const chip = { id: 'sig:intervention:denial', kind: 'intervention', severity: 'high', nodeIds: ['h0', 'h1', 'h2'], label: '3 denials' };
    const tl = safeTimeline(ir([...humans, tail], [], [chip]));
    const reveal = tl.index.byNode.get('h2').startIdx;
    expect(visibleSignals([chip], tl.index, reveal)).toEqual([]); // at the instant of the third: not yet
    expect(visibleSignals([chip], tl.index, reveal + 1)).toEqual([chip]); // the tick after: "3 denials" is true
    expect(visibleSignals([chip], tl.index, tl.index.byNode.get('h1').startIdx + 1)).toEqual([]);
  });

  it('a retry storm appears at its last node’s end', () => {
    const a = { id: 'a', kind: 'tool', label: 'Edit · x', status: 'error', callCount: 1, errorCount: 1, startedAt: at(0), endedAt: at(2000) };
    const b = { id: 'b', kind: 'tool', label: 'Edit · x', status: 'error', callCount: 1, errorCount: 1, startedAt: at(3000), endedAt: at(5000) };
    const c = { id: 'c', kind: 'turn', label: 'later', status: 'completed', startedAt: at(6000) };
    const storm = { id: 'sig:retry-storm:a', kind: 'retry-storm', severity: 'high', nodeIds: ['a', 'b'], label: '2 failed Edit calls' };
    const tl = safeTimeline(ir([a, b, c], [], [storm]));
    const bEnd = tl.index.byNode.get('b').endIdx;
    // b has started and is running: the storm is not yet a storm.
    expect(visibleSignals([storm], tl.index, bEnd)).toEqual([]);
    expect(visibleSignals([storm], tl.index, bEnd + 1)).toEqual([storm]);
    expect(visibleSignals([storm], tl.index, tl.events.length)).toEqual([storm]);
  });

  it('a signal none of whose nodes are on the timeline stays shown at every cursor, and garbage input is empty', () => {
    const tl = safeTimeline(smallRun());
    const orphan = { id: 'sig:x', kind: 'outlier', severity: 'info', nodeIds: ['ghost'], label: 'x' };
    expect(visibleSignals([orphan], tl.index, 0)).toEqual([orphan]);
    expect(visibleSignals(null, tl.index, 3)).toEqual([]);
    expect(visibleSignals(undefined, tl.index, 3)).toEqual([]);
  });
});

describe('markersFor', () => {
  it('puts human nodes at their start and signals at their reveal, sorted, and omits what it cannot place', () => {
    const graph = smallRun();
    const chip = { id: 'sig:intervention:denial', kind: 'intervention', severity: 'high', nodeIds: ['h1'], label: '1 denial' };
    const ghost = { id: 'sig:ghost', kind: 'outlier', severity: 'info', nodeIds: ['nope'], label: 'unplaceable' };
    graph.signals = [ghost, chip];
    const tl = safeTimeline(graph);
    const glyphs = { intervention: '✋', outlier: '◆' };
    const markers = markersFor(graph, tl.index, glyphs);
    const h0 = tl.index.byNode.get('h0').startIdx;
    const h1 = tl.index.byNode.get('h1').startIdx;
    expect(markers).toEqual([
      { idx: h0, cursor: h0 + 1, kind: 'human', glyph: '✋', label: 'fix the login bug', id: 'h0' },
      { idx: h1, cursor: h1 + 1, kind: 'human', glyph: '✋', label: 'denied', id: 'h1' },
      { idx: h1, cursor: h1 + 1, kind: 'signal', glyph: '✋', label: '1 denial', id: 'sig:intervention:denial' },
    ]);
    // A marker click seeks to `cursor`: the marked event HAS happened there.
    expect(currentNodeId(tl.events, markers[1].cursor)).toBe('h1');
    expect(visibleSignals(graph.signals, tl.index, markers[2].cursor)).toContain(chip);
  });

  it('an unknown signal kind gets the • glyph; missing glyphs map is tolerated', () => {
    const graph = smallRun();
    graph.signals = [{ id: 'sig:new', kind: 'never-heard-of-it', severity: 'info', nodeIds: ['t1'], label: 'new' }];
    const tl = safeTimeline(graph);
    expect(markersFor(graph, tl.index).find((m) => m.kind === 'signal').glyph).toBe('•');
    expect(markersFor(graph, tl.index, {}).find((m) => m.kind === 'signal').idx).toBe(tl.index.byNode.get('t1').endIdx);
  });

  it('a null IR or a bare index yields no markers', () => {
    expect(markersFor(null, { byNode: new Map() }, {})).toEqual([]);
    expect(markersFor(smallRun(), null, {})).toEqual([]);
  });
});

describe('readoutFor', () => {
  it('shows — for an untimed run and a clock for a timed one', () => {
    const untimed = safeTimeline(ir([{ id: 'a', kind: 'turn', label: 'a', status: 'completed' }]));
    expect(readoutFor(untimed.events, 1, untimed.timed)).toEqual({ clock: '—', step: 1, total: 1 });
    const timed = safeTimeline(smallRun());
    const r = readoutFor(timed.events, 3, timed.timed);
    expect(r.step).toBe(3);
    expect(r.total).toBe(7);
    expect(r.clock).toBe(fmtClock(T0 + 2000)); // event 3 is g1:start at +2000
    expect(r.clock).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('clamps the step into the run', () => {
    const tl = safeTimeline(smallRun());
    expect(readoutFor(tl.events, 99, true).step).toBe(7);
    expect(readoutFor(tl.events, -1, true).step).toBe(0);
    expect(readoutFor(tl.events, NaN, true).step).toBe(7);
  });
});

describe('completionCursor — the agent hook (spec §7)', () => {
  it('is completion + 1, or null when none of the ids are on the timeline', () => {
    const tl = safeTimeline(smallRun());
    const g1End = tl.index.byNode.get('g1').endIdx;
    expect(completionCursor(['g1'], tl.index)).toBe(g1End + 1);
    // A set: the max — the moment the LAST of them has finished.
    const t1End = tl.index.byNode.get('t1').endIdx;
    expect(completionCursor(['g1', 't1'], tl.index)).toBe(t1End + 1);
    // No end → its start.
    expect(completionCursor(['h1'], tl.index)).toBe(tl.index.byNode.get('h1').startIdx + 1);
    // Unknown ids are skipped; all unknown → null, and the playhead stays put.
    expect(completionCursor(['g1', 'phantom'], tl.index)).toBe(g1End + 1);
    expect(completionCursor(['phantom'], tl.index)).toBeNull();
    expect(completionCursor([], tl.index)).toBeNull();
    expect(completionCursor(null, tl.index)).toBeNull();
    // At that cursor the whole set is present and settled.
    const c = completionCursor(['g1', 't1'], tl.index);
    expect(currentNodeId(tl.events, c)).toBe('t1');
  });
});

// ---------------------------------------------------------------------------
// Over the claude-code corpus: the identity guard for the pieces above, and
// monotonicity — a chip that has appeared never disappears as the playhead
// moves forward.
// ---------------------------------------------------------------------------

describe('replayLabel — the ×N → ×k rewrite (spec §5)', () => {
  const group = { id: 'g', kind: 'tool', label: 'Bash · npm test ×5', callCount: 5 };

  it('counts up while the group is mid-flight and shows the label whole at the end', () => {
    expect(replayLabel(group, 1)).toBe('Bash · npm test ×1');
    expect(replayLabel(group, 3)).toBe('Bash · npm test ×3');
    expect(replayLabel(group, 5)).toBe('Bash · npm test ×5');
    expect(replayLabel(group, 7)).toBe('Bash · npm test ×5'); // never above the node's own count
  });

  it('is the identity with callsShown undefined — replay closed changes no label', () => {
    expect(replayLabel(group, undefined)).toBe('Bash · npm test ×5');
    expect(replayLabel(group, NaN)).toBe('Bash · npm test ×5');
    expect(replayLabel(group, 0)).toBe('Bash · npm test ×5');
  });

  it('rewrites only a trailing " ×N": other kinds, single calls and deviant labels are unchanged', () => {
    expect(replayLabel({ id: 't', kind: 'turn', label: 'thinking ×3' }, 1)).toBe('thinking ×3');
    expect(replayLabel({ id: 's', kind: 'tool', label: 'Read · a.js', callCount: 1 }, 1)).toBe('Read · a.js');
    // An adapter that put the count elsewhere (spec open question 1): shown as is, never invented.
    expect(replayLabel({ id: 'd', kind: 'tool', label: '5 × Bash', callCount: 5 }, 2)).toBe('5 × Bash');
    expect(replayLabel({ id: 'x', kind: 'tool', label: 'Bash ×5 (slow)', callCount: 5 }, 2)).toBe('Bash ×5 (slow)');
    expect(replayLabel(null, 2)).toBe('');
    expect(replayLabel({ id: 'n', kind: 'tool', callCount: 3 }, 2)).toBe('');
  });

  it('floors a fractional count and defaults a missing callCount to one call', () => {
    expect(replayLabel(group, 2.9)).toBe('Bash · npm test ×2');
    expect(replayLabel({ id: 'm', kind: 'tool', label: 'Bash ×2' }, 1)).toBe('Bash ×2'); // callCount missing → 1 → whole
  });
});

describe('firstFutureCall — the inspector’s ghost rows', () => {
  // A five-call group: call i (i ≥ 1) is at event index 10 + 2i.
  const callIdxs = [12, 14, 16, 18];

  it('is the first call index (≥ 1) whose event has not happened, and Infinity once all have', () => {
    expect(firstFutureCall(callIdxs, 0)).toBe(1); // nothing happened: row 1 is the first ghost, row 0 never is
    expect(firstFutureCall(callIdxs, 12)).toBe(1); // the event AT the cursor has not happened yet
    expect(firstFutureCall(callIdxs, 13)).toBe(2);
    expect(firstFutureCall(callIdxs, 17)).toBe(4);
    expect(firstFutureCall(callIdxs, 19)).toBe(Infinity);
    expect(firstFutureCall(callIdxs, 1000)).toBe(Infinity);
  });

  it('agrees with stateAt’s callsShown: rows before it are exactly the calls shown', () => {
    const g = {
      id: 'g', kind: 'tool', label: 'Bash ×5', status: 'completed', callCount: 5, errorCount: 0,
      callOffsets: [0, 10, 20, 30, 40], startedAt: at(0), endedAt: at(100),
    };
    const graph = ir([g]);
    const { events, index } = safeTimeline(graph);
    const idxs = index.byNode.get('g').callIdxs;
    for (let c = 1; c <= events.length; c++) {
      const shown = stateAt(graph, events, c, index).callsShown.get('g');
      const from = firstFutureCall(idxs, c);
      expect(from === Infinity ? 5 : from).toBe(shown);
    }
  });

  it('an empty or missing list is Infinity — a single call, an untimed adapter, an old bundle show whole', () => {
    expect(firstFutureCall([], 3)).toBe(Infinity);
    expect(firstFutureCall(null, 3)).toBe(Infinity);
    expect(firstFutureCall(undefined, 0)).toBe(Infinity);
  });
});

describe('over the claude-code corpus', () => {
  let runs;
  beforeAll(async () => {
    await pinFixtureMtimes();
    runs = [];
    for (const ref of await detect([FIXTURE_ROOT])) {
      const { ir: graph } = await parse(ref);
      graph.signals = deriveSignals(graph);
      runs.push({ runId: ref.runId, graph, tl: safeTimeline(graph) });
    }
  });

  it('every run has a timeline (no error) and safeTimeline agrees with the raw build', () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const { runId, graph, tl } of runs) {
      expect(tl.error, runId).toBeNull();
      expect(tl.events, runId).toEqual(buildTimeline(graph));
      expect(tl.index.byNode.size, runId).toBe(indexEvents(tl.events).byNode.size);
    }
  });

  it('at the end every signal is visible; the set only grows as the cursor advances', () => {
    for (const { runId, graph, tl } of runs) {
      expect(visibleSignals(graph.signals, tl.index, tl.events.length), runId).toEqual(graph.signals);
      let prev = new Set();
      for (let c = 0; c <= tl.events.length; c++) {
        const now = new Set(visibleSignals(graph.signals, tl.index, c).map((s) => s.id));
        for (const id of prev) expect(now.has(id), `${runId} lost ${id} at ${c}`).toBe(true);
        prev = now;
      }
    }
  });

  it('the trouble run reveals its signals strictly after the clean run reveals nothing', () => {
    const trouble = runs.find((r) => r.runId === TROUBLE_RUN_ID);
    const clean = runs.find((r) => r.runId === CLEAN_RUN_ID);
    expect(trouble.graph.signals.length).toBeGreaterThan(0);
    expect(clean.graph.signals).toEqual([]);
    // Nothing is visible before its evidence — at cursor 0 no positioned
    // signal shows, and every signal in the corpus is positioned.
    expect(visibleSignals(trouble.graph.signals, trouble.tl.index, 0)).toEqual([]);
    for (const s of trouble.graph.signals) expect(revealIndexOf(s, trouble.tl.index)).toBeGreaterThanOrEqual(0);
    expect(visibleSignals(clean.graph.signals, clean.tl.index, 0)).toEqual([]);
  });

  it('markers cover every human node and every signal, in order', () => {
    // `human` nodes are the observed acts — a denial, an interrupt — not
    // prompts (those are turns). The session run carries both acts; the
    // trouble run carries one of every high-severity signal. Every run's
    // markers are sorted and each cursor is the tick after its index.
    for (const { runId, graph, tl } of runs) {
      const markers = markersFor(graph, tl.index, { intervention: '✋' });
      const humans = graph.nodes.filter((n) => n.kind === 'human');
      expect(markers.filter((m) => m.kind === 'human').map((m) => m.id), runId).toEqual(
        humans.map((h) => h.id).sort((a, b) => tl.index.byNode.get(a).startIdx - tl.index.byNode.get(b).startIdx),
      );
      expect(markers.filter((m) => m.kind === 'signal').map((m) => m.id).sort(), runId).toEqual(
        graph.signals.map((s) => s.id).sort(),
      );
      for (let i = 1; i < markers.length; i++) expect(markers[i].idx, runId).toBeGreaterThanOrEqual(markers[i - 1].idx);
      for (const m of markers) expect(m.cursor, runId).toBe(m.idx + 1);
    }
    const session = runs.find((r) => r.runId === SESSION_RUN_ID);
    expect(session.graph.nodes.filter((n) => n.kind === 'human').length).toBe(2);
    const sessionMarkers = markersFor(session.graph, session.tl.index, { intervention: '✋' });
    expect(sessionMarkers.filter((m) => m.kind === 'human').map((m) => m.glyph)).toEqual(['✋', '✋']);
    const trouble = runs.find((r) => r.runId === TROUBLE_RUN_ID);
    expect(markersFor(trouble.graph, trouble.tl.index, {}).filter((m) => m.kind === 'signal').length).toBe(
      trouble.graph.signals.length,
    );
  });

  it('seek round-trips every cursor of every run, and stepping walks the whole run one event at a time', () => {
    for (const { runId, tl } of runs) {
      let r = seekTo(tl.events, 0);
      for (let c = 0; c <= tl.events.length; c++) {
        expect(cursorOf(seekTo(tl.events, c), tl.events), `${runId} @${c}`).toBe(c);
        expect(cursorOf(r, tl.events), `${runId} step ${c}`).toBe(c);
        r = stepFrom(r, tl.events, +1);
      }
    }
  });
});

describe('purity contract', () => {
  it('replay.js imports only the timeline module — no preact, no DOM, no node:', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'replay.js'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...code.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../../src/timeline.js']);
    expect(code).not.toMatch(/require\(|['"]node:|process\.|document\.|window\./);
  });
});
