import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
// memo() for the two per-element views — MEASURED, not assumed (spec §5 /
// open question 3): on a 560-node, 1,280-event run each replay step cost
// 25 ms median / 46 ms max of main-thread render with the views as plain
// functions, which is a dropped frame per tick at the 40 ms floor. The views'
// props are primitives plus the stable `node`/`pos`/`edge`/`pts` references,
// so a shallow compare skips every element the tick did not touch.
// preact/compat is inside the preact package already — no new dependency.
import { memo } from 'preact/compat';
import { layoutGraph, edgePath } from './layout.js';
import { badgedNodeIds, nodeMarks } from './focus.js';
import { replayLabel } from './replay.js';
import { runOrder } from '../../src/timeline.js';
import {
  zoomAtPoint,
  normalizeWheel,
  wheelZoomFactor,
  fitView,
  fitNodes,
  initialView,
  centerOn,
  minimapFrame,
  minimapToLayout,
  viewportRect,
  graphFullyVisible,
  panToReveal,
} from './viewmath.js';

const KIND_TAGS = {
  turn: 'turn',
  agent: 'agent',
  tool: 'tool',
  workflow: 'workflow',
  human: 'human',
};

const DRAG_THRESHOLD = 4; // px of total movement before a press becomes a pan
const DOUBLE_TAP_MS = 400;

