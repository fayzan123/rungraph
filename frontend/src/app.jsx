import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchIndex, fetchGraph, watchGraph, applyDelta } from './api.js';
import { Canvas } from './canvas.jsx';
import { Inspector } from './inspector.jsx';
import { Strip, SIGNAL_GLYPHS } from './strip.jsx';
import { ReplayBar } from './replay-bar.jsx';
import { ExportDialog } from './export.jsx';
import { ResumePopover } from './resume.jsx';
import {
  safeTimeline,
  cursorOf,
  openReplay,
  seekTo,
  stepFrom,
  planTick,
  applyTick,
  currentNodeId,
  visibleSignals as revealedSignals,
  markersFor,
  readoutFor,
  completionCursor,
  nextRate,
} from './replay.js';
import {
  adapterName,
  focusFromAgent,
  focusFromFile,
  focusFromFind,
  focusFromSignal,
  newHighSignalIds,
  pruneFocus,
  refocus,
  signalKey,
} from './focus.js';
import { adapterChips, groupKeyFor, groupRuns } from './picker-groups.js';
import { buildFocusHash, descriptorFromFocus, parseFocusHash } from '../../src/deeplink.js';
import {
  classifyCoverage,
  coverageLabel,
  strongerCoverage,
  unknownTypeSummary,
} from '../../src/coverage.js';
import { stateAt, timeAtCursor } from '../../src/timeline.js';

// One shared empty list for "nothing yet" (no timeline, no signals), so the
// memos keyed on it see one identity from render to render, not a fresh `[]`.
const EMPTY = [];

// How long the layout may be missing before the replay bar reads as disabled.
// Longer than one elk run on a live delta (~20 ms; 50–150 ms on a large run),
// shorter than a wait the user would notice.
const LAYOUT_STALE_MS = 150;

// Embed mode — the landing page (site/) mounts the real app inside a page that
// owns its own URL. Set by the page before app.js loads; absent everywhere
// else. The bridge exposes the SAME internal producers a click or a deep link
// would use (focusFromSignal + pan, the find opener) — never synthetic DOM
// events — so the page's guided chips cannot drift from real behavior.
const EMBED = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;

// Embedded on a phone, the inspector cannot share the width with the canvas —
// it overlays instead (page CSS), so it must start CLOSED and appear only
// while something is selected, or it eats the whole portrait screen.
const embedNarrow = () =>
  Boolean(EMBED) && typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches;

