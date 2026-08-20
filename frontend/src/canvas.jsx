import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { layoutGraph, edgePath } from './layout.js';
import { badgedNodeIds, nodeMarks } from './focus.js';
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
  onClearFocus,
  onOpenFind,
  inspectorOpen,
  coverage,
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
  const placedLive = useRef(false); // the `live` value the initial view used
  const placedWidth = useRef(0); // canvas width the initial view was framed for
  const userMoved = useRef(false); // any deliberate pan/zoom this run

  const userTouched = () => {
    userMoved.current = true;
  };

  // Re-layout when the graph changes (stale results discarded; a layout
  // failure keeps the previous state and surfaces a banner — never a crash).
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setLayout(null);
      setLayoutError(null);
      return;
    }
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
    if (isNewRun) {
      setView(initialView(layout, b, live));
      placedLive.current = live;
      placedWidth.current = b.width;
      userMoved.current = false;
    } else if (!userMoved.current && Math.abs(b.width - placedWidth.current) > 24) {
      // elk lays out in ~20ms while the inspector slides open over 180ms, so
      // the first frame is measured against a canvas that has not finished
      // shrinking and the graph settles off-centre. Re-frame once the width
      // stops moving — but never after the user has taken the view themselves.
      setView(initialView(layout, b, placedLive.current));
      placedWidth.current = b.width;
    } else if (live && !placedLive.current && !userMoved.current) {
      // Deep-linked run: the graph can lay out before the index scan reveals
      // it is live. Re-anchor to the latest activity once we know — but only
      // if the user hasn't already moved the view.
      setView(initialView(layout, b, true));
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
  // ties / missing timestamps via the original index).
  const orderedNodes = useMemo(() => {
    if (!graph) return [];
    let lastT = 0;
    return graph.nodes
      .map((n, i) => {
        const t = Date.parse(n.startedAt);
        if (Number.isFinite(t)) lastT = t;
        return { n, i, t: Number.isFinite(t) ? t : lastT };
      })
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map((k) => k.n);
  }, [graph]);

  // Keyboard walk-through: j/k or ↓/↑ step chronologically (IR array order),
  // f fits, / opens find, Esc deselects and clears focus. No-ops without a
  // graph or with focus in an input.
  //
  // "/" lives here rather than in App so there is exactly one keyboard map and
  // one activeElement guard — the strip's find input must swallow "/" as text.
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
  }, [graph, layout, selection, orderedNodes]);

  // Members light up, everything else dims — the set is built once per focus
  // rather than per node. `null` (not an empty Set) means "no focus at all", so
  // an agent focus that matched nothing still dims the graph and says so, while
  // a run with no focus renders exactly as it did before this feature existed.
  const focusIds = useMemo(() => (focus ? new Set(focus.nodeIds) : null), [focus]);
  const badged = useMemo(() => badgedNodeIds(graph), [graph]);

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
              return (
                <g class="group-box" key={g.id}>
                  <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx="10" />
                  <text x={pos.x + 12} y={pos.y + 20}>{g.label}</text>
                </g>
              );
            })}
          {layout &&
            graph.edges.map((e) => {
              const pts = layout.edges.get(e.id);
              if (!pts) return null;
              return (
                <EdgeView
                  key={e.id}
                  edge={e}
                  pts={pts}
                  selected={selection?.type === 'edge' && selection.id === e.id}
                  // an edge stays bright only if it connects two focused nodes
                  dim={Boolean(focusIds) && !(focusIds.has(e.from) && focusIds.has(e.to))}
                />
              );
            })}
          {layout &&
            graph.nodes.map((n) => {
              const pos = layout.nodes.get(n.id);
              if (!pos) return null;
              const marks = nodeMarks(n, focusIds);
              return (
                <NodeView
                  key={n.id}
                  node={n}
                  pos={pos}
                  selected={selection?.type === 'node' && selection.id === n.id}
                  focused={marks.focused}
                  dim={marks.dim}
                  reverted={marks.reverted}
                  badge={badged.has(n.id)}
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
 */
function Minimap({ graph, layout, view, box, focusIds, onJump, onSelectNode, onDragState }) {
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
  const errored = graph.nodes.filter((n) => n.status === 'error' || (n.errorCount ?? 0) > 0);

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
              // only place the whole run is visible at once
              data-focused={String(Boolean(focusIds?.has(n.id)))}
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

function NodeView({ node, pos, selected, focused, dim, reverted, badge }) {
  const meta = nodeMeta(node);
  const clip = `clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <g
      class="node"
      data-kind={node.kind}
      data-status={node.status}
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
        <text class="label" x="12" y={meta ? pos.h - 22 : pos.h / 2 + 9}>{node.label}</text>
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
}

function nodeMeta(n) {
  const parts = [];
  if (n.kind === 'tool' && n.callCount > 1) parts.push(`×${n.callCount}`);
  if (n.errorCount) parts.push(`${n.errorCount} err`);
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

function EdgeView({ edge, pts, selected, dim }) {
  const d = edgePath(pts);
  const mid = pts[Math.floor(pts.length / 2)];
  return (
    <g
      class={`edge${edge.reason ? ' has-reason' : ''}`}
      data-kind={edge.kind}
      data-dim={String(Boolean(dim))}
      data-edge-id={edge.id}
    >
      <path d={d} marker-end={edge.kind !== 'sequence' ? 'url(#arrow)' : undefined} />
      {/* invisible fat hit area */}
      <path d={d} stroke="transparent" stroke-width="12" fill="none" style="cursor:pointer" />
      {edge.reason && mid && (
        <text class="reason" x={mid.x + 6} y={mid.y - 4}>⚑ {truncate(edge.reason, 34)}</text>
      )}
      {selected && edge.label && mid && (
        <text x={mid.x + 6} y={mid.y + 10}>{truncate(edge.label, 40)}</text>
      )}
      <title>{[edge.kind, edge.label, edge.reason].filter(Boolean).join(' — ')}</title>
    </g>
  );
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