export function Canvas({
  graph,
  error,
  selection,
  onSelect,
  follow,
  live,
  onUserPan,
  focus,
  focusSeq,
  revealSeq,
  onClearFocus,
  onOpenFind,
  inspectorOpen,
  coverage,
  // Replay — the canvas at a moment. `replayState` is `stateAt()` over the
  // playhead (null == the bar is closed, and everything below renders exactly
  // as it did before replay existed: that is the identity guard). The layout
  // is of the FULL graph, once; the playhead only decides what has
  // materialized. `signals` is the revealed subset, so a badge appears at its
  // signal's reveal index rather than from frame one.
  replayState,
  replayOpen,
  replayAvailable,
  playing,
  replayCursorNodeId,
  replayCursorSeq,
  signals,
  onToggleReplay,
  onStep,
  onTogglePlay,
  onPause,
  onLayoutReady,
}) {
  const [layout, setLayout] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
  // The unrecognized-records notice, dismissed per run — keyed by runId (the
  // Canvas is not remounted on a run switch), so another run's notice still
  // appears. Deliberately NOT resurrected when the count grows: on a live
  // run the count climbs constantly, and a dismiss that lasts seconds is no
  // dismiss. Session-only — the never-blank-screen rule wants degradation
  // surfaced, so a reload starts honest again.
  const [noticeDismissedFor, setNoticeDismissedFor] = useState(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const [box, setBox] = useState(null);
  const [mmDragging, setMmDragging] = useState(false);
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const lastTapRef = useRef({ t: 0, id: null });
  const layoutSeq = useRef(0);
  const prevHeight = useRef(0);
  const prevRunId = useRef(null);
  const prevInspectorOpen = useRef(false);
  const pannedSeq = useRef(0); // focusSeq the viewport has already moved for
  const revealedSeq = useRef(0); // revealSeq the viewport has already moved for
  const placedLive = useRef(false); // the `live` value the initial view used
  const placedWidth = useRef(0); // canvas width the initial view was framed for
  const userMoved = useRef(false); // any deliberate pan/zoom this run
  const cameraSeq = useRef(0); // replayCursorSeq the follow-camera has already moved for
  // Whether the replay follow-camera is still engaged for THIS play. Set when
  // play starts, cleared by any manual pan/zoom — the same rule the live
  // `follow` toggle uses: the user taking the view is the user saying "stop".
  const replayFollowing = useRef(false);
  const prevPlaying = useRef(false);

  const userTouched = () => {
    userMoved.current = true;
    replayFollowing.current = false;
  };

  // Re-layout when the graph changes (stale results discarded; a layout
  // failure keeps the previous state and surfaces a banner — never a crash).
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setLayout(null);
      setLayoutError(null);
      return;
    }
    // Honest about staleness: from here until elk lands, the layout on
    // screen belongs to the PREVIOUS graph, and the replay bar is disabled
    // for exactly that window (spec §9). The `true` is reported by the
    // effect on `layout` below, which only fires for a layout that passed
    // the seq check — so it can never say "ready" for a stale one.
    onLayoutReady?.(false);
    const seq = ++layoutSeq.current;
    layoutGraph(graph)
      .then((l) => {
        if (seq === layoutSeq.current) {
          setLayout(l);
          setLayoutError(null);
        }
      })
      .catch((err) => {
        if (seq === layoutSeq.current) setLayoutError(String(err?.message ?? err));
      });
  }, [graph]);

  useEffect(() => {
    onLayoutReady?.(Boolean(layout));
  }, [layout]);

  // Play starting (false → true) re-engages the follow-camera for the new
  // play, whatever the last one ended with. Declared BEFORE the camera effect
  // so that, should a tick land in the same render as the flip, the flag is
  // set by the time the camera reads it.
  useEffect(() => {
    if (playing && !prevPlaying.current) replayFollowing.current = true;
    prevPlaying.current = Boolean(playing);
  }, [playing]);

  // Track the canvas size (minimap viewport rect needs it reactively).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const b = el.getBoundingClientRect();
      setBox({ width: b.width, height: b.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Open each run at readable zoom — top for finished runs, latest activity
  // for live ones. Then follow the growing bottom while live.
  useEffect(() => {
    if (!layout || !wrapRef.current) return;
    const b = wrapRef.current.getBoundingClientRect();
    const runId = graph?.meta?.runId;
    const isNewRun = runId !== prevRunId.current || prevHeight.current === 0;
    prevRunId.current = runId;
    // Where a too-wide run opens: on its first node, or its latest when live.
    const anchorX = (isLive) => {
      let best = null;
      for (const pos of layout.nodes.values()) {
        if (!best) best = pos;
        else if (isLive ? pos.y + pos.h > best.y + best.h : pos.y < best.y || (pos.y === best.y && pos.x < best.x)) best = pos;
      }
      return best ? best.x + best.w / 2 : null;
    };
    if (isNewRun) {
      setView(initialView(layout, b, live, 40, anchorX(live)));
      placedLive.current = live;
      placedWidth.current = b.width;
      userMoved.current = false;
    } else if (!userMoved.current && Math.abs(b.width - placedWidth.current) > 24) {
      // elk lays out in ~20ms while the inspector slides open over 180ms, so
      // the first frame is measured against a canvas that has not finished
      // shrinking and the graph settles off-centre. Re-frame once the width
      // stops moving — but never after the user has taken the view themselves.
      setView(initialView(layout, b, placedLive.current, 40, anchorX(placedLive.current)));
      placedWidth.current = b.width;
    } else if (live && !placedLive.current && !userMoved.current) {
      // Deep-linked run: the graph can lay out before the index scan reveals
      // it is live. Re-anchor to the latest activity once we know — but only
      // if the user hasn't already moved the view.
      setView(initialView(layout, b, true, 40, anchorX(true)));
      placedLive.current = true;
    } else if (follow && layout.height > prevHeight.current) {
      setView((v) => ({
        ...v,
        ty: b.height - (layout.height + 40) * v.scale,
      }));
    }
    prevHeight.current = layout.height;
    // `box` is in the deps so the re-frame above actually sees the canvas
    // settle — the ResizeObserver is what reports the inspector finishing.
  }, [layout, follow, live, box]);

  // The inspector sliding open shrinks the canvas — shift the view by half
  // the lost width so the graph stays centered instead of hiding. Keyed on the
  // pane's own open state, not on `selection`: the inspector now stays open for
  // the run overview, so keying on the selection would nudge the view sideways
  // on every single node click.
  useEffect(() => {
    const open = Boolean(inspectorOpen);
    if (open === prevInspectorOpen.current) return;
    prevInspectorOpen.current = open;
    const w = Math.min(384, window.innerWidth * 0.3); // == --inspector-w in styles.css
    setView((v) => ({ ...v, tx: v.tx + (open ? -w / 2 : w / 2) }));
  }, [inspectorOpen]);

  // Figma-style wheel: two-finger scroll pans, pinch (ctrlKey) and
  // cmd+scroll zoom at the cursor. Plain mouse-wheel deltas are normalized.
  const onWheel = (e) => {
    // Embedded in a scrolling page, the wheel belongs to the PAGE until the
    // visitor takes the graph's controls (any click on the canvas) — the
    // embedded-map trap, solved the map way. Leaving the canvas hands the
    // wheel back. Click-drag, taps, chips and keys stay live throughout.
    const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
    if (embed && !embed.wheelCaptured) {
      embed.onWheelPassthrough?.();
      return; // no preventDefault — the page scrolls
    }
    e.preventDefault();
    userTouched();
    const rect = wrapRef.current.getBoundingClientRect();
    const { dx, dy } = normalizeWheel(e.deltaX, e.deltaY, e.deltaMode, rect.height);
    if (e.ctrlKey || e.metaKey) {
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => zoomAtPoint(v, mx, my, wheelZoomFactor(dy)));
    } else {
      setView((v) => ({ ...v, tx: v.tx - dx, ty: v.ty - dy }));
      onUserPan?.();
    }
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return; // right/middle press must never arm a drag
    // A press on the canvas is the visitor taking the embed's controls.
    const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
    if (embed && !embed.wheelCaptured) embed.setCaptured?.(true);
    // Record the element under the ORIGINAL press before capture: in
    // Chromium, pointer capture retargets the browser's own click event to
    // the capturing svg, so click handlers on nodes never fire.
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      target: e.target,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
      // pointerup was swallowed (context menu, etc.) — never pan on hover
      dragRef.current = null;
      return;
    }
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > DRAG_THRESHOLD) d.moved = true;
    if (!d.moved) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    userTouched();
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    onUserPan?.();
  };
  const onPointerCancel = () => {
    dragRef.current = null;
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    // Selection fires on pointer-up when the press never became a drag,
    // targeting what was under the press — not the capture-retargeted click.
    const hit = d.target?.closest?.('[data-node-id],[data-edge-id]');
    const nodeId = hit?.getAttribute('data-node-id');
    const edgeId = hit?.getAttribute('data-edge-id');
    if (nodeId) {
      const last = lastTapRef.current;
      lastTapRef.current = { t: e.timeStamp, id: nodeId };
      if (last.id === nodeId && e.timeStamp - last.t < DOUBLE_TAP_MS) {
        centerNode(nodeId, 1); // double-click → 100% centered on the node
        return;
      }
      onSelect({ type: 'node', id: nodeId });
    } else if (edgeId) {
      onSelect({ type: 'edge', id: edgeId });
    } else {
      onSelect(null); // true empty space still deselects
      onClearFocus?.(); // …and drops the focus, on the same gesture
    }
  };

  const fit = () => {
    if (!layout || !wrapRef.current) return;
    userTouched();
    setView(fitView(layout, wrapRef.current.getBoundingClientRect()));
  };

  // Embed bridge: the landing page's "fit the graph" chip calls the same fit
  // the dock button and the `f` key use. See RUNGRAPH_EMBED in app.jsx.
  useEffect(() => {
    const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
    if (embed) embed.canvas = { fit };
  });

  const centerNode = (id, scale) => {
    const pos = layout?.nodes.get(id);
    if (!pos || !wrapRef.current) return;
    const b = wrapRef.current.getBoundingClientRect();
    userTouched();
    setView((v) => centerOn(scale ?? v.scale, pos.x + pos.w / 2, pos.y + pos.h / 2, b));
    onUserPan?.();
  };

  // Chronological order for the keyboard walk: agents/workflows are appended
  // to the IR after the conversation walk, so sort by start time (stable on
  // ties / missing timestamps via the original index). The rule is the one
  // signals.js ranks by — the j/k walk and the ranked signal list must agree
  // on what "earlier" means or the list reads out of sequence — so it is an
  // import from timeline.js, never a copy.
  const orderedNodes = useMemo(() => (graph ? runOrder(graph.nodes) : []), [graph]);

  // Keyboard walk-through: j/k or ↓/↑ step chronologically (IR array order),
  // f fits, / opens find, Esc deselects and clears focus. No-ops without a
  // graph or with focus in an input.
  //
  // "/" lives here rather than in App so there is exactly one keyboard map and
  // one activeElement guard — the strip's find input must swallow "/" as text.
  // The replay keys (r, ←/→, space) live here for the same reason.
  useEffect(() => {
    const onKey = (e) => {
      if (!graph || !layout) return;
      // Embedded in a scrolling page, the shortcuts belong to the graph only
      // while the graph is actually on screen — "/" three sections down must
      // not yank the viewport back to the hero.
      const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
      if (embed?.keysEnabled && !embed.keysEnabled()) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        // Esc PAUSES play and never closes the bar: closing snaps the canvas
        // to the end, too large an effect for the key people press reflexively.
        if (playing) onPause?.();
        // Esc also hands the wheel back to the page in embed mode.
        const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
        if (embed?.wheelCaptured) embed.setCaptured?.(false);
        onSelect(null);
        return onClearFocus?.();
      }
      if (e.key === 'f') return fit();
      if (e.key === '/') {
        e.preventDefault(); // Firefox quick-find would eat the keystroke
        return onOpenFind?.();
      }
      if (e.key === 'r') {
        // Unavailable (buildTimeline threw for this run) → the key is inert,
        // like the disabled header button it mirrors.
        if (replayAvailable) onToggleReplay?.();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Bound only while the bar is open — unbound today, so a closed bar
        // changes nothing about the keyboard.
        if (!replayOpen) return;
        e.preventDefault();
        return onStep?.(e.key === 'ArrowLeft' ? -1 : 1);
      }
      if (e.key === ' ') {
        if (!replayOpen) return;
        // The BUTTON check is for SPACE ONLY: a focused bar button (or the
        // fit button) gets its click and nothing else. It must NOT join the
        // general guard above — in Chromium buttons take focus on click, so
        // guarding every key on BUTTON would kill j/k right after a click on
        // `fit`.
        if (el && el.tagName === 'BUTTON') return;
        e.preventDefault(); // the embed page must not scroll on space
        return onTogglePlay?.();
      }
      const dir =
        e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
      if (!dir || orderedNodes.length === 0) return;
      e.preventDefault();
      const idx =
        selection?.type === 'node' ? orderedNodes.findIndex((n) => n.id === selection.id) : -1;
      const next =
        idx === -1
          ? dir === 1
            ? orderedNodes[0]
            : orderedNodes[orderedNodes.length - 1]
          : orderedNodes[Math.min(orderedNodes.length - 1, Math.max(0, idx + dir))];
      onSelect({ type: 'node', id: next.id });
      centerNode(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [graph, layout, selection, orderedNodes, replayOpen, replayAvailable, playing]);

  // Members light up, everything else dims — the set is built once per focus
  // rather than per node. `null` (not an empty Set) means "no focus at all", so
  // an agent focus that matched nothing still dims the graph and says so, while
  // a run with no focus renders exactly as it did before this feature existed.
  const focusIds = useMemo(() => (focus ? new Set(focus.nodeIds) : null), [focus]);
  // Badges read the `signals` PROP, not `graph.signals`: while replay is open
  // App passes the revealed subset, so a storm's badge appears at the tick its
  // last member ends, not from frame one. Closed, the prop IS `graph.signals`.
  // The fallback keeps the identity path honest if the prop is ever unwired.
  const badged = useMemo(() => badgedNodeIds({ signals: signals ?? graph?.signals }), [signals, graph]);
  // A group box is present when any member is — built once per state, not
  // per group, so a run of fifty lanes does not walk the node list fifty
  // times a frame. Null means "no replay", the same reading `focusIds` uses.
  const presentGroups = useMemo(() => {
    if (!replayState || !graph) return null;
    const out = new Set();
    for (const n of graph.nodes) if (n.group && replayState.present.has(n.id)) out.add(n.group);
    return out;
  }, [graph, replayState]);

  // Replay follow-camera. Every discrete replay move (step, seek, marker, ⏮,
  // the agent hook) and every play tick bumps `replayCursorSeq`; this pans the
  // MINIMUM distance that brings the current node inside the viewport's inner
  // 70%, and never moves for a node already there — recentring on every tick
  // is the nauseating version. During play the move is gated on
  // `replayFollowing`, which any manual pan/zoom clears for the rest of that
  // play; discrete steps and seeks always reveal. Keyed on the ref, like
  // pannedSeq/revealedSeq, so a move that beat the layout lands when the
  // layout does. The camera's own move is not a user touch: it calls neither
  // userTouched() nor onUserPan().
  useEffect(() => {
    if (replayCursorSeq === undefined || replayCursorSeq === cameraSeq.current) return;
    if (!layout || !wrapRef.current) return;
    cameraSeq.current = replayCursorSeq;
    if (playing && !replayFollowing.current) return;
    const rect = replayCursorNodeId ? layout.nodes.get(replayCursorNodeId) : null;
    if (!rect) return;
    const b = wrapRef.current.getBoundingClientRect();
    // Functional update: the tick loop can outrun a render, and the pan must
    // start from wherever the view actually is, not the closure's copy.
    setView((v) => panToReveal(v, rect, { width: b.width, height: b.height }) ?? v);
  }, [replayCursorSeq, layout]);

  // Agent-sourced focus moves the viewport: the user asked the question in
  // their terminal and is looking at it, so the graph should already have moved
  // by the time they glance over. A deep-link restore pans for the same reason
  // (the user clicked a link; the view should have moved) via the `pan` flag.
  // Signal/find/file focus from in-app clicks never moves it — find would
  // thrash the view on every keystroke.
  //
  // focusSeq only advances on a fresh frame off the SSE channel or a link
  // restore, so this fires once per answer, not on every re-render; keying the
  // ref (rather than the deps) also lets a focus that beat the layout pan as
  // soon as the layout lands.
  useEffect(() => {
    if (focusSeq === pannedSeq.current) return;
    if (focus?.source !== 'agent' && !focus?.pan) {
      pannedSeq.current = focusSeq;
      return;
    }
    if (!layout || !wrapRef.current) return;
    const rects = focus.nodeIds.map((id) => layout.nodes.get(id)).filter(Boolean);
    const b = wrapRef.current.getBoundingClientRect();
    const next = fitNodes(rects, { width: b.width, height: b.height });
    pannedSeq.current = focusSeq;
    if (!next) return;
    userTouched();
    setView(next);
    onUserPan?.(); // an answer the user asked for outranks auto-follow
  }, [focusSeq, focus, layout]);

  // A node chosen from outside the canvas (the inspector's match list, Enter
  // in find) pans to it — the same move the minimap and the keyboard walk
  // already make. Keyed on the ref so a reveal that beat the layout still
  // pans as soon as the layout lands.
  useEffect(() => {
    if (revealSeq === undefined || revealSeq === revealedSeq.current) return;
    if (!layout || selection?.type !== 'node') return;
    revealedSeq.current = revealSeq;
    centerNode(selection.id);
  }, [revealSeq, selection, layout]);

  if (!graph) {
    return (
      <div class="canvas-wrap" ref={wrapRef}>
        <div class="canvas-empty">
          <div class="glyph">◍ → ◍ → ◍</div>
          <div>{error ? `could not load run: ${error}` : 'select a run on the left'}</div>
          {!error && (
            <div class="microlabel">every session still on disk is already here — no setup</div>
          )}
        </div>
      </div>
    );
  }

  // A run that parsed to NOTHING must still say something — never-blank-
  // screen reaches the canvas too. The strip's coverage badge carries the
  // verdict; this is the same fact, in words, where the user is looking.
  if (graph.nodes.length === 0) {
    const c = graph.meta?.coverage;
    const unread = c && c.records > 0 && c.unrecognized >= c.records;
    return (
      <div class="canvas-wrap" ref={wrapRef}>
        <div class="canvas-empty">
          <div class="glyph">◍</div>
          <div>
            {unread
              ? `nothing in this run could be parsed — ${c.records} record${c.records === 1 ? '' : 's'}, none recognized`
              : 'this run has no turns or tool calls to draw'}
          </div>
          <div class="microlabel">
            {unread
              ? 'the transcript format may be older or newer than this rungraph version'
              : 'an empty session, or one that ended before its first turn'}
          </div>
        </div>
      </div>
    );
  }

  // Keep the minimap mounted while its own drag is in flight — a drag that
  // brings the whole graph into view must not kill the gesture mid-pointer.
  const showMinimap = layout && box && (mmDragging || !graphFullyVisible(view, box, layout));

  return (
    <div
      class="canvas-wrap"
      ref={wrapRef}
      onPointerLeave={() => {
        // Cursor left the canvas: the page owns the wheel again (embed only).
        const embed = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;
        if (embed?.wheelCaptured) embed.setCaptured?.(false);
      }}
    >
      <svg
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="oklch(0.45 0.05 148)" />
          </marker>
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {layout &&
            graph.groups.map((g) => {
              const pos = layout.groups.get(g.id);
              if (!pos) return null;
              const present = !presentGroups || presentGroups.has(g.id);
              return (
                <g class="group-box" key={g.id} data-future={String(!present)}>
                  <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx="10" />
                  {/* A ghost is the shape of what is coming, never its content —
                      the lane's name arrives with its first member. */}
                  {present && <text x={pos.x + 12} y={pos.y + 20}>{g.label}</text>}
                </g>
              );
            })}
          {layout &&
            graph.edges.map((e) => {
              const pts = layout.edges.get(e.id);
              if (!pts) return null;
              // An id-less edge is never in `edgePresent`, so it reads as present.
              const present = !replayState || !e.id || replayState.edgePresent.has(e.id);
              return (
                <EdgeView
                  key={e.id}
                  edge={e}
                  pts={pts}
                  present={present}
                  selected={selection?.type === 'edge' && selection.id === e.id}
                  // an edge stays bright only if it connects two focused nodes —
                  // and a future edge is a ghost, not a dimmed edge: one opacity
                  // channel at a time (the same rule nodeMarks applies).
                  dim={present && Boolean(focusIds) && !(focusIds.has(e.from) && focusIds.has(e.to))}
                />
              );
            })}
          {layout &&
            graph.nodes.map((n) => {
              const pos = layout.nodes.get(n.id);
              if (!pos) return null;
              const present = !replayState || replayState.present.has(n.id);
              const marks = nodeMarks(n, focusIds, present);
              return (
                <NodeView
                  key={n.id}
                  node={n}
                  pos={pos}
                  selected={selection?.type === 'node' && selection.id === n.id}
                  focused={marks.focused}
                  dim={marks.dim}
                  reverted={marks.reverted}
                  future={marks.future}
                  // status AT THE CURSOR: running while its end is still ahead
                  status={replayState?.status.get(n.id) ?? n.status}
                  callsShown={replayState?.callsShown.get(n.id)}
                  // never on a ghost — a badge is a statement about content
                  badge={present && badged.has(n.id)}
                />
              );
            })}
        </g>
      </svg>
      <div class="banners">
        {layoutError != null && (
          <div class="banner">could not lay out this graph ({layoutError}) — try re-opening the run.</div>
        )}
        {/* Suppressed under a LOUD coverage badge, and only there: at that point
            the badge is already saying this, in one line, undismissably, with a
            percentage the raw count cannot give. Two statements of one fact —
            the louder of them overlapping the graph — is worse than either. The
            banner still carries the "your rungraph may be older" hint on a quiet
            run, where the badge alone does not explain itself. "Records", not
            "lines": a Hermes row is not a line, and the inspector and the badge
            already speak the adapter-neutral unit. */}
        {graph.meta.unrecognizedLineCount > 0 &&
          coverage?.verdict !== 'loud' &&
          noticeDismissedFor !== graph.meta.runId && (
          <div class="banner">
            <span>
              {graph.meta.unrecognizedLineCount} record
              {graph.meta.unrecognizedLineCount === 1 ? '' : 's'} unrecognized — transcript
              format may be newer than this rungraph version. Graph may be incomplete.
            </span>
            <button
              class="banner-dismiss"
              onClick={() => setNoticeDismissedFor(graph.meta.runId)}
              title="dismiss this notice for this run"
              aria-label="dismiss the unrecognized-records notice"
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div class="canvas-dock">
        <div class="dock-row">
          {/* find has no permanent home in the strip (a clean run must cost zero
              height), so this button and "/" are how it is reached. */}
          <button class="ghost" onClick={() => onOpenFind?.()} title="find in this run  ( / )">
            find
          </button>
          <button class="ghost" onClick={fit}>fit</button>
        </div>
        {showMinimap && (
          <Minimap
            graph={graph}
            layout={layout}
            view={view}
            box={box}
            focusIds={focusIds}
            replayState={replayState}
            onDragState={setMmDragging}
            onJump={(cx, cy) => {
              userTouched();
              setView((v) => centerOn(v.scale, cx, cy, box));
              onUserPan?.();
            }}
            onSelectNode={(id) => {
              onSelect({ type: 'node', id });
              centerNode(id);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Whole-graph overview strip: kind-colored node rects (no edges — noise at
 * this scale), error beacons, and a draggable bright viewport rect.
 *
 * Mirrors the canvas at a moment: future nodes are ghosts (same
 * `data-future`), beacons only on present nodes. The shape of the run stays
 * legible for jumping around — that is what ghosts are for — and a click on a
 * ghosted region still pans the VIEW there; the playhead is what a minimap
 * click never moves.
 */
function Minimap({ graph, layout, view, box, focusIds, replayState, onJump, onSelectNode, onDragState }) {
  const frame = minimapFrame(layout.width, layout.height);
  const vr = viewportRect(view, box);
  const dragRef = useRef(null);

  const toLayoutPoint = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return minimapToLayout(frame, e.clientX - r.left, e.clientY - r.top);
  };

  const endDrag = () => {
    dragRef.current = null;
    onDragState?.(false);
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return; // right/middle press must never arm a drag
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const beacon = e.target?.closest?.('[data-beacon-id]');
    const d = { sx: e.clientX, sy: e.clientY, moved: false, beacon: beacon?.getAttribute('data-beacon-id') };
    dragRef.current = d;
    onDragState?.(true);
    const p = toLayoutPoint(e);
    const inRect = p.x >= vr.x && p.x <= vr.x + vr.w && p.y >= vr.y && p.y <= vr.y + vr.h;
    // Click outside the viewport rect jumps there immediately; pressing the
    // rect itself starts a drag from its current position (keep the grab
    // offset so the rect doesn't snap its center to the pointer).
    if (!d.beacon && !inRect) onJump(p.x, p.y);
    else if (inRect) {
      d.offX = p.x - (vr.x + vr.w / 2);
      d.offY = p.y - (vr.y + vr.h / 2);
    }
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
      endDrag(); // pointerup was swallowed — never pan on hover
      return;
    }
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > DRAG_THRESHOLD) d.moved = true;
    if (!d.moved) return;
    const p = toLayoutPoint(e);
    onJump(p.x - (d.offX ?? 0), p.y - (d.offY ?? 0)); // continuous pan while dragging
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    endDrag();
    if (d?.beacon && !d.moved) onSelectNode(d.beacon); // beacon click → jump + select
  };

  const minNode = 2 / frame.s; // nodes stay ≥2px so 500-node runs keep structure
  const isPresent = (n) => !replayState || replayState.present.has(n.id);
  // A beacon on a ghost would announce an error before it happened.
  const errored = graph.nodes.filter((n) => isPresent(n) && (n.status === 'error' || (n.errorCount ?? 0) > 0));

  return (
    <svg
      class="minimap"
      width={frame.w}
      height={frame.h}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
    >
      <g transform={`scale(${frame.s})`}>
        {graph.groups.map((g) => {
          const pos = layout.groups.get(g.id);
          if (!pos) return null;
          return (
            <rect
              class="mm-group"
              key={g.id}
              x={pos.x}
              y={pos.y}
              width={pos.w}
              height={pos.h}
              stroke-width={1 / frame.s}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const pos = layout.nodes.get(n.id);
          if (!pos) return null;
          return (
            <rect
              class="mm-node"
              key={n.id}
              data-kind={n.kind}
              // a focus off-screen must still be findable — the minimap is the
              // only place the whole run is visible at once. Through
              // nodeMarks, the one rule, so future beats focus here exactly
              // as on the canvas: a ghost in the FocusSet is a ghost, not a
              // faint amber bloom announcing a node that has not happened.
              data-focused={String(nodeMarks(n, focusIds, isPresent(n)).focused)}
              data-future={String(!isPresent(n))}
              x={pos.x}
              y={pos.y}
              width={Math.max(minNode, pos.w)}
              height={Math.max(minNode, pos.h)}
            />
          );
        })}
        {errored.map((n) => {
          const pos = layout.nodes.get(n.id);
          if (!pos) return null;
          return (
            <circle
              class="mm-beacon"
              key={n.id}
              data-beacon-id={n.id}
              cx={pos.x + pos.w / 2}
              cy={pos.y + pos.h / 2}
              r={3.5 / frame.s}
            />
          );
        })}
        <rect
          class="mm-view"
          x={vr.x}
          y={vr.y}
          width={vr.w}
          height={vr.h}
          stroke-width={1.5 / frame.s}
        />
      </g>
    </svg>
  );
}

const NodeView = memo(function NodeView({ node, pos, selected, focused, dim, reverted, future, badge, status, callsShown }) {
  // A ghost: the shape of what is coming, not its content. `rect.body` alone —
  // no text, no status bar, no badge, no ring, no revert mark, and no <title>
  // either, since a tooltip that names the node is content too. It keeps its
  // id and selection attributes so the j/k walk and the minimap can still
  // land on it, and so the layout it holds a place in never collapses.
  if (future) {
    return (
      <g
        class="node"
        data-kind={node.kind}
        data-status="future"
        data-future="true"
        data-selected={String(selected)}
        data-focused="false"
        data-dim="false"
        data-reverted="false"
        data-node-id={node.id}
        transform={`translate(${pos.x} ${pos.y})`}
      >
        <rect class="body" width={pos.w} height={pos.h} rx="8" />
      </g>
    );
  }
  const shownStatus = status ?? node.status;
  // Mid-flight AT THE CURSOR — not a genuinely live node, which keeps today's
  // rendering. The error count is a fact about how the group ENDED, so it
  // appears when the end does; the label counts up (`×k`) as its calls land.
  const midFlight = shownStatus === 'running' && node.status !== 'running';
  const meta = nodeMeta(node, midFlight);
  const clip = `clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <g
      class="node"
      data-kind={node.kind}
      data-status={shownStatus}
      data-future="false"
      data-selected={String(selected)}
      data-focused={String(Boolean(focused))}
      // dimmed, never removed: hiding collapses the layout and destroys the
      // spatial memory the graph exists to build
      data-dim={String(Boolean(dim))}
      // Rolled-back work is MARKED, never hidden and never dimmed — opacity is
      // the FocusSet's channel alone, and this node may well be a focus
      // member (interventions survive a revert). See nodeMarks().
      data-reverted={String(Boolean(reverted))}
      data-node-id={node.id}
      transform={`translate(${pos.x} ${pos.y})`}
    >
      {focused && (
        <rect class="ring" x="-3" y="-3" width={pos.w + 6} height={pos.h + 6} rx="11" />
      )}
      <rect class="body" width={pos.w} height={pos.h} rx="8" />
      <rect class="status" x="0" y="6" width="3" height={pos.h - 12} rx="1.5" />
      <clipPath id={clip}>
        <rect x="10" y="0" width={pos.w - 18} height={pos.h} />
      </clipPath>
      <g clip-path={`url(#${clip})`}>
        <text class="kindtag" x="12" y="14">
          {node.kind === 'human' ? node.interventionKind ?? 'human' : KIND_TAGS[node.kind]}
          {node.kind === 'workflow' ? '  ⌄ drill in' : ''}
        </text>
        <text class="label" x="12" y={meta ? pos.h - 22 : pos.h / 2 + 9}>{replayLabel(node, callsShown)}</text>
        {meta && (
          <text class="meta" x="12" y={pos.h - 8}>{meta}</text>
        )}
      </g>
      {/* `high` signals only. In a large session the biggest node is usually
          just the biggest node, so `info` never earns a mark on the canvas. */}
      {badge && (
        <g class="signal-badge" aria-hidden="true">
          <circle cx={pos.w - 4} cy="4" r="5" />
          <text x={pos.w - 4} y="7">!</text>
        </g>
      )}
      {/* Outside the clip group on purpose: the mark must survive a long
          label, which is exactly when a reader most needs to know the work
          was thrown away. */}
      {reverted && (
        <text class="revert-badge" x={pos.w - 5} y={pos.h - 6} aria-hidden="true">↩</text>
      )}
      <title>{reverted ? `${node.label} — reverted` : node.label}</title>
    </g>
  );
});

function nodeMeta(n, midFlight = false) {
  const parts = [];
  // Not the call count: every adapter already appends ` ×N` to a collapsed
  // group's LABEL (the convention `toolFamily()` in signals.js strips), so
  // repeating it here printed "Read · find.js ×2" over a second "×2".
  //
  // The error count waits for the group's END: at the cursor a group whose
  // end is still ahead has not failed yet (per-call error timing is spec
  // §11's `callErrors`, deferred). A genuinely live node is not mid-flight
  // and shows its count exactly as today.
  if (n.errorCount && !midFlight) parts.push(`${n.errorCount} err`);
  if (n.model) parts.push(n.model.length > 20 ? n.model.slice(0, 19) + '…' : n.model);
  if (n.tokens) parts.push(`${fmtTokens(n.tokens.input + n.tokens.output)} tok`);
  if (n.durationMs != null) parts.push(fmtDuration(n.durationMs));
  return parts.join(' · ');
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtDuration(ms) {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

const EdgeView = memo(function EdgeView({ edge, pts, selected, dim, present = true }) {
  const d = edgePath(pts);
  const mid = pts[Math.floor(pts.length / 2)];
  // A future edge is a ghost like a future node: the line (its shape) stays,
  // its reason flag, label and tooltip (its content) wait for it to happen.
  const future = present === false;
  return (
    <g
      class={`edge${edge.reason ? ' has-reason' : ''}`}
      data-kind={edge.kind}
      data-dim={String(Boolean(dim))}
      data-future={String(future)}
      data-edge-id={edge.id}
    >
      <path d={d} marker-end={edge.kind !== 'sequence' ? 'url(#arrow)' : undefined} />
      {/* invisible fat hit area */}
      <path d={d} stroke="transparent" stroke-width="12" fill="none" style="cursor:pointer" />
      {!future && edge.reason && mid && (
        <text class="reason" x={mid.x + 6} y={mid.y - 4}>⚑ {truncate(edge.reason, 34)}</text>
      )}
      {!future && selected && edge.label && mid && (
        <text x={mid.x + 6} y={mid.y + 10}>{truncate(edge.label, 40)}</text>
      )}
      {!future && <title>{[edge.kind, edge.label, edge.reason].filter(Boolean).join(' — ')}</title>}
    </g>
  );
});

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