export function App() {
  const [index, setIndex] = useState(null);
  // A deep link (#run=…&sel=…&f=…) wins over the plain ?run= param: the hash
  // carries focus state the search param cannot.
  const [runId, setRunId] = useState(
    () =>
      EMBED?.runId ??
      parseFocusHash(location.hash)?.runId ??
      new URLSearchParams(location.search).get('run'),
  );
  const [graph, setGraph] = useState(null);
  const [graphError, setGraphError] = useState(null);
  const [selection, setSelection] = useState(null); // {type:'node'|'edge', id}
  // Bumped when a node is chosen from OUTSIDE the canvas (inspector list, a
  // find match, Enter in the find box): the canvas then pans to it. Clicks on
  // the canvas itself never bump it — the node is already under the cursor.
  const [revealSeq, setRevealSeq] = useState(0);
  const revealNode = (id) => {
    setSelection({ type: 'node', id });
    setRevealSeq((n) => n + 1);
  };
  const [follow, setFollow] = useState(true);
  const [connected, setConnected] = useState(true);

  // Exactly one FocusSet, three consumers: canvas, strip, inspector.
  const [focus, setFocus] = useState(null);
  const [focusSeq, setFocusSeq] = useState(0); // bumps only on an agent's answer
  const [findOpen, setFindOpen] = useState(false);
  const [findSeq, setFindSeq] = useState(0); // bumps on every open request, even when already open
  const [query, setQuery] = useState('');
  const [note, setNote] = useState(null); // transient, strip-sized; never a banner
  const [escalated, setEscalated] = useState(false);
  const [panes, setPanes] = useState(loadPanes);
  const [switchedFrom, setSwitchedFrom] = useState(null); // undo for an agent-driven run switch
  const [resumePop, setResumePop] = useState(null); // { entry, anchor } — the resume popover
  const [linkMiss, setLinkMiss] = useState(null); // deep link to a run this server lacks
  const [linkSeq, setLinkSeq] = useState(0); // bumps when a deep link arrives without a reload
  const pendingFocus = useRef(null); // an agent's focus, waiting for its own graph
  const pendingLink = useRef(parseFocusHash(location.hash)); // a deep link, waiting for its graph
  const seenHigh = useRef(new Set()); // `high` signal ids the user has looked at
  const primed = useRef(false); // has this run's baseline been taken yet
  const graphRef = useRef(null); // the SSE closure outlives every graph it sees
  // The coverage verdict, sticky per runId. Lives here rather than in the
  // Canvas because the graph does, and neither this component nor the Canvas
  // is remounted on a run switch — see the caveat computed below.
  const coverageSticky = useRef({ runId: null, verdict: 'none' });

  // Replay — the graph at a moment. Exactly ONE playhead value lives here, the
  // FocusSet pattern again: the canvas, the strip, the inspector, the minimap
  // and the bar all derive what they show from `stateAt()` over the same
  // cursor, so no two of them can describe different moments.
  //   null              closed — the app renders EXACTLY as it did before replay
  //   { mode: 'edge' }  open, pinned to the newest event; follows live deltas
  //   { mode: 'at', t, k? }  detached at wall-clock t (k = position inside a
  //                     tie group, so stepping stays one event and a live
  //                     re-parse never moves the playhead)
  const [replay, setReplay] = useState(null);
  const [playing, setPlaying] = useState(false); // meaningful only while replay !== null
  const [rate, setRate] = useState(1); // 0.5 | 1 | 2 | 4 — multiplies the schedule's fixed speed
  // The pending tick, for the bar's running clock: { fromT, toT, at, delayMs }
  // while play is waiting on one, null otherwise.
  const [tickInfo, setTickInfo] = useState(null);
  const [scrubbing, setScrubbing] = useState(false); // the bar's drag is in flight
  const [layoutReady, setLayoutReady] = useState(false); // Canvas reports elk landing
  // Bumped on every DISCRETE replay move and every play tick — the canvas's
  // follow-camera keys on it, like `revealSeq`. A drag's intermediate seeks do
  // not bump it (the release does): a camera chasing every pointer move under
  // a scrub would fight the hand holding the mouse.
  const [replayCursorSeq, setReplayCursorSeq] = useState(0);
  // The play loop and the agent hook run from timers and the SSE closure, both
  // of which outlive the render they were created in — so they read the
  // playhead, the timeline, the rate and liveness through refs kept current on
  // every render, never through a closure that may be a delta or two stale.
  const replayRef = useRef(null);
  const timelineRef = useRef(null);
  const rateRef = useRef(1);
  const liveRef = useRef(false);
  const playingRef = useRef(false);
  const tickPlan = useRef(null); // { from, at } — the cursor the pending tick was planned from, and when
  // A play whose last tick has landed and is waiting for the render after it
  // to stop — see the effect keyed on `replayCursorSeq` below.
  const finishing = useRef(false);
  // The selection in flight was made by the PLAYHEAD (a tick, a step, a
  // seek), not by a tap. Consumed once per render, below; the narrow embed's
  // pane effect is the one reader.
  const selByPlayheadRef = useRef(false);

  // THE ONLY WRITERS of `replay` and `playing`: the ref is written with the
  // state, never after it. Both are read by handlers and timers that can fire
  // between renders (a key repeat, a step during play, the tick callback),
  // so a ref that trailed the state by a render would step from a stale
  // playhead or tick once more after a pause. And the per-render sync effect
  // below deliberately does NOT touch these two: Preact flushes a render's
  // still-pending effects at the top of the next render, with their OLD
  // closures — so a sync effect would write the previous value back over the
  // one a producer had just set, and the ref would read stale until the new
  // render's effects flushed (a held → lost steps; a 2× play in a background
  // tab, where rAF is paused, re-planned the same tick).
  const setReplayNow = (v) => {
    replayRef.current = v;
    setReplay(v);
  };
  const setPlayingNow = (v) => {
    // Starting a play cancels a stop still waiting on the render after the
    // last tick of the previous one (space twice inside one frame).
    if (v) finishing.current = false;
    playingRef.current = v;
    setPlaying(v);
  };

  // Run index, refreshed for live badges.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchIndex().then((d) => alive && setIndex(d)).catch(() => {});
    load();
    // Static embed: the baked index cannot change, so polling it is noise.
    const t = EMBED ? null : setInterval(load, 15000);
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, []);

  // Selected run: initial graph fetch + SSE live tail.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    setGraph(null);
    setGraphError(null);
    setSelection(null);
    // Focus, find and the escalation baseline are all per-run.
    setFocus(null);
    setFindOpen(false);
    setQuery('');
    setNote(null);
    setLinkMiss(null);
    setResumePop(null);
    setEscalated(false);
    // Replay is per-run too: a playhead is a position in THIS run's events,
    // and a pending tick must not fire into the next run's graph.
    setReplayNow(null);
    setPlayingNow(false);
    setScrubbing(false);
    seenHigh.current = new Set();
    primed.current = false;
    fetchGraph(runId)
      .then((g) => alive && setGraph((cur) => cur ?? g))
      .catch((e) => alive && setGraphError(String(e.message ?? e)));
    const unwatch = watchGraph(
      runId,
      (msg) => {
        if (!alive) return;
        if (msg.type === 'focus') {
          // The agent answered in the user's terminal and asked the graph to
          // light up. Stash it rather than applying it here: the answer may be
          // about a run this tab has not loaded (or has not even switched to
          // yet), and pruning against the wrong graph would throw it away.
          const f = focusFromAgent(msg);
          if (!f) return;
          const target = msg.runId ?? runId;
          if (target !== runId) {
            // A tab already showing that run will take it; two tabs both
            // lurching onto the same run is worse than one staying put.
            if (msg.alreadyWatching) return;
            // Otherwise follow the answer, and remember where we were so the
            // user can get back with one click.
            pendingFocus.current = { runId: target, focus: f };
            setSwitchedFrom({ runId, title: graphRef.current?.meta?.title ?? null });
            setRunId(target);
            return;
          }
          pendingFocus.current = { runId: target, focus: f };
          applyPendingFocus(graphRef.current);
          return;
        }
        setGraph((cur) => applyDelta(cur, msg));
      },
      (ok) => alive && setConnected(ok),
    );
    // The embedding page owns its URL (its own anchors live in the hash); the
    // run param is the dashboard's concern only.
    if (!EMBED) {
      const url = new URL(location.href);
      url.searchParams.set('run', runId);
      // A consumed or bypassed deep link must not linger in the address bar —
      // copying it there would hand someone a link to a run you already left.
      if (parseFocusHash(url.hash)?.runId !== runId) url.hash = '';
      history.replaceState(null, '', url);
    }
    return () => {
      alive = false;
      unwatch();
    };
  }, [runId]);

  const currentRun = useMemo(
    () => index?.runs?.find((r) => r.runId === runId),
    [index, runId],
  );
  const live = currentRun?.active ?? false;
  // Paths are stored as the adapter observed them; only the display is relative,
  // and the project root comes from the index entry — IR meta does not carry one.
  const project = currentRun?.project;

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  // ---- replay: the run as events, and the graph at the playhead ------------
  // Built ONCE per graph (events, per-node index, schedule) — never per frame.
  // `safeTimeline` never throws: a run whose timeline cannot be built keeps
  // rendering exactly as today, with the replay button disabled and the error
  // in its title (spec §9). Replay is an enhancement, never a render dependency.
  const timeline = useMemo(() => (graph ? safeTimeline(graph) : null), [graph]);
  const events = timeline?.events ?? EMPTY;
  const replayAvailable = Boolean(graph && timeline && !timeline.error);
  // The cursor is DERIVED, never stored: `events.length` at the edge, and the
  // stored timestamp's position in `at` mode — so a live re-parse that
  // renumbers events leaves the playhead where the user put it, and a link's
  // `t=` lands by the same rule.
  const cursor = cursorOf(replay, events);
  // null means closed, and every consumer treats null as "the graph as today".
  // At cursor === events.length this is the graph exactly as it renders
  // without replay — the identity guard `tests/timeline.test.js` pins.
  const state = useMemo(
    () => (replay !== null && replayAvailable ? stateAt(graph, events, cursor, timeline.index) : null),
    [graph, timeline, replay, cursor, replayAvailable],
  );
  // What the strip, the inspector and the canvas badges show: the signals the
  // playhead has REVEALED (a storm is never badged before it was one), or the
  // whole run when closed. Nothing is re-derived on the client — only revealed.
  const visibleSignals = useMemo(
    () => (state ? revealedSignals(graph.signals, timeline.index, cursor) : (graph?.signals ?? EMPTY)),
    [graph, timeline, state, cursor],
  );
  const curNodeId = replay !== null ? currentNodeId(events, cursor) : null;
  // SELECTION follows every tick; the DETAIL FETCH waits for the playhead to
  // rest. The inspector's header, status, files and signals come straight from
  // the IR and cost nothing, so they can follow at 25 ticks a second; a
  // transcript request per tick would be 25 requests a second and a "loading
  // transcript…" flash on each. `settled` is what NodeDetail debounces on.
  const settled = !playing && !scrubbing;
  // The bar's markers — human turns and signal reveal points — by position
  // only. SIGNAL_GLYPHS is handed in because the pure module cannot import
  // strip.jsx.
  // Keyed on the bar being OPEN (a boolean, not the playhead value, which
  // changes every tick), and not built at all while it is closed: the closed
  // path does no replay work beyond the timeline the header button needs.
  const replayOpen = replay !== null;
  const markers = useMemo(
    () => (replayOpen && replayAvailable ? markersFor(graph, timeline.index, SIGNAL_GLYPHS) : EMPTY),
    [graph, timeline, replayOpen, replayAvailable],
  );
  // The inspector's view of the moment: the playhead's own timestamp (the
  // event it sits on), its clock form, and what the tool detail needs to
  // ghost the calls that have not happened yet.
  const inspectorReplay = useMemo(
    () =>
      replay !== null && replayAvailable
        ? {
            cursor,
            total: events.length,
            t: timeAtCursor(events, cursor).t,
            timed: timeline.timed,
            state,
            index: timeline.index,
            clock: readoutFor(events, cursor, timeline.timed).clock,
          }
        : null,
    [replay, replayAvailable, cursor, events, timeline, state],
  );

  // Kept current on EVERY render, and declared ahead of the play loop below
  // (effects run in declaration order), so a tick planned after a live delta
  // plans on the delta's timeline, not the one the loop was started with.
  // Only the values with no synchronous writer live here — `replayRef` and
  // `playingRef` are written by `setReplayNow` / `setPlayingNow` alone (see
  // there for why a sync effect would regress them).
  useEffect(() => {
    timelineRef.current = timeline;
    rateRef.current = rate;
    liveRef.current = live;
  });

  /**
   * Every replay-driven cursor change goes through here: a seek, a step, a
   * marker click, ⏮, a play tick, the agent hook, the embed's play(). The ref
   * is written SYNCHRONOUSLY so a tick that fires before the next render
   * plans from where the user just put the playhead, not from where it was.
   *
   * Selection follows the playhead: the inspector shows the node that has just
   * happened, so the user steps ← and reads the lead-up without clicking; at
   * cursor 0 nothing has happened and nothing is selected. A drag's
   * intermediate moves are `transient` — they move the selection but leave
   * `replayCursorSeq` alone, so the camera waits for the release rather than
   * fighting the hand on the mouse. NOT called on the per-render re-derivation
   * a live delta causes: the playhead did not move, the run grew.
   */
  const moveReplay = (next, { transient = false } = {}) => {
    setReplayNow(next);
    const ev = timelineRef.current?.events ?? EMPTY;
    const c = cursorOf(next, ev);
    // Flagged as the playhead's pick, not a tap: the narrow embed's pane
    // rides taps only (see the effect on `selection` below).
    selByPlayheadRef.current = true;
    setSelection(c > 0 ? { type: 'node', id: currentNodeId(ev, c) } : null);
    if (!transient) setReplayCursorSeq((n) => n + 1);
  };

  // Opening always lands at the EDGE — on a finished run that is simply the
  // end, so "at the end" and "pinned to the edge" are one state and there is
  // one opening rule. On a live run the edge is the live tail, so the existing
  // follow re-engages exactly as the header toggle would.
  const openReplayBar = () => {
    if (!replayAvailable) return;
    setReplayNow(openReplay());
    if (live) setFollow(true);
  };
  const closeReplay = () => {
    setReplayNow(null);
    setPlayingNow(false);
    setScrubbing(false);
  };
  const toggleReplay = () => (replayRef.current === null ? openReplayBar() : closeReplay());
  const seekReplay = (c, opts) => {
    if (replayRef.current === null) return;
    moveReplay(seekTo(timelineRef.current?.events ?? EMPTY, c), opts);
  };
  // Stepping while playing pauses first: a step is the user taking the wheel,
  // and a tick landing on top of it would move the playhead twice.
  const stepReplay = (dir) => {
    if (replayRef.current === null) return;
    if (playingRef.current) setPlayingNow(false);
    moveReplay(stepFrom(replayRef.current, timelineRef.current?.events ?? EMPTY, dir));
  };
  const togglePlay = () => {
    if (replayRef.current === null) return;
    if (playingRef.current) return setPlayingNow(false);
    const tl = timelineRef.current;
    if (!tl || tl.error) return;
    // ▶ at the end means from the start — the alternative is a play button
    // that does nothing, since the first tick would be `done` before it moved.
    if (cursorOf(replayRef.current, tl.events) >= tl.events.length) moveReplay(seekTo(tl.events, 0));
    setPlayingNow(true);
  };
  const pauseReplay = () => setPlayingNow(false);
  // `live`: back to the edge with follow re-engaged. Playing at the edge has
  // nothing to advance to, so it stops here rather than firing a `done` tick.
  const goLive = () => {
    setReplayNow(openReplay());
    setPlayingNow(false);
    setFollow(true);
  };
  // A number is taken as the rate the bar wants; anything else is the bar
  // saying "the next one", and the cycle is the pure module's, not ours.
  const setReplayRate = (r) => setRate(typeof r === 'number' && Number.isFinite(r) ? r : nextRate(rateRef.current));

  // The play loop: plan → wait → apply → repeat until `done`. Keyed on
  // [playing, graph, rate] and NOT on `replay`: the loop advances the playhead
  // itself, and re-keying on its own output would restart the timer on every
  // tick. A graph change (a live delta) re-runs it so the next tick is planned
  // on the delta's schedule; the time already waited on the interrupted tick
  // is credited back, because a live run delivering deltas faster than a
  // 1.5 s compressed gap would otherwise never get to fire that tick at all.
  //
  // Also keyed on `scrubbing`: while the hand is on the scrubber no tick
  // fires — a tick landing under a held pointer moves the playhead out from
  // under it — and `playing` stays true, so the release is where play
  // resumes from (the release's seek writes the ref before this re-arms).
  useEffect(() => {
    if (!playing || scrubbing) {
      tickPlan.current = null;
      setTickInfo(null);
      return;
    }
    let timer = null;
    const arm = () => {
      const tl = timelineRef.current;
      const cur = replayRef.current;
      if (cur === null || !tl || tl.error || !tl.sched) return setPlayingNow(false);
      const from = cursorOf(cur, tl.events);
      const tick = planTick(cur, tl.events, tl.sched, rateRef.current);
      const now = Date.now();
      const prev = tickPlan.current;
      const waited = prev && prev.from === from ? now - prev.at : 0;
      if (!prev || prev.from !== from) tickPlan.current = { from, at: now };
      // What the bar's clock runs between while this tick waits: the run's
      // time at the playhead now and at the event the tick lands on, over the
      // wait that is actually left (a re-armed tick credits time waited).
      setTickInfo({
        fromT: timeAtCursor(tl.events, from).t,
        toT: timeAtCursor(tl.events, tick.cursor).t,
        at: now - waited,
        delayMs: tick.delayMs,
      });
      timer = setTimeout(() => {
        timer = null;
        tickPlan.current = null;
        // Effects flush after paint, so a close or a pause can land BEFORE
        // the cleanup that clears this timer: neither may tick once more
        // (a close would reopen the bar; a step, which pauses first, would
        // move the playhead twice).
        if (replayRef.current === null || !playingRef.current) return;
        // A seek while the tick was pending — a marker click, ⏮, the agent
        // hook — moved the playhead: this plan is stale. Continue from where
        // the user put it rather than snapping back to where the tick was
        // going. (The ref is written synchronously by every seek, so this
        // comparison sees the seek before any render does.)
        if (cursorOf(replayRef.current, tl.events) !== from) return arm();
        if (tick.done) {
          // Reaching the end hands back to the edge; on a live run that is the
          // live tail again, so the existing follow re-engages. The STOP
          // waits for the render after this move — see `finishing` below.
          finishing.current = true;
          moveReplay(applyTick(tl.events, tick));
          if (liveRef.current) setFollow(true);
          return;
        }
        moveReplay(applyTick(tl.events, tick));
        arm();
      }, Math.max(0, tick.delayMs - waited));
    };
    arm();
    // Pause, close, run switch, rate change, live delta and unmount all pass
    // through here: nothing fires after the effect that armed it is gone.
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [playing, graph, rate, scrubbing]);

  // The last tick of a play lands the playhead at the edge, and the play
  // stops ONE RENDER LATER, on purpose. Stopped in the same batch, the canvas
  // would be handed `playing === false` beside the very bump that tick made,
  // and its follow-camera would read the final advance as a discrete seek —
  // panning to the last node for a user who had wheeled away mid-play, which
  // is exactly what "any manual pan ends following for the rest of that
  // play" forbids. So the tick moves with `playing` still true — the camera
  // effect that render creates carries `true` in its closure whether it
  // flushes after paint or at the top of the next render — and this effect,
  // keyed on the bump the tick made, stops. A play started inside that
  // one-render window clears the flag (`setPlayingNow`), so it is never
  // stopped by the play before it.
  useEffect(() => {
    if (!finishing.current) return;
    finishing.current = false;
    setPlayingNow(false);
  }, [replayCursorSeq]);

  // The Canvas reports `layoutReady` false at the top of EVERY elk run — one
  // per live delta — and elk lands ~20 ms later. Handed straight to the bar,
  // that is a disabled blink per delta on a busy run, and a focused bar
  // button losing focus each time. The bar reads "disabled" only once the
  // layout has been missing longer than a blink; it re-enables at once. The
  // old layout is on screen for that window, so a seek inside it draws over
  // a layout that exists — the state the disable guards against (spec §9,
  // nothing to scrub over) is the long one, not the blink.
  const [layoutStale, setLayoutStale] = useState(true);
  useEffect(() => {
    if (layoutReady) {
      setLayoutStale(false);
      return;
    }
    const t = setTimeout(() => setLayoutStale(true), LAYOUT_STALE_MS);
    return () => clearTimeout(t);
  }, [layoutReady]);

  // A delta that leaves the run without a usable timeline closes the bar: the
  // graph renders as today rather than over a state that no longer exists.
  useEffect(() => {
    if (replay !== null && graph && !replayAvailable) closeReplay();
  }, [replayAvailable, graph]);

  /**
   * Apply an agent's focus once the graph it points into is actually loaded.
   * Called both from the SSE handler (same run, graph already in hand) and from
   * the effect below (after a run switch, or after a tab opened cold and the
   * server replayed a focus it was holding).
   */
  const applyPendingFocus = (g) => {
    const p = pendingFocus.current;
    if (!p || !g || g.meta?.runId !== p.runId) return;
    pendingFocus.current = null;
    // An agent has driven this dashboard at least once, so the inspector can
    // stop showing setup instructions to someone who is clearly set up.
    try {
      localStorage.setItem('rungraph.agentSeen', '1');
    } catch {
      /* storage unavailable — the hint simply keeps showing */
    }
    // Ids can be quoted from a graph read moments ago. If none of them are
    // here, dimming the entire canvas is worse than doing nothing.
    const pruned = pruneFocus(p.focus, g);
    if (!pruned) return setNote('your agent pointed at nodes not in this run');
    // The agent end of the loop, with the bar open: the playhead moves to the
    // moment the focused set was COMPLETE — the same rule a signal reveals by,
    // so the last of them has just happened — and the user steps ← for the
    // lead-up. "These nodes" gains "and this is when". None of them on the
    // timeline → the playhead stays put; bar closed → exactly the lines below.
    if (replayRef.current !== null) {
      const tl = timelineRef.current;
      if (tl && !tl.error) {
        const c = completionCursor(pruned.nodeIds, tl.index);
        if (c !== null) moveReplay(seekTo(tl.events, c));
      }
    }
    setFocus(pruned);
    setFocusSeq((n) => n + 1); // only an agent's answer moves the viewport
  };

  useEffect(() => applyPendingFocus(graph), [graph]);

  /**
   * Deep-link restore: once the linked run's graph is in hand, replay the
   * descriptor through the SAME producers a live click would use — find,
   * signal and file descriptors re-execute (one matcher, one derivation, one
   * attribution source, so a link and a fresh query can never disagree), and
   * only agent-sourced sets are explicit ids. The view pans: the user clicked
   * a link, so the view should have moved.
   */
  // A link pasted into an ALREADY-OPEN tab changes only the hash — no reload,
  // no mount. Catching hashchange makes those links work too.
  useEffect(() => {
    const onHash = () => {
      const link = parseFocusHash(location.hash);
      if (!link) return;
      pendingLink.current = link;
      setSwitchedFrom(null);
      setRunId(link.runId);
      setLinkSeq((n) => n + 1); // same-run links re-apply without a graph change
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const link = pendingLink.current;
    if (!link || !graph || graph.meta?.runId !== link.runId) return;
    pendingLink.current = null;
    // `t=` restores the playhead in `at` mode and opens the bar. The cursor is
    // derived from the timestamp (`cursorOf` → `cursorForTime`), so the link
    // survives a re-parse and works on bundles; a `t` outside the run's span
    // clamps to the nearest end. No `k`: a link means "every event at t has
    // happened". A hash without `t` leaves replay exactly as it was.
    if (link.t && replayAvailable) {
      const t = Date.parse(link.t);
      if (Number.isFinite(t)) {
        setReplayNow({ mode: 'at', t });
        // A link is a discrete move like any other: the user clicked it, so
        // the view should land on the moment it names, not on the run's
        // opening frame with the playhead's node somewhere off screen.
        setReplayCursorSeq((n) => n + 1);
      }
    }
    if (link.sel && graph.nodes.some((n) => n.id === link.sel)) {
      setSelection({ type: 'node', id: link.sel });
    }
    const d = link.descriptor;
    if (!d) return;
    let f = null;
    if (d.source === 'find') {
      setFindOpen(true);
      setQuery(d.query);
      f = focusFromFind(graph, d.query);
    } else if (d.source === 'signal') {
      const sig = (graph.signals ?? []).find((s) => s.id === d.signalId);
      f = sig ? focusFromSignal(sig) : null;
      if (!sig) setNote('that signal is no longer derived for this run');
    } else if (d.source === 'file') {
      f = focusFromFile(graph, d.path, project);
    } else if (d.source === 'agent') {
      // Filter to known ids; if that empties the set, clear focus and say so
      // (the live-delta rule, reused).
      f = pruneFocus({ nodeIds: d.nodeIds, label: d.label || 'linked nodes', reason: d.reason, source: 'agent' }, graph);
      if (!f) setNote('the linked nodes are gone from this run');
    }
    if (f) {
      setFocus({ ...f, pan: true });
      setFocusSeq((n) => n + 1);
    }
  }, [graph, linkSeq]);

  // A deep link to a run this server does not have: ask our own server, which
  // consults the port registry and probes the other live dashboards. Found →
  // the banner upgrades to a jump offer; otherwise it names the runId and
  // stops. Never a blank screen. Only a 404 means "not here" — a transient
  // load failure must not claim a run is missing, and a run this very server
  // owns (locate answers self:true) is a plain load error, not a miss.
  useEffect(() => {
    if (!graphError || !runId || !/\b404\b/.test(graphError)) return;
    let alive = true;
    fetch(`/api/locate/${encodeURIComponent(runId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.found && d.self) return; // it's here — the graph error stands on its own
        setLinkMiss(d.found ? { runId, url: d.url } : { runId });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [graphError, runId]);

  // The moment a graph loads, any miss banner is stale by definition.
  useEffect(() => {
    if (graph) setLinkMiss(null);
  }, [graph]);

  // Copy-link: the current view — run, selected node, focus — as a URL hash.
  const copyLink = () => {
    const hash = buildFocusHash({
      runId,
      sel: selection?.type === 'node' ? selection.id : undefined,
      descriptor: descriptorFromFocus(focus),
      // Only a DETACHED playhead is worth a link. An `edge` link would pin a
      // moment the user meant as "the latest", so edge mode writes nothing.
      t: replay?.mode === 'at' && Number.isFinite(replay.t) ? new Date(replay.t).toISOString() : undefined,
    });
    const link = `${location.origin}/${hash}`;
    navigator.clipboard?.writeText(link).then(
      () => setNote('link copied — it restores this exact view'),
      () => setNote(`could not copy — the link is ${link}`),
    );
  };

  // Reconcile the focus against the graph it points into, once per graph change.
  // A live delta can delete the nodes underneath a focus, and can grow the very
  // signal the user is looking at — so a producer-backed focus is re-derived,
  // not merely pruned, or the chip and the canvas drift apart.
  useEffect(() => {
    if (!graph || !focus) return;
    const next = refocus(focus, graph, project);
    if (next === focus) return;
    setFocus(next);
    if (!next) setNote('those nodes are gone from this run');
  }, [graph]);

  // A delta can also delete the node or edge the inspector is showing (a
  // resumed workflow merges into the original node; a tool group's id moves
  // when a truncated line is re-read). NodeDetail renders nothing for an id
  // that is gone, so without this the pane stays blank until the next click.
  useEffect(() => {
    if (!graph || !selection) return;
    const list = selection.type === 'edge' ? graph.edges : graph.nodes;
    if (list.some((x) => x.id === selection.id)) return;
    setSelection(null);
    setNote(`that ${selection.type} is gone from this run`);
  }, [graph]);

  // Ambient when things are fine, loud when they are not: a `high` signal that
  // appeared since the user last looked. The first signal set a run produces is
  // the baseline — whatever was already wrong when they opened it is context,
  // not news, so only a genuinely new one escalates.
  //
  // Reads `graph.signals` — the WHOLE run — on purpose, never the revealed
  // list the strip shows under replay: replay looks at the past, and the past
  // is never news. A `high` signal that arrives on a live run while the user
  // is scrubbed back must still escalate; that is the one thing the strip must
  // never go quiet about, and scrubbing forward into an old signal must never
  // ring the bell a second time. `acknowledge()` below reads the same list.
  useEffect(() => {
    if (!graph) return;
    const signals = graph.signals ?? [];
    if (!primed.current) {
      for (const s of signals) if (s.severity === 'high') seenHigh.current.add(signalKey(s));
      primed.current = true;
      return;
    }
    if (newHighSignalIds(signals, seenHigh.current).length > 0) setEscalated(true);
  }, [graph]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  // Clicking a chip or pressing Esc means the user looked: the strip drops back
  // to ambient and the current `high` set becomes the new baseline.
  const acknowledge = () => {
    for (const s of graph?.signals ?? []) {
      if (s.severity === 'high') seenHigh.current.add(signalKey(s));
    }
    setEscalated(false);
  };

  const clearFocus = () => {
    acknowledge();
    setFocus(null);
    setFindOpen(false);
    setQuery('');
  };

  const toggleSignal = (s) => {
    acknowledge();
    setFocus((cur) =>
      cur?.source === 'signal' && cur.signalId === s.id ? null : focusFromSignal(s),
    );
  };

  const runQuery = (q) => {
    setQuery(q);
    setFocus(focusFromFind(graph, q)); // local filter — no round trip per keystroke
  };

  const togglePane = (side) => setPanes((cur) => savePanes({ ...cur, [side]: !cur[side] }));

  // Narrow embed: the inspector rides the TAP, not the playhead — tap a node
  // and it slides over, deselect (Esc, close, empty canvas) and the graph is
  // back. A selection the playhead made (a play tick, a step, a seek) never
  // opens it: on a phone the pane covers 78% of the stage, and "watch it
  // happen" exists so the follow-camera can pan a graph the visitor can SEE
  // (spec §8) — the desktop embed, whose pane sits beside the canvas, keeps
  // following every tick. A playhead deselect (⏮ to the start) still closes
  // it, as every deselect does.
  //
  // The flag is consumed HERE, in the render, not in the effect: the effect
  // fires only when `selection` changed, and a playhead deselect onto an
  // already-empty selection re-renders for `replay` but not for `selection`,
  // so a flag left for the effect could outlive its move and swallow the next
  // real tap. (A tap and a tick inside one frame read as the tick's — rare,
  // and the next tap opens.) Raw setter on purpose: a phone visitor's
  // transient state must not be persisted as a preference.
  const selByPlayhead = selByPlayheadRef.current;
  selByPlayheadRef.current = false;
  useEffect(() => {
    if (!embedNarrow()) return;
    const want = Boolean(selection);
    if (want && selByPlayhead) return;
    setPanes((cur) => (cur.right === want ? cur : { ...cur, right: want }));
  }, [selection]);

  // Embed bridge (landing page guided chips). Re-registered per render on
  // purpose: the closures must see the current graph and focus, and a plain
  // object assignment costs nothing. Signal focus reuses the deep-link
  // restore behavior (focusFromSignal + pan), find reuses the canvas's own
  // opener — one producer per behavior, here as everywhere.
  useEffect(() => {
    if (!EMBED) return;
    EMBED.app = {
      focusSignalKind(kind) {
        const signals = graph?.signals ?? [];
        const s = signals.find((x) => x.kind === kind) ?? signals[0];
        if (!s) return false;
        acknowledge();
        setSelection(null);
        setFocus({ ...focusFromSignal(s), pan: true });
        setFocusSeq((n) => n + 1);
        return true;
      },
      openFind() {
        acknowledge();
        setFindOpen(true);
        setFindSeq((n) => n + 1);
      },
      // The captured MCP answer, replayed onto the live embed — the same
      // agent-sourced focus shape POST /api/focus would deliver.
      focusNodes(nodeIds, label, reason) {
        const f = pruneFocus(
          { nodeIds: [...(nodeIds ?? [])], label: label || 'from your agent', reason: reason ?? '', source: 'agent' },
          graph,
        );
        if (!f) return false;
        acknowledge();
        setSelection(null);
        setFocus(f);
        setFocusSeq((n) => n + 1);
        return true;
      },
      // "watch it happen": open the bar and play the baked run from the start,
      // through the same producers a header click and the space key use —
      // never a synthetic DOM event.
      replay: {
        play() {
          if (!graph || !timeline || timeline.error) return false;
          acknowledge();
          setSelection(null);
          setFocus(null);
          if (live) setFollow(true);
          moveReplay(seekTo(events, 0));
          setRate(1);
          setPlayingNow(true);
          return true;
        },
      },
      clearFocus,
    };
  });

  // Any run the user chooses themselves ends the "your agent moved you" offer —
  // there is nothing to undo once they have navigated on their own.
  const selectRun = (id) => {
    setSwitchedFrom(null);
    setRunId(id);
  };

  // Resume popover, anchored to whichever affordance opened it (the header
  // button or a picker-row hover action). One popover, entry snapshot in hand.
  const openResume = (entry, rect) =>
    setResumePop({ entry, anchor: { left: rect.left, bottom: rect.bottom } });

  const undoSwitch = () => {
    const back = switchedFrom;
    setSwitchedFrom(null);
    if (back?.runId) setRunId(back.runId);
  };

  // "[" and "]" collapse the panes either side of the graph. Registered here
  // rather than in the canvas because they must work with no run loaded, and
  // must not fire while the find box has the caret.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // No pane toggles in the embed: the header buttons that would undo a
      // collapse are hidden there, so a stray "]" would trap the visitor
      // with no sidebar and no way back.
      if (EMBED) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === '[') togglePane('left');
      else if (e.key === ']') togglePane('right');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Coverage: how much of this run rungraph could read at all, classified
  // SERVER-SIDE-DERIVED-STYLE by the one shared implementation — the same
  // `classifyCoverage` the MCP note comes from, so the badge on screen and the
  // caveat in the terminal can never disagree about the same run.
  //
  // STICKY ONCE SHOWN, per runId. During live tail a signal can appear on a
  // later tick, flipping `signalCount === 0` false and retracting the caveat at
  // the exact moment the run gets interesting. Coverage did not improve — a
  // different condition changed, and `unrecognized` only ever grows — so a
  // retraction would be misinformation. It escalates (quiet → loud) but never
  // steps back down within a run; navigating away and back recomputes and
  // lands on the same verdict a cold open would give.
  const coverage = (() => {
    const meta = graph?.meta;
    const id = meta?.runId ?? null;
    const fresh = classifyCoverage(meta, graph?.signals?.length ?? 0);
    const prev = coverageSticky.current.runId === id ? coverageSticky.current.verdict : 'none';
    const verdict = strongerCoverage(prev, fresh);
    if (coverageSticky.current.runId !== id || coverageSticky.current.verdict !== verdict) {
      coverageSticky.current = { runId: id, verdict };
    }
    if (verdict === 'none') return null;
    const types = unknownTypeSummary(meta);
    return {
      verdict,
      label: coverageLabel(meta),
      title: `${meta.coverage.unrecognized} of ${meta.coverage.records} records could not be parsed${
        types ? ` (${types})` : ''
      }${meta.coverage.sourcesUnread > 0 ? `; ${meta.coverage.sourcesUnread} referenced transcript(s) could not be opened` : ''}`,
    };
  })();

  return (
    <div class="app">
      <header class="header">
        <button
          class="ghost pane-toggle"
          data-on={String(panes.left)}
          onClick={() => togglePane('left')}
          title="runs list  ( [ )"
          aria-label="toggle the runs list"
          aria-pressed={String(panes.left)}
        >
          ▤
        </button>
        <span class="brand"><b>run</b>graph</span>
        <span class="run-title">
          {graph ? (
            <>
              <strong>{graph.meta.title || '(untitled)'}</strong>
              {'  ·  '}
              {graph.meta.kind}
            </>
          ) : (
            'pick a run'
          )}
        </span>
        {graph && (
          <span class="adapter-tag" data-adapter={graph.meta.adapter} title={`reconstructed by the ${graph.meta.adapter} adapter`}>
            {adapterName(graph.meta.adapter)}
          </span>
        )}
        {currentRun?.provenance && (
          <span
            class="badge-shared"
            title={`from ${currentRun.provenance.bundle}${currentRun.provenance.snapshot ? ' — exported while the run was live' : ''}`}
          >
            shared by {currentRun.provenance.sharedBy}
          </span>
        )}
        {live && connected && <span class="badge-live">live</span>}
        {runId && !connected && <span class="microlabel">reconnecting…</span>}
        {currentRun?.resume && (
          <button
            class="ghost"
            data-on={String(resumePop?.entry.runId === currentRun.runId)}
            onClick={(e) => openResume(currentRun, e.currentTarget.getBoundingClientRect())}
            title="continue this conversation in your terminal"
          >
            resume
          </button>
        )}
        {graph && (
          <button class="ghost" onClick={copyLink} title="copy a link that restores this exact view">
            copy link
          </button>
        )}
        {graph && (
          <button
            class="ghost"
            data-on={String(replay !== null)}
            onClick={toggleReplay}
            disabled={Boolean(timeline?.error)}
            title={timeline?.error ? `replay unavailable for this run: ${timeline.error}` : 'replay this run  ( r )'}
            aria-pressed={String(replay !== null)}
          >
            replay
          </button>
        )}
        {live && (
          <button
            class="ghost"
            data-on={String(follow)}
            onClick={() => setFollow(!follow)}
            title="Auto-follow new nodes as they appear"
          >
            {follow ? 'following' : 'follow'}
          </button>
        )}
        {graph && (
          <button
            class="ghost pane-toggle"
            data-on={String(panes.right)}
            onClick={() => togglePane('right')}
            title="run details  ( ] )"
            aria-label="toggle the run details pane"
            aria-pressed={String(panes.right)}
          >
            ▥
          </button>
        )}
      </header>
      <div class="main" data-left={String(panes.left)} data-right={String(panes.right)}>
        <Picker index={index} runId={runId} onSelect={selectRun} onResume={openResume} />
        <div class="center">
          {linkMiss && (
            <div class="link-banner">
              {linkMiss.url ? (
                <>
                  this run isn't on this dashboard — it's open on {linkMiss.url}
                  <a
                    class="jump"
                    href={`${linkMiss.url}/${location.hash || `#run=${encodeURIComponent(linkMiss.runId)}`}`}
                  >
                    jump to it →
                  </a>
                </>
              ) : (
                <>no dashboard here serves run {linkMiss.runId} — was its bundle closed?</>
              )}
            </div>
          )}
          <Strip
            signals={visibleSignals}
            focus={focus}
            escalated={escalated}
            coverage={coverage}
            note={note}
            switchedFrom={switchedFrom}
            onUndoSwitch={undoSwitch}
            findOpen={findOpen}
            findSeq={findSeq}
            query={query}
            // Under replay the find count reads over PRESENT matches — a match
            // that has not happened yet is a ghost, and "12 matches" over a
            // canvas showing three of them would be a count the user cannot
            // find. The FocusSet itself is untouched: refocus() and the
            // deep-link descriptors know nothing about the playhead.
            matchCount={
              focus?.source === 'find'
                ? state
                  ? focus.nodeIds.filter((id) => state.present.has(id)).length
                  : focus.nodeIds.length
                : null
            }
            onToggleSignal={toggleSignal}
            onShowAll={() => {
              acknowledge();
              setSelection(null); // the run overview is where the full list lives
            }}
            onQuery={runQuery}
            onCloseFind={clearFocus}
            onJumpToMatch={() => {
              // Enter in the find box: reveal the first match. Typing never
              // pans (it would thrash the view on every keystroke); Enter is
              // the user saying "take me there".
              const first = focus?.source === 'find' ? focus.nodeIds[0] : undefined;
              if (first) revealNode(first);
            }}
          />
          <Canvas
            graph={graph}
            error={graphError}
            selection={selection}
            onSelect={setSelection}
            // Live follow is the EDGE: in `at` mode the graph freezes at that
            // moment while new events keep appending at the bar's right end,
            // so the camera must not chase nodes the playhead has not reached.
            // With replay closed this is `follow && live`, exactly as before.
            follow={follow && live && (replay === null || replay.mode === 'edge')}
            live={live}
            onUserPan={() => setFollow(false)}
            focus={focus}
            focusSeq={focusSeq}
            revealSeq={revealSeq}
            onClearFocus={clearFocus}
            onOpenFind={() => {
              acknowledge();
              setFindOpen(true);
              // A counter, not the boolean: pressing "/" with find already open
              // must still put the caret back in the box, or the next keystroke
              // walks the graph instead of typing.
              setFindSeq((n) => n + 1);
            }}
            inspectorOpen={Boolean(graph) && panes.right}
            // The banner stands down under a loud badge — one statement of one
            // fact. Passed rather than recomputed: a second classify call here
            // could disagree with the strip's, which is the whole failure the
            // shared classifier exists to prevent.
            coverage={coverage}
            // The moment. `replayState` null == closed, and the canvas renders
            // as it always has; `signals` is the revealed list, so a badge
            // appears at its reveal index and not before.
            replayState={state}
            replayOpen={replay !== null}
            replayAvailable={replayAvailable}
            playing={playing}
            replayCursorNodeId={curNodeId}
            replayCursorSeq={replayCursorSeq}
            signals={visibleSignals}
            onToggleReplay={toggleReplay}
            onStep={stepReplay}
            onTogglePlay={togglePlay}
            onPause={pauseReplay}
            onLayoutReady={setLayoutReady}
          />
          {/* Closed costs zero height, exactly like the strip: the bar exists
              only while the playhead does. Disabled until elk lands — the
              layout is what a scrub is drawn over. */}
          {replay !== null && graph && (
            <ReplayBar
              timeline={timeline}
              cursor={cursor}
              replay={replay}
              playing={playing}
              rate={rate}
              tick={playing ? tickInfo : null}
              live={live}
              disabled={layoutStale}
              markers={markers}
              onSeek={seekReplay}
              onStep={stepReplay}
              onToStart={() => seekReplay(0)}
              onTogglePlay={togglePlay}
              onSetRate={setReplayRate}
              onLive={goLive}
              onScrubState={setScrubbing}
            />
          )}
        </div>
        <Inspector
          graph={graph}
          open={panes.right}
          runId={runId}
          project={project}
          selection={selection}
          focus={focus}
          replay={inspectorReplay}
          settled={settled}
          signals={visibleSignals}
          onClose={() => setSelection(null)}
          onOpenRun={selectRun}
          onSelectNode={revealNode}
          onFocusSignal={toggleSignal}
          onFocusFile={(path) => {
            acknowledge();
            setFocus(focusFromFile(graph, path, project));
          }}
        />
      </div>
      {resumePop && (
        <ResumePopover
          // Keyed by run: the fork pre-check (and busy/copied state) is derived
          // at mount, so swapping entries without a remount would carry one
          // run's state onto another — losing the live-run fork default.
          key={resumePop.entry.runId}
          entry={resumePop.entry}
          anchor={resumePop.anchor}
          onClose={() => setResumePop(null)}
          onNote={setNote}
        />
      )}
    </div>
  );
}

const PANES_KEY = 'rungraph.panes';

/**
 * Both side panes collapse. The right one especially: it is open for the whole
 * life of a loaded run now, so on a laptop it is a permanent tax on the graph
 * rather than an occasional one — and the graph is the thing people came for.
 */
function loadPanes() {
  // The embed never reads (or trusts) persisted pane preferences: they are
  // dashboard chrome, and with the header hidden there is no affordance to
  // undo a stored "collapsed" state. Desktop embed: inspector always open;
  // narrow embed: it rides the selection instead.
  if (EMBED) return { left: true, right: !embedNarrow() };
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) ?? 'null');
    return { left: raw?.left !== false, right: raw?.right !== false };
  } catch {
    return { left: true, right: true };
  }
}

function savePanes(panes) {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(panes));
  } catch {
    /* storage unavailable — collapsing still works for this session */
  }
  return panes;
}

const GROUPS_KEY = 'rungraph.projectGroups';

// Only groups the user has explicitly toggled are stored, as project -> 'open' | 'closed'.
// Untouched groups follow the default rule, so projects that appear later — or drift in
// recency — still land somewhere sensible instead of inheriting a stale choice.
function loadGroupPrefs() {
  try {
    localStorage.removeItem('rungraph.collapsedProjects'); // superseded
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveGroupPrefs(prefs) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — collapsing still works for this session */
  }
  return prefs;
}

function Picker({ index, runId, onSelect, onResume }) {
  const [prefs, setPrefs] = useState(loadGroupPrefs);
  // The agent rail's single-select filter. Component state only — a sticky
  // filter is a "where did my runs go" footgun days later, so a reload
  // starts unfiltered. Group open/closed prefs stay persisted as before.
  const [filter, setFilter] = useState(null);
  // Title search — the other way to narrow the list. Same lifetime and same
  // narrowing rules as the chip filter (picker-groups.js); with 79 runs in one
  // project, scrolling for "the run from Tuesday" by memory of its title was
  // the one thing the picker could not do.
  const [query, setQuery] = useState('');
  // Share mode: check off runs, hit export. Backed by GET /api/export — the
  // same export module the CLI uses, so the consent surface cannot fork.
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState(() => new Set());
  const [exporting, setExporting] = useState(null); // the checked entries, frozen

  const selectedEntry = index?.runs?.find((r) => r.runId === runId);
  // The group key doubles as the pref key, so it must come from the one
  // implementation (bundle > loose bucket > case-merged path).
  const selectedGroupKey = selectedEntry ? groupKeyFor(selectedEntry) : null;
  // A bundle viewer serves someone else's runs: re-export is refused there
  // ("send the original file instead"), so the affordance does not appear.
  const bundleMode = Boolean(index?.runs?.length) && index.runs.every((r) => r.provenance);
  // Adapter tags appear exactly when there is a distinction to draw: a list
  // that is all one vendor stays untagged (the strip's own rule — say
  // nothing when there is nothing to say), a mixed list tags every run.
  // The agent rail rides the same gate: single-adapter machines (and the
  // landing-page embed, whose baked index is single-adapter) see no rail.
  const multiAdapter = new Set((index?.runs ?? []).map((r) => r.adapter)).size > 1;

  const toggleChecked = (id) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Reaching a run in a group you had closed (deep link, inspector jump) reveals it again.
  useEffect(() => {
    if (!selectedGroupKey) return;
    setPrefs((cur) => {
      if (cur[selectedGroupKey] !== 'closed') return cur;
      const next = { ...cur };
      delete next[selectedGroupKey];
      return saveGroupPrefs(next);
    });
  }, [selectedGroupKey]);

  // The rail-side twin of the reveal effect: when the selection stops
  // matching the filter — deep link, inspector jump, a focus_nodes arrival
  // switching the tab to another run — the filter clears. The answer the
  // agent just pointed at must never land on a hidden row. Deliberately NOT
  // keyed on `filter`: clicking a chip while an off-adapter run is selected
  // is the user's own act, and must not be instantly undone.
  //
  // Keyed on the selected run's ADAPTER, never on `index` itself: the index
  // refreshes every few seconds while any run is live, and an effect keyed
  // on it re-ran the clear on every refresh — so a chip clicked while an
  // off-adapter run was selected was undone within a second, which is
  // exactly the case the sentence above promises to leave alone. (Found by
  // dogfooding with a live session open.)
  const selectedAdapter = index?.runs?.find((r) => r.runId === runId)?.adapter;
  const selectedTitle = index?.runs?.find((r) => r.runId === runId)?.title;
  useEffect(() => {
    if (!runId || !selectedAdapter) return;
    setFilter((cur) => (cur && selectedAdapter !== cur ? null : cur));
    // The search narrows the same list, so it clears on the same rule.
    setQuery((cur) => {
      const needle = cur.trim().toLowerCase();
      return needle && !String(selectedTitle ?? '').toLowerCase().includes(needle) ? '' : cur;
    });
  }, [runId, selectedAdapter, selectedTitle]);

  // The selected row is brought into view when the selection arrives from
  // OUTSIDE the list — a deep link, an inspector jump, a focus_nodes arrival
  // — where the row may sit thousands of pixels down a list the user never
  // scrolled. Own clicks are already in view; `nearest` makes those a no-op.
  // After the group-reveal effect above, so a row in a closed group exists
  // by the time this runs.
  useEffect(() => {
    if (!runId || typeof document === 'undefined') return;
    const row = document.querySelector('.run-item[data-selected="true"]');
    const list = row?.closest('.picker');
    if (!row || !list) return;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    // Only when it is actually out of view — an own click on a visible row
    // must not shuffle the list — and then to the middle, not the edge.
    if (r.top < l.top || r.bottom > l.bottom) row.scrollIntoView?.({ block: 'center' });
  }, [runId, selectedGroupKey]);

  const setGroup = (key, open) =>
    setPrefs((cur) => saveGroupPrefs({ ...cur, [key]: open ? 'open' : 'closed' }));

  if (!index) return <aside class="picker" />;
  if (!index.runs?.length) {
    return (
      <aside class="picker">
        {index.errors?.map((e) => (
          <div class="bundle-error" key={e.file} title={e.error}>
            <b>{e.file}</b> — {e.error}
          </div>
        ))}
        <div class="empty">
          <p>No runs found.</p>
          <p>
            rungraph reads the transcripts your agent already writes to disk.
            Run an agent session, then refresh — no setup needed, past sessions appear
            retroactively.
          </p>
        </div>
      </aside>
    );
  }

  // The grouping opinion lives in picker-groups.js (bundle keying, the loose
  // bucket, case merging, recency order, the filter, the counts); this
  // component only renders its output.
  const groups = groupRuns(index.runs, { filter, query });
  const chips = adapterChips(index.runs);
  const searching = query.trim().length > 0;

  // The first group is the project worked in most recently. It and the
  // selected run's group open by default; the rest start collapsed, which
  // keeps the list one screen tall on machines with many projects. An active
  // filter opens every surviving group (it typically leaves a handful);
  // explicit open/closed prefs still win either way.
  const openFor = (g) => {
    if (prefs[g.key]) return prefs[g.key] === 'open';
    if (filter || searching) return true;
    return g.key === groups[0]?.key || g.key === selectedGroupKey;
  };

  return (
    <aside class="picker">
      {/* A corrupt bundle degrades to a named banner; the others still serve. */}
      {index.errors?.map((e) => (
        <div class="bundle-error" key={e.file} title={e.error}>
          <b>{e.file}</b> — {e.error}
        </div>
      ))}
      {multiAdapter && (
        <div class="agent-rail" role="group" aria-label="filter runs by agent">
          <button
            class="chip"
            data-on={String(filter === null)}
            onClick={() => setFilter(null)}
            title="show every agent's runs"
          >
            all <span class="n">{index.runs.length}</span>
          </button>
          {chips.map((c) => (
            <button
              class="chip"
              key={c.adapter}
              data-adapter={c.adapter}
              data-on={String(filter === c.adapter)}
              onClick={() => setFilter((cur) => (cur === c.adapter ? null : c.adapter))}
              title={`show only ${c.name} runs`}
              aria-pressed={String(filter === c.adapter)}
            >
              {c.live && <span class="live">●</span>}
              {c.name} <span class="n">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {!bundleMode && (
        <div class="picker-tools">
          {!selectMode && (
            <input
              class="run-search"
              type="search"
              value={query}
              placeholder="find a run…"
              aria-label="find runs by title"
              spellcheck="false"
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                setQuery('');
                e.currentTarget.blur();
              }}
            />
          )}
          {selectMode ? (
            <>
              <button
                class="ghost primary"
                disabled={checked.size === 0}
                onClick={() => setExporting(index.runs.filter((r) => checked.has(r.runId)))}
              >
                export {checked.size || ''} run{checked.size === 1 ? '' : 's'}…
              </button>
              <button
                class="ghost"
                onClick={() => {
                  setSelectMode(false);
                  setChecked(new Set());
                }}
              >
                cancel
              </button>
            </>
          ) : (
            <button class="ghost" onClick={() => setSelectMode(true)} title="export runs as a shareable .rungraph bundle">
              share…
            </button>
          )}
        </div>
      )}
      {searching && groups.length === 0 && (
        <div class="empty microlabel">no runs match “{query.trim()}”</div>
      )}
      {groups.map((g) => {
        const open = openFor(g);
        const groupId = `project-${encodeURIComponent(g.key)}`;
        return (
          <div
            class="project-group"
            key={g.key}
            data-kind={g.kind}
            data-open={String(open)}
            data-holds-selection={String(g.runs.some((r) => r.runId === runId))}
          >
            <button
              class="section project-toggle"
              onClick={() => setGroup(g.key, !open)}
              aria-expanded={String(open)}
              aria-controls={groupId}
              title={g.label}
            >
              <span class="chev" aria-hidden="true" />
              <ProjectLabel project={g.label} />
              <span class="count">
                {g.live > 0 && <span class="live">●</span>}
                {/* Plain n when everything matches; "k of n" when the filter
                    narrowed a mixed group. */}
                {g.runs.length === g.total ? g.total : `${g.runs.length} of ${g.total}`}
              </span>
            </button>
            {open && (
              <div class="project-runs" id={groupId}>
                {g.runs.map((r) => (
                  // A wrapper, not nesting: the hover-revealed resume action is
                  // a sibling of the row button (a button inside a button is
                  // invalid HTML and breaks activation).
                  <div class="run-row" key={r.runId}>
                    <button
                      class="run-item"
                      data-selected={String(!selectMode && r.runId === runId)}
                      data-checked={String(selectMode && checked.has(r.runId))}
                      onClick={() => (selectMode ? toggleChecked(r.runId) : onSelect(r.runId))}
                      title={r.runId}
                    >
                      <div class="title">
                        {selectMode && (
                          <span class="check" aria-hidden="true">
                            {checked.has(r.runId) ? '☑' : '☐'}
                          </span>
                        )}
                        {r.title}
                      </div>
                      <div class="sub">
                        {multiAdapter && (
                          <span class="adapter" data-adapter={r.adapter}>
                            {adapterName(r.adapter)}
                          </span>
                        )}
                        <span class={`kind-${r.kind}`}>
                          {r.kind === 'workflow' ? 'wf' : 'session'}
                        </span>
                        <span>{timeAgo(r.modifiedAt)}</span>
                        {r.active && <span class="live">● live</span>}
                        {r.provenance && (
                          <span
                            class="provenance"
                            title={`${r.provenance.bundle} · exported ${r.provenance.exportedAt ?? ''}`}
                          >
                            shared by {r.provenance.sharedBy}
                          </span>
                        )}
                        {r.provenance?.snapshot && (
                          <span class="provenance snap" title={`exported while live, at ${r.provenance.snapshot}`}>
                            snapshot
                          </span>
                        )}
                      </div>
                    </button>
                    {!selectMode && r.resume && onResume && (
                      <button
                        class="ghost resume-hint"
                        title="continue this conversation in your terminal"
                        aria-label={`resume ${r.title}`}
                        onClick={(e) => onResume(r, e.currentTarget.getBoundingClientRect())}
                      >
                        resume
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {exporting && (
        <ExportDialog
          runs={exporting}
          onClose={() => {
            setExporting(null);
            setSelectMode(false);
            setChecked(new Set());
          }}
        />
      )}
    </aside>
  );
}

function shortProject(p) {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Sibling worktrees and dated directories differ only in a trailing id, which a plain
// end-ellipsis eats — so the label is split and truncated in the middle instead: the head
// shrinks to fit, the tail is pinned and always readable.
const TAIL_CHARS = 14;

function ProjectLabel({ project }) {
  const label = shortProject(project);
  const split = label.length > TAIL_CHARS + 6;
  return (
    <span class="microlabel">
      <span class="head">{split ? label.slice(0, -TAIL_CHARS) : label}</span>
      {split && <span class="tail">{label.slice(-TAIL_CHARS)}</span>}
    </span>
  );
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
