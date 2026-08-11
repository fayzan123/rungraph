import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { layoutGraph, edgePath } from './layout.js';
import {
  zoomAtPoint,
  normalizeWheel,
  wheelZoomFactor,
  fitView,
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

export function Canvas({ graph, error, selection, onSelect, follow, live, onUserPan }) {
  const [layout, setLayout] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
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
  const placedLive = useRef(false); // the `live` value the initial view used
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
      userMoved.current = false;
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
  }, [layout, follow, live]);

  // The inspector sliding open shrinks the canvas — shift the view by half
  // the lost width so the graph stays centered instead of hiding.
  useEffect(() => {
    const open = Boolean(selection);
    if (open === prevInspectorOpen.current) return;
    prevInspectorOpen.current = open;
    const w = Math.min(384, window.innerWidth * 0.46);
    setView((v) => ({ ...v, tx: v.tx + (open ? -w / 2 : w / 2) }));
  }, [selection]);

  // Figma-style wheel: two-finger scroll pans, pinch (ctrlKey) and
  // cmd+scroll zoom at the cursor. Plain mouse-wheel deltas are normalized.
  const onWheel = (e) => {
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
    }
  };

  const fit = () => {
    if (!layout || !wrapRef.current) return;
    userTouched();
    setView(fitView(layout, wrapRef.current.getBoundingClientRect()));
  };

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
  // f fits, Esc deselects. No-ops without a graph or with focus in an input.
  useEffect(() => {
    const onKey = (e) => {
      if (!graph || !layout) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') return onSelect(null);
      if (e.key === 'f') return fit();
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

  if (!graph) {
    return (
      <div class="canvas-wrap" ref={wrapRef}>
        <div class="canvas-empty">
          <div class="glyph">◍ → ◍ → ◍</div>
          <div>{error ? `could not load run: ${error}` : 'select a run on the left'}</div>
          {!error && (
            <div class="microlabel">every past session is already here — no setup</div>
          )}
        </div>
      </div>
    );
  }

  // Keep the minimap mounted while its own drag is in flight — a drag that
  // brings the whole graph into view must not kill the gesture mid-pointer.
  const showMinimap = layout && box && (mmDragging || !graphFullyVisible(view, box, layout));

  return (
    <div class="canvas-wrap" ref={wrapRef}>
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
                />
              );
            })}
          {layout &&
            graph.nodes.map((n) => {
              const pos = layout.nodes.get(n.id);
              if (!pos) return null;
              return (
                <NodeView
                  key={n.id}
                  node={n}
                  pos={pos}
                  selected={selection?.type === 'node' && selection.id === n.id}
                />
              );
            })}
        </g>
      </svg>
      <div class="banners">
        {layoutError != null && (
          <div class="banner">could not lay out this graph ({layoutError}) — try re-opening the run.</div>
        )}
        {graph.meta.unrecognizedLineCount > 0 && (
          <div class="banner">
            {graph.meta.unrecognizedLineCount} line
            {graph.meta.unrecognizedLineCount === 1 ? '' : 's'} unrecognized — transcript
            format may be newer than this rungraph version. Graph may be incomplete.
          </div>
        )}
      </div>
      <div class="canvas-dock">
        <button class="ghost" onClick={fit}>fit</button>
        {showMinimap && (
          <Minimap
            graph={graph}
            layout={layout}
            view={view}
            box={box}
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
function Minimap({ graph, layout, view, box, onJump, onSelectNode, onDragState }) {
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

function NodeView({ node, pos, selected }) {
  const meta = nodeMeta(node);
  const clip = `clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <g
      class="node"
      data-kind={node.kind}
      data-status={node.status}
      data-selected={String(selected)}
      data-node-id={node.id}
      transform={`translate(${pos.x} ${pos.y})`}
    >
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
        <text x="12" y={meta ? pos.h - 22 : pos.h / 2 + 9}>{node.label}</text>
        {meta && (
          <text class="meta" x="12" y={pos.h - 8}>{meta}</text>
        )}
      </g>
      <title>{node.label}</title>
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

function EdgeView({ edge, pts, selected }) {
  const d = edgePath(pts);
  const mid = pts[Math.floor(pts.length / 2)];
  return (
    <g
      class={`edge${edge.reason ? ' has-reason' : ''}`}
      data-kind={edge.kind}
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
