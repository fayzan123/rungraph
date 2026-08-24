import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  runOrder,
  buildTimeline,
  indexEvents,
  stateAt,
  completionIndexOf,
  revealIndexOf,
  cursorForTime,
  timeAtCursor,
  schedule,
  tickAfter,
  validCallOffsets,
} from '../src/timeline.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  HERMES_FIXTURE_ROOT,
  OPENCODE_FIXTURE_ROOT,
  CURSOR_FIXTURE_ROOTS,
} from './helpers.js';

// The three SQLite corpora ride on node:sqlite: the Node 20 CI leg skips
// them, the Node 22 leg runs them. Probed with require, not import —
// vite-node mangles a literal `import('node:sqlite')` (see src/sqlite.js).
const requireBuiltin = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    requireBuiltin('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  await pinFixtureMtimes();
});

/**
 * THE EXTRACTION ORACLE: the pre-move `runOrder` from src/signals.js, pasted
 * verbatim on 2026-08-24 before it was deleted there. The new module must
 * produce the identical order over every corpus — the extraction's own test,
 * exactly as tests/hermes.test.js passing unmodified was for sqlite.js.
 */
function legacyRunOrder(nodes) {
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

// Literal dynamic imports, one per adapter, so vite can see them; the
// SQLite three are only ever imported inside their gated suites.
const CORPORA = [
  {
    name: 'claude-code',
    sqlite: false,
    load: () => import('../src/adapters/claude-code/index.js'),
    roots: [FIXTURE_ROOT],
  },
  {
    name: 'codex',
    sqlite: false,
    load: () => import('../src/adapters/codex/index.js'),
    roots: [CODEX_FIXTURE_ROOT],
  },
  {
    name: 'hermes',
    sqlite: true,
    load: () => import('../src/adapters/hermes/index.js'),
    roots: [HERMES_FIXTURE_ROOT],
  },
  {
    name: 'opencode',
    sqlite: true,
    load: () => import('../src/adapters/opencode/index.js'),
    roots: [OPENCODE_FIXTURE_ROOT],
  },
  {
    // Both Cursor surfaces under the one adapter.
    name: 'cursor',
    sqlite: true,
    load: () => import('../src/adapters/cursor/index.js'),
    roots: CURSOR_FIXTURE_ROOTS,
  },
];

async function loadCorpus({ load, roots }) {
  const adapter = await load();
  const runs = [];
  for (const ref of await adapter.detect(roots)) {
    const { ir } = await adapter.parse(ref);
    const events = buildTimeline(ir);
    runs.push({ runId: ref.runId, ir, events, index: indexEvents(events) });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Over every adapter's corpus. The adapters are gaining `callOffsets` and tool
// `endedAt` in the same change as this file; every assertion below holds
// whether or not a given corpus carries them yet, and the synthetic suites
// further down exercise both fields explicitly.
// ---------------------------------------------------------------------------

for (const corpus of CORPORA) {
  const suite = corpus.sqlite ? describe.skipIf(!hasNodeSqlite) : describe;
  suite(`over the ${corpus.name} corpus`, () => {
    let runs;
    beforeAll(async () => {
      runs = await loadCorpus(corpus);
    });

    // THE IDENTITY GUARD. Replay closed must change nothing: at the last
    // event the graph is exactly the one rendered today — every node present
    // with its own status and full count, every edge drawn. First, because
    // every other behaviour in this file is only worth having if this holds.
    it('stateAt(ir, events, events.length) reproduces the graph as it renders today', () => {
      expect(runs.length).toBeGreaterThan(0);
      for (const { runId, ir, events, index } of runs) {
        const s = stateAt(ir, events, events.length, index);
        expect(s.cursor).toBe(events.length);
        expect(s.present.size, runId).toBe(ir.nodes.length);
        for (const n of ir.nodes) {
          expect(s.present.has(n.id), `${runId} ${n.id} present`).toBe(true);
          expect(s.status.get(n.id), `${runId} ${n.id} status`).toBe(n.status);
          if (n.kind === 'tool') {
            expect(s.callsShown.get(n.id), `${runId} ${n.id} calls`).toBe(n.callCount ?? 1);
          }
        }
        for (const e of ir.edges) {
          expect(s.edgePresent.has(e.id), `${runId} edge ${e.id}`).toBe(true);
        }
      }
    });

    it('is not vacuous: runs were found and they produced events', () => {
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.reduce((n, r) => n + r.events.length, 0)).toBeGreaterThan(0);
    });

    it('every node has exactly one start, t is monotonic, no end precedes its start, calls match callOffsets', () => {
      for (const { runId, ir, events, index } of runs) {
        const ids = new Set(ir.nodes.map((n) => n.id));
        const starts = new Map();
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          expect(ids.has(e.nodeId), `${runId} event for unknown node ${e.nodeId}`).toBe(true);
          expect(Number.isFinite(e.t), `${runId} event ${i} has a non-finite t`).toBe(true);
          if (i > 0) expect(e.t, `${runId} t decreases at event ${i}`).toBeGreaterThanOrEqual(events[i - 1].t);
          if (e.kind === 'start') starts.set(e.nodeId, (starts.get(e.nodeId) ?? 0) + 1);
          // An Event carries `i` only on calls, so its shape says its kind.
          expect('i' in e, `${runId} event ${i} kind ${e.kind} carries i`).toBe(e.kind === 'call');
          if (e.kind === 'call') expect(e.i).toBeGreaterThanOrEqual(1);
        }
        for (const n of ir.nodes) {
          expect(starts.get(n.id), `${runId} ${n.id} start count`).toBe(1);
          const entry = index.byNode.get(n.id);
          expect(events[entry.startIdx].kind).toBe('start');
          if (entry.endIdx !== null) {
            expect(entry.endIdx, `${runId} ${n.id} end before start`).toBeGreaterThan(entry.startIdx);
            expect(events[entry.endIdx].kind).toBe('end');
          }
          const offs = validCallOffsets(n);
          expect(entry.callIdxs.length, `${runId} ${n.id} call events`).toBe(offs ? offs.length - 1 : 0);
          for (const ci of entry.callIdxs) expect(ci).toBeGreaterThan(entry.startIdx);
        }
        // Nothing precedes the earliest timed node: a leading untimed node is
        // raised to it, never left at 1970 where it would hand schedule() a
        // 56-year span. (No fixture poses the shape yet — a live workflow's
        // root does, on this machine — so the synthetic §9 case pins it.)
        const timed = ir.nodes.map((n) => Date.parse(n.startedAt)).filter(Number.isFinite);
        if (timed.length > 0 && events.length > 0) {
          expect(events[0].t, `${runId} first event precedes the earliest timed node`).toBeGreaterThanOrEqual(Math.min(...timed));
        }
      }
    });

    it('a node is running from its start through its end, then takes its own status', () => {
      for (const { runId, ir, events, index } of runs) {
        expect(stateAt(ir, events, 0, index).present.size, `${runId} at cursor 0`).toBe(0);
        for (const n of ir.nodes) {
          const { startIdx, endIdx } = index.byNode.get(n.id);
          const justStarted = stateAt(ir, events, startIdx + 1, index);
          expect(justStarted.present.has(n.id)).toBe(true);
          if (endIdx === null) {
            expect(justStarted.status.get(n.id), `${runId} ${n.id} no end → own status`).toBe(n.status);
          } else {
            expect(justStarted.status.get(n.id), `${runId} ${n.id} running before end`).toBe('running');
            expect(stateAt(ir, events, endIdx, index).status.get(n.id)).toBe('running');
            expect(stateAt(ir, events, endIdx + 1, index).status.get(n.id)).toBe(n.status);
          }
        }
      }
    });

    it('cursorForTime ↔ timeAtCursor round-trips for every cursor, and clamps', () => {
      for (const { runId, events } of runs) {
        for (let c = 0; c <= events.length; c++) {
          const r = timeAtCursor(events, c);
          expect(cursorForTime(events, r.t, r.k), `${runId} cursor ${c}`).toBe(c);
        }
        if (events.length === 0) continue;
        expect(cursorForTime(events, events[0].t - 1)).toBe(0);
        expect(cursorForTime(events, events[events.length - 1].t + 1)).toBe(events.length);
        expect(cursorForTime(events, NaN)).toBe(events.length);
        // The deep-link reading: every event at or before T has happened.
        const last = events[events.length - 1].t;
        expect(cursorForTime(events, last)).toBe(events.length);
      }
    });

    // THE EXTRACTION TEST.
    it('runOrder yields the identical order the pre-move signals.js produced', () => {
      for (const { runId, ir } of runs) {
        expect(runOrder(ir.nodes).map((n) => n.id), runId).toEqual(legacyRunOrder(ir.nodes).map((n) => n.id));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Synthetic IRs for the shapes a fixture cannot pose cheaply.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-01T12:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const ir = (nodes, edges = []) => ({ irVersion: 1, meta: {}, nodes, edges, groups: [] });
const built = (graph) => {
  const events = buildTimeline(graph);
  return { events, index: indexEvents(events) };
};

describe('edge presence is kind-aware', () => {
  const turn = { id: 'T', kind: 'turn', label: 'turn', status: 'completed', startedAt: at(0), endedAt: at(10000) };
  const child = { id: 'A', kind: 'agent', label: 'agent', status: 'completed', startedAt: at(1000), endedAt: at(5000) };
  const next = { id: 'X', kind: 'turn', label: 'next', status: 'completed', startedAt: at(12000) };
  const edges = [
    { id: 'spawn', kind: 'spawn', from: 'T', to: 'A' },
    { id: 'return', kind: 'return', from: 'A', to: 'T' },
    { id: 'seq', kind: 'sequence', from: 'T', to: 'X' },
  ];

  it('a return edge is absent while its child runs and present the tick after the child ends', () => {
    const graph = ir([turn, child, next], edges);
    const { events, index } = built(graph);
    expect(events.map((e) => `${e.nodeId}:${e.kind}`)).toEqual(['T:start', 'A:start', 'A:end', 'T:end', 'X:start']);
    const childEnd = index.byNode.get('A').endIdx;
    const during = stateAt(graph, events, childEnd, index);
    expect(during.present.has('A')).toBe(true);
    expect(during.status.get('A')).toBe('running');
    expect(during.edgePresent.has('spawn')).toBe(true);
    expect(during.edgePresent.has('return')).toBe(false);
    const after = stateAt(graph, events, childEnd + 1, index);
    expect(after.status.get('A')).toBe('completed');
    expect(after.edgePresent.has('return')).toBe(true);
  });

  it('a child with no end event falls back to both-ends-present', () => {
    const untimedChild = { ...child, endedAt: undefined };
    const graph = ir([turn, untimedChild, next], edges);
    const { events, index } = built(graph);
    expect(index.byNode.get('A').endIdx).toBeNull();
    const both = stateAt(graph, events, index.byNode.get('A').startIdx + 1, index);
    expect(both.present.has('A')).toBe(true);
    expect(both.edgePresent.has('return')).toBe(true);
    const before = stateAt(graph, events, index.byNode.get('A').startIdx, index);
    expect(before.edgePresent.has('return')).toBe(false);
  });

  it('sequence and spawn need both endpoints present', () => {
    const graph = ir([turn, child, next], edges);
    const { events, index } = built(graph);
    const only = stateAt(graph, events, 1, index);
    expect(only.present).toEqual(new Set(['T']));
    expect(only.edgePresent.size).toBe(0);
    const xStart = index.byNode.get('X').startIdx;
    expect(stateAt(graph, events, xStart, index).edgePresent.has('seq')).toBe(false);
    expect(stateAt(graph, events, xStart + 1, index).edgePresent.has('seq')).toBe(true);
    // An unknown kind takes the both-ends rule rather than vanishing.
    const odd = ir([turn, next], [{ id: 'odd', kind: 'mystery', from: 'T', to: 'X' }]);
    const o = built(odd);
    expect(stateAt(odd, o.events, o.events.length, o.index).edgePresent.has('odd')).toBe(true);
    expect(stateAt(odd, o.events, 1, o.index).edgePresent.has('odd')).toBe(false);
  });

  it('an endpoint the timeline never saw counts as present', () => {
    const graph = ir([turn], [{ id: 'dangling', kind: 'sequence', from: 'T', to: 'ghost' }]);
    const { events, index } = built(graph);
    expect(stateAt(graph, events, 0, index).edgePresent.has('dangling')).toBe(false);
    expect(stateAt(graph, events, 1, index).edgePresent.has('dangling')).toBe(true);
  });
});

describe('the reveal rule', () => {
  it('a retry storm over two tool nodes reveals at the last node’s end', () => {
    const a = { id: 'a', kind: 'tool', label: 'Edit · x', status: 'error', errorCount: 1, startedAt: at(0), endedAt: at(2000) };
    const b = { id: 'b', kind: 'tool', label: 'Edit · x', status: 'error', errorCount: 1, startedAt: at(3000), endedAt: at(5000) };
    const after = { id: 'c', kind: 'turn', label: 'later', status: 'completed', startedAt: at(6000) };
    const { index } = built(ir([a, b, after]));
    const storm = { kind: 'retry-storm', nodeIds: ['a', 'b'] };
    const reveal = revealIndexOf(storm, index);
    expect(reveal).toBe(index.byNode.get('b').endIdx);
    expect(reveal).toBeGreaterThan(index.byNode.get('a').endIdx);
    // Shown iff reveal < cursor: not at the instant of the end, the tick after.
    expect(reveal < reveal).toBe(false);
    expect(reveal < reveal + 1).toBe(true);
  });

  it('a clustered intervention over three human nodes reveals at the LAST member’s start', () => {
    const humans = [0, 1, 2].map((i) => ({
      id: `h${i}`,
      kind: 'human',
      label: 'denied',
      status: 'completed',
      interventionKind: 'denial',
      startedAt: at(1000 * (i + 1)),
    }));
    const tail = { id: 'tail', kind: 'turn', label: 'after', status: 'completed', startedAt: at(9000) };
    const { index } = built(ir([...humans, tail]));
    for (const h of humans) expect(index.byNode.get(h.id).endIdx).toBeNull();
    const chip = { kind: 'intervention', nodeIds: humans.map((h) => h.id) };
    expect(revealIndexOf(chip, index)).toBe(index.byNode.get('h2').startIdx);
    // "3 denials" is not yet true at the first or the second.
    expect(revealIndexOf(chip, index)).toBeGreaterThan(index.byNode.get('h1').startIdx);
  });

  it('a set no member of which is on the timeline cannot be positioned (−1: always shown)', () => {
    const { index } = built(ir([{ id: 'x', kind: 'turn', label: 'x', status: 'completed', startedAt: at(0) }]));
    expect(completionIndexOf(['ghost', 'phantom'], index)).toBe(-1);
    expect(completionIndexOf([], index)).toBe(-1);
    expect(completionIndexOf(null, index)).toBe(-1);
    expect(revealIndexOf(null, index)).toBe(-1);
    expect(revealIndexOf({ nodeIds: ['x', 'ghost'] }, index)).toBe(0);
  });
});

describe('schedule and tickAfter', () => {
  const evs = (ts) => ts.map((t, i) => ({ t: T0 + t, nodeId: `n${i}`, kind: 'start' }));
  const play = (sched, rate) => {
    let cursor = 0;
    let total = 0;
    let ticks = 0;
    for (;;) {
      const k = tickAfter(sched, cursor, rate);
      expect(k.cursor).toBeGreaterThanOrEqual(cursor);
      cursor = k.cursor;
      total += k.delayMs;
      ticks++;
      if (k.done) return { cursor, total, ticks };
      expect(ticks).toBeLessThan(100000); // never spins
    }
  };

  it('plays as a time-lapse at a fixed speed — 60× real time by default', () => {
    // A minute of the run is a second of play. The SHAPE of the run decides
    // how long it takes to watch; no run is squeezed to a fixed length.
    const s = schedule(evs([0, 60000, 120000]));
    expect(s.speed).toBe(60);
    expect(s.raw).toEqual([1000, 1000]);
    expect(s.delays).toEqual([1000, 1000]);
    expect(s.stride).toBe(1);
    expect(schedule(evs([0, 30000]), { speed: 30 }).delays).toEqual([1000]);
  });

  it('a ten-minute idle gap costs gapCapMs, not ten seconds of play', () => {
    const s = schedule(evs([0, 1000, 601000, 602000]));
    expect(s.raw[1]).toBe(1500);
    expect(s.delays[1]).toBe(1500);
    const custom = schedule(evs([0, 600000]), { gapCapMs: 700 });
    expect(custom.delays).toEqual([700]);
  });

  it('a burst is floored per event so it stays readable; raw stays unfloored', () => {
    const s = schedule(evs([0, 1, 2]));
    expect(s.raw).toEqual([1 / 60, 1 / 60]);
    expect(s.delays).toEqual([300, 300]);
    expect(s.totalMs).toBe(600);
    // Tool calls two seconds apart would be thirty a second at 60×; the
    // floor holds them at about three a second.
    expect(schedule(evs([0, 2000, 4000])).delays).toEqual([300, 300]);
  });

  it('play length scales with the run: short runs are short, long runs are long', () => {
    // Five minutes at one event every 10 s: 30 events, 9 s of play (10 s / 60
    // is under the floor, so each event takes the floor).
    const short = schedule(evs(Array.from({ length: 31 }, (_, i) => i * 10000)));
    expect(short.totalMs).toBe(30 * 300);
    // An hour at one event every 20 s: 180 events, one minute of play.
    const long = schedule(evs(Array.from({ length: 181 }, (_, i) => i * 20000)));
    expect(Math.round(long.totalMs)).toBe(60000);
    const played = play(long);
    expect(played.cursor).toBe(181);
    // Every event is played — nothing is ever skipped to hit a length.
    expect(played.ticks).toBe(181);
  });

  it('the demo-shaped run — 100 events over half an hour — plays in tens of seconds', () => {
    // 100 events a second apart with three ten-minute idle stretches: the
    // idle time IS the span. The stretches cost the cap, the working gaps the
    // floor, and the whole thing lands at ~33 s — by the run's shape, not by
    // decree.
    const ts = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      ts.push(t);
      t += i === 20 || i === 50 || i === 80 ? 600000 : 1000;
    }
    const s = schedule(evs(ts));
    for (const i of [20, 50, 80]) expect(s.raw[i]).toBe(1500);
    expect(s.delays.filter((d) => d === 300)).toHaveLength(96);
    expect(s.totalMs).toBe(96 * 300 + 3 * 1500);
  });

  it('a start followed by 14 calls at one millisecond yields 14 delays at the floor', () => {
    const events = [{ t: T0, nodeId: 'g', kind: 'start' }];
    for (let i = 1; i <= 14; i++) events.push({ t: T0, nodeId: 'g', kind: 'call', i });
    const s = schedule(events);
    expect(s.raw).toEqual(Array(14).fill(0));
    expect(s.delays).toEqual(Array(14).fill(300));
    expect(s.stride).toBe(1);
    const { ticks, total } = play(s);
    expect(ticks).toBe(15);
    expect(total).toBe(15 * 300);
  });

  it('tickAfter: floor from cursor 0, delays[cursor−1] per tick, rate scales the whole tick', () => {
    const s = schedule(evs([0, 100, 5000, 5001]));
    expect(tickAfter(s, 0)).toEqual({ cursor: 1, delayMs: 300, done: false });
    expect(tickAfter(s, 1)).toEqual({ cursor: 2, delayMs: s.delays[0], done: false });
    expect(tickAfter(s, 2)).toEqual({ cursor: 3, delayMs: s.delays[1], done: false });
    expect(tickAfter(s, 3)).toEqual({ cursor: 4, delayMs: s.delays[2], done: true });
    expect(tickAfter(s, 4)).toEqual({ cursor: 4, delayMs: 0, done: true });
    expect(tickAfter(s, 99)).toEqual({ cursor: 4, delayMs: 0, done: true });
    expect(tickAfter(s, 1, 2).delayMs).toBe(s.delays[0] / 2);
    expect(tickAfter(s, 0, 4).delayMs).toBe(75);
    // 2× halves the cap too: a capped idle gap waits 750, not 1500.
    expect(tickAfter(schedule(evs([0, 600000])), 1, 2).delayMs).toBe(750);
    // A caller that strides still gets the floor once per tick…
    const dense = { ...schedule(evs([0, 10, 20, 30, 40])), stride: 3 };
    expect(tickAfter(dense, 1)).toEqual({ cursor: 4, delayMs: 300, done: false });
    // …and real gaps summed.
    const wide = { ...schedule(evs([0, 60000, 120000, 180000])), stride: 2 };
    expect(tickAfter(wide, 1)).toEqual({ cursor: 3, delayMs: 2000, done: false });
  });

  it('an empty run has nothing to play; garbage schedules and options do not throw', () => {
    expect(schedule([]).delays).toEqual([]);
    expect(schedule([]).stride).toBe(1);
    expect(tickAfter(schedule([]), 0)).toEqual({ cursor: 0, delayMs: 0, done: true });
    expect(tickAfter(schedule(evs([0])), 0)).toEqual({ cursor: 1, delayMs: 300, done: true });
    expect(tickAfter(null, 3)).toEqual({ cursor: 0, delayMs: 0, done: true });
    expect(tickAfter({}, 0)).toEqual({ cursor: 0, delayMs: 0, done: true });
    expect(tickAfter({ raw: [5, 5] }, 0).cursor).toBe(1); // n falls back to raw.length + 1
    const s = schedule(evs([0, 60000]), { speed: 0, gapCapMs: -1, floorMs: NaN });
    expect(s.speed).toBe(60);
    expect(s.delays).toEqual([1000]);
    expect(schedule(null).delays).toEqual([]);
    expect(tickAfter(schedule(evs([0, 60000])), 1, 0).delayMs).toBe(1000); // rate 0 reads as 1
    expect(tickAfter(schedule(evs([0, 1000])), NaN).cursor).toBe(2); // non-number cursor = the end
  });
});

describe('cursorForTime and timeAtCursor', () => {
  // Five events at one instant, one before, one after.
  const events = [
    { t: 50, nodeId: 'a', kind: 'start' },
    ...[0, 1, 2, 3, 4].map((i) => ({ t: 100, nodeId: `b${i}`, kind: 'start' })),
    { t: 200, nodeId: 'c', kind: 'start' },
  ];

  it('addresses a position inside a tie group with k', () => {
    expect(cursorForTime(events, 100)).toBe(6); // the deep-link reading: t ≤ T
    expect(cursorForTime(events, 100, Infinity)).toBe(6);
    expect(cursorForTime(events, 100, 0)).toBe(1);
    expect(cursorForTime(events, 100, 2)).toBe(3);
    expect(cursorForTime(events, 100, 7)).toBe(6); // k past the group clamps to it
    expect(cursorForTime(events, 75, 3)).toBe(1); // k is moot off a tie
    expect(timeAtCursor(events, 3)).toEqual({ t: 100, k: 2 });
    expect(timeAtCursor(events, 6)).toEqual({ t: 100, k: 5 });
    expect(timeAtCursor(events, 7)).toEqual({ t: 200, k: 1 });
    expect(timeAtCursor(events, 0)).toEqual({ t: 50, k: 0 });
    for (let c = 0; c <= events.length; c++) {
      const r = timeAtCursor(events, c);
      expect(cursorForTime(events, r.t, r.k)).toBe(c);
    }
  });

  it('clamps: below the first → 0, above the last → length, non-finite → length', () => {
    expect(cursorForTime(events, 0)).toBe(0);
    expect(cursorForTime(events, 49.9)).toBe(0);
    expect(cursorForTime(events, 201)).toBe(7);
    expect(cursorForTime(events, NaN)).toBe(7);
    expect(cursorForTime(events, Infinity)).toBe(7);
    expect(cursorForTime(events, 'yesterday')).toBe(7);
    expect(cursorForTime(events, undefined)).toBe(7);
    expect(timeAtCursor(events, -3)).toEqual({ t: 50, k: 0 });
    expect(timeAtCursor(events, 99)).toEqual({ t: 200, k: 1 });
    expect(timeAtCursor(events, NaN)).toEqual({ t: 200, k: 1 });
    expect(timeAtCursor([], 0)).toEqual({ t: 0, k: 0 });
    expect(cursorForTime([], 5)).toBe(0);
    expect(cursorForTime(null, 5)).toBe(0);
    expect(timeAtCursor(null, 1)).toEqual({ t: 0, k: 0 });
  });
});

describe('degradation (spec §9)', () => {
  const tool = (id, over = {}) => ({ id, kind: 'tool', label: `Bash ×3`, status: 'completed', callCount: 3, errorCount: 0, ...over });

  it('no node with startedAt: every node still gets one start at t = 0, in IR order, and time still round-trips', () => {
    const graph = ir([
      { id: 'a', kind: 'turn', label: 'a', status: 'completed' },
      tool('b', { callOffsets: [0, 10, 20] }),
      { id: 'c', kind: 'turn', label: 'c', status: 'running' },
    ]);
    const { events, index } = built(graph);
    expect(events.filter((e) => e.kind === 'start').map((e) => e.nodeId)).toEqual(['a', 'b', 'c']);
    for (const e of events) expect(e.t).toBeGreaterThanOrEqual(0);
    expect(events[0].t).toBe(0);
    // No end for anyone: no endedAt, no startedAt for a duration to hang on.
    for (const id of ['a', 'b', 'c']) expect(index.byNode.get(id).endIdx).toBeNull();
    for (let c = 0; c <= events.length; c++) {
      const r = timeAtCursor(events, c);
      expect(cursorForTime(events, r.t, r.k)).toBe(c);
    }
    // The ×k count still climbs on the untimed offsets, relative to the carried start.
    expect(stateAt(graph, events, index.byNode.get('b').startIdx + 1, index).callsShown.get('b')).toBe(1);
    expect(stateAt(graph, events, events.length, index).callsShown.get('b')).toBe(3);
  });

  it('an untimed node materializes with its predecessor, not at epoch zero', () => {
    const graph = ir([
      { id: 'a', kind: 'turn', label: 'a', status: 'completed', startedAt: at(5000) },
      { id: 'b', kind: 'turn', label: 'b', status: 'completed' },
      { id: 'c', kind: 'turn', label: 'c', status: 'completed', startedAt: at(2000) },
    ]);
    const { events } = built(graph);
    expect(events.map((e) => [e.nodeId, e.t - T0])).toEqual([
      ['c', 2000],
      ['a', 5000],
      ['b', 5000],
    ]);
  });

  it('a LEADING untimed node materializes with its successor, not at epoch zero', () => {
    // A live claude-code workflow: its root carries no startedAt until the
    // manifest is written, and it is first in the IR. The carry rule has
    // nothing to carry from, so before the fix its start landed at 1970 and
    // schedule() saw a 56-year span — a real 30-minute run at the floor in
    // two seconds, and a readout saying 1970-01-01.
    const root = { id: 'root', kind: 'workflow', label: 'wf', status: 'running' };
    const a = { id: 'a', kind: 'agent', label: 'a', status: 'completed', startedAt: at(0), endedAt: at(500) };
    const b = { id: 'b', kind: 'agent', label: 'b', status: 'completed', startedAt: at(1000) };
    const graph = ir([root, a, b]);
    const { events, index } = built(graph);
    expect(events.map((e) => [e.nodeId, e.kind, e.t - T0])).toEqual([
      ['root', 'start', 0],
      ['a', 'start', 0],
      ['a', 'end', 500],
      ['b', 'start', 1000],
    ]);
    // The ORDER is the ordering rule's, untouched: the root still sorts first,
    // exactly where the pre-move signals.js put it.
    expect(runOrder(graph.nodes).map((n) => n.id)).toEqual(['root', 'a', 'b']);
    expect(legacyRunOrder(graph.nodes).map((n) => n.id)).toEqual(['root', 'a', 'b']);
    // The raised start leaves no 56-year gap for the schedule to compress:
    // the first wait is the floor, and the readout never says 1970.
    expect(schedule(events).raw[0]).toBe(0);
    expect(schedule(events).delays[0]).toBe(300);
    expect(timeAtCursor(events, 0).t).toBe(T0);
    expect(timeAtCursor(events, 1)).toEqual({ t: T0, k: 1 });
    expect(stateAt(graph, events, 1, index).present).toEqual(new Set(['root']));

    // Several leading untimed nodes rise together, and a leading tool group's
    // call offsets hang off the raised start, not off epoch zero.
    const two = ir([
      { id: 'u1', kind: 'turn', label: 'u1', status: 'completed' },
      { id: 'u2', kind: 'tool', label: 'Bash ×2', status: 'completed', callCount: 2, errorCount: 0, callOffsets: [0, 30] },
      a,
    ]);
    expect(buildTimeline(two).map((e) => [e.nodeId, e.kind, e.t - T0])).toEqual([
      ['u1', 'start', 0],
      ['u2', 'start', 0],
      ['a', 'start', 0],
      ['u2', 'call', 30],
      ['a', 'end', 500],
    ]);

    // An endedAt on a leading untimed node that precedes the raised start is
    // contradictory data (§9: end earlier than start) and yields no end event;
    // one at or after the raised start keeps its end. No start is invented
    // from an end.
    const endedEarly = { id: 'e', kind: 'turn', label: 'e', status: 'completed', endedAt: at(-100) };
    expect(buildTimeline(ir([endedEarly, a])).filter((e) => e.nodeId === 'e').map((e) => e.kind)).toEqual(['start']);
    const endedLater = { ...endedEarly, endedAt: at(200) };
    expect(buildTimeline(ir([endedLater, a])).filter((e) => e.nodeId === 'e').map((e) => [e.kind, e.t - T0])).toEqual([
      ['start', 0],
      ['end', 200],
    ]);

    // With no timed node anywhere there is nothing to raise to: §9's first
    // row stands, t = 0 throughout (pinned in full above).
    expect(buildTimeline(ir([root, { id: 'x', kind: 'turn', label: 'x', status: 'completed' }])).map((e) => e.t)).toEqual([0, 0]);
  });

  it('a malformed callOffsets is ignored, never partially used', () => {
    const shapes = {
      wrongLength: [0, 10],
      firstNotZero: [5, 10, 20],
      decreasing: [0, 20, 10],
      negative: [0, -1, 10],
      nonNumber: [0, '10', 20],
      nan: [0, NaN, 20],
      notArray: '0,10,20',
      singleCall: [0],
    };
    for (const [name, callOffsets] of Object.entries(shapes)) {
      const node = tool('g', { startedAt: at(0), endedAt: at(1000), callOffsets });
      if (name === 'singleCall') node.callCount = 1;
      expect(validCallOffsets(node), name).toBeNull();
      const graph = ir([node]);
      const { events, index } = built(graph);
      expect(events.filter((e) => e.kind === 'call'), name).toEqual([]);
      // The count is the node's own, whole, from the start — never desynchronised.
      expect(stateAt(graph, events, 1, index).callsShown.get('g'), name).toBe(node.callCount);
    }
    const good = tool('g', { startedAt: at(0), callOffsets: [0, 0, 20] });
    expect(validCallOffsets(good)).toEqual([0, 0, 20]);
    const { events } = built(ir([good]));
    expect(events.map((e) => [e.kind, e.i ?? null, e.t - T0])).toEqual([
      ['start', null, 0],
      ['call', 1, 0],
      ['call', 2, 20],
    ]);
    // Absent on a single-call node is the documented shape, not a defect.
    expect(validCallOffsets(tool('s', { callCount: 1 }))).toBeNull();
    expect(validCallOffsets(null)).toBeNull();
  });

  it('a tool endedAt earlier than startedAt yields no end event; a duration needs a real start', () => {
    const backwards = tool('g', { startedAt: at(5000), endedAt: at(4000) });
    const { events, index } = built(ir([backwards]));
    expect(events.map((e) => e.kind)).toEqual(['start']);
    expect(index.byNode.get('g').endIdx).toBeNull();
    // Garbage endedAt with a good duration falls through to the duration…
    const dur = { id: 't', kind: 'turn', label: 't', status: 'completed', startedAt: at(0), endedAt: 'soon', durationMs: 3000 };
    expect(buildTimeline(ir([dur])).map((e) => [e.kind, e.t - T0])).toEqual([['start', 0], ['end', 3000]]);
    // …but a duration hung off a carried-forward start would be an invented end.
    const borrowed = { id: 'u', kind: 'turn', label: 'u', status: 'completed', durationMs: 3000 };
    expect(buildTimeline(ir([dur, borrowed])).filter((e) => e.nodeId === 'u').map((e) => e.kind)).toEqual(['start']);
    // A negative duration is not an end either; a zero one is (an instant node).
    expect(buildTimeline(ir([{ ...dur, endedAt: undefined, durationMs: -1 }])).map((e) => e.kind)).toEqual(['start']);
    expect(buildTimeline(ir([{ ...dur, endedAt: undefined, durationMs: 0 }])).map((e) => e.kind)).toEqual(['start', 'end']);
  });

  it('a turn ending at the instant the next begins reads in order', () => {
    const a = { id: 'a', kind: 'turn', label: 'a', status: 'completed', startedAt: at(0), endedAt: at(1000) };
    const b = { id: 'b', kind: 'turn', label: 'b', status: 'completed', startedAt: at(1000), endedAt: at(2000) };
    expect(buildTimeline(ir([a, b])).map((e) => `${e.nodeId}:${e.kind}`)).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  // Spec §10, the bundle bullet: "a bundle fixture written before this change
  // opens with the timeline at node granularity". A pre-replay bundle carries
  // no `callOffsets` and no tool `endedAt` — exactly a parsed IR with those
  // two fields deleted from every tool node (SCHEMA.md: `durationMs` is never
  // on a tool node, so nothing else can manufacture a tool end). Over the
  // real claude-code corpus rather than a synthetic node, so the shape being
  // degraded is the one the adapter actually writes.
  it('a bundle written before this change opens at node granularity: no call events, groups whole, no tool end', async () => {
    const runs = await loadCorpus(CORPORA.find((c) => c.name === 'claude-code'));
    let stripped = 0;
    let multi = 0;
    for (const { ir: fresh } of runs) {
      const old = {
        ...fresh,
        nodes: fresh.nodes.map((n) => {
          if (n.kind !== 'tool') return n;
          const { callOffsets, endedAt, ...rest } = n;
          if (callOffsets !== undefined || endedAt !== undefined) stripped++;
          return rest;
        }),
      };
      const events = buildTimeline(old);
      const index = indexEvents(events);
      expect(events.filter((e) => e.kind === 'call')).toEqual([]);
      for (const n of old.nodes) {
        if (n.kind !== 'tool') continue;
        const e = index.byNode.get(n.id);
        expect(e, n.id).toBeDefined();
        expect(e.endIdx, n.id).toBeNull();
        expect(e.callIdxs, n.id).toEqual([]);
        // The group appears WHOLE at its start: full count from the first
        // cursor at which it is present, and its own status — never running.
        const first = stateAt(old, events, e.startIdx + 1, index);
        expect(first.present.has(n.id), n.id).toBe(true);
        expect(first.callsShown.get(n.id), n.id).toBe(n.callCount);
        expect(first.status.get(n.id), n.id).toBe(n.status);
        if ((n.callCount ?? 1) > 1) multi++;
      }
      // Every other node still steps: the run is node-granular, not empty.
      expect(events.filter((e) => e.kind === 'start').length).toBe(old.nodes.length);
    }
    // Not vacuous: the corpus carried the fields to strip, and multi-call
    // groups whose `×N` would have counted up were among them.
    expect(stripped).toBeGreaterThan(0);
    expect(multi).toBeGreaterThan(0);
  });

  it('null and garbage input never throws', () => {
    for (const bad of [null, undefined, 42, 'ir', {}, { nodes: null }, { nodes: 'x', edges: 7 }]) {
      expect(buildTimeline(bad)).toEqual([]);
      const s = stateAt(bad, buildTimeline(bad), 3);
      expect(s.cursor).toBe(0);
      expect(s.present.size).toBe(0);
      expect(runOrder(bad?.nodes)).toEqual([]);
    }
    const hostile = {
      nodes: [null, 7, 'x', { id: '' }, { id: 5 }, { id: 'ok', startedAt: {} }, { id: 'ok2', kind: 'tool', callCount: 'many', callOffsets: [0, 1], startedAt: 12 }],
      edges: [null, 'e', { id: 'e1', kind: 'return', from: 'ok', to: null }, { kind: 'sequence', from: 'ok', to: 'ok2' }],
    };
    const events = buildTimeline(hostile);
    expect(events.map((e) => e.nodeId)).toEqual(['ok', 'ok2']);
    const s = stateAt(hostile, events, 1);
    expect(s.present).toEqual(new Set(['ok']));
    expect(s.edgePresent.has('e1')).toBe(true); // `to: null` is not in the index → present
    expect(stateAt(hostile, events, 'later').cursor).toBe(2);
    expect(indexEvents([null, { kind: 'end' }, { nodeId: 'z', kind: 'end' }]).byNode.get('z')).toEqual({ startIdx: 2, endIdx: 2, callIdxs: [] });
    expect(indexEvents(null).byNode.size).toBe(0);
    expect(stateAt({ nodes: [{ id: 'q' }] }, events, 0, null).present.has('q')).toBe(true); // no index entry → present
  });
});

describe('runOrder', () => {
  it('matches the pre-move rule on missing, unparseable and tied timestamps', () => {
    const nodes = [
      { id: 'a', startedAt: at(10000) },
      { id: 'b' },
      { id: 'c', startedAt: 'garbage' },
      { id: 'd', startedAt: at(5000) },
      { id: 'e', startedAt: at(5000) },
      { id: 'f', startedAt: at(10000) },
      { id: 'g', startedAt: null },
    ];
    const ids = runOrder(nodes).map((n) => n.id);
    expect(ids).toEqual(legacyRunOrder(nodes).map((n) => n.id));
    // Pinned explicitly, so the rule is asserted rather than merely shared:
    // carried-forward times land an untimed node beside the LAST timed node
    // before it in the array, and ties keep array order.
    expect(ids).toEqual(['d', 'e', 'a', 'b', 'c', 'f', 'g']);
    expect(runOrder(nodes).map((n) => n)).toEqual(runOrder(nodes)); // same objects, reordered
    expect(runOrder(null)).toEqual([]);
    expect(runOrder('nodes')).toEqual([]);
    expect(runOrder([])).toEqual([]);
  });
});

describe('performance', () => {
  it('stateAt over a 10,000-event / 2,000-node graph is O(nodes + edges), well under a frame', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 2000; i++) {
      nodes.push({
        id: `n${i}`,
        kind: 'tool',
        label: 'Bash ×4',
        status: i % 7 === 0 ? 'error' : 'completed',
        callCount: 4,
        errorCount: i % 7 === 0 ? 4 : 0,
        callOffsets: [0, 10, 20, 30],
        startedAt: at(i * 1000),
        endedAt: at(i * 1000 + 40),
      });
      if (i > 0) edges.push({ id: `e${i}`, kind: 'sequence', from: `n${i - 1}`, to: `n${i}` });
    }
    const graph = ir(nodes, edges);
    const events = buildTimeline(graph);
    expect(events).toHaveLength(10000);
    const index = indexEvents(events);
    let worst = 0;
    for (const cursor of [0, 2500, 5000, 7500, 10000, 4999, 1]) {
      const t0 = performance.now();
      const s = stateAt(graph, events, cursor, index);
      worst = Math.max(worst, performance.now() - t0);
      expect(s.present.size).toBe(Math.min(2000, Math.ceil(cursor / 5)));
    }
    expect(worst).toBeLessThan(200);
    // The identity guard holds at scale too.
    const s = stateAt(graph, events, events.length, index);
    expect(s.present.size).toBe(2000);
    expect(s.edgePresent.size).toBe(1999);
    for (const n of nodes) expect(s.callsShown.get(n.id)).toBe(4);
  });
});

// The frontend imports this module straight out of src/ so the human's
// scrubber and any agent-side timeline can never disagree. A single `node:`
// import would break the bundle — and would be found at build time, not
// here, so assert it. Same guard as tests/find.test.js.
describe('purity', () => {
  it('imports nothing, so the frontend bundle can consume it', async () => {
    const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'timeline.js'), 'utf8');
    // Comments are allowed to *mention* node: — only the code must be clean.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\(|['"]node:|process\./);
  });
});
