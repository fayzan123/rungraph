import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { layoutGraph, edgePath } from './layout.js';

const KIND_TAGS = {
  turn: 'turn',
  agent: 'agent',
  tool: 'tool',
  workflow: 'workflow',
  human: 'human',
};

export function Canvas({ graph, error, selection, onSelect, follow, onUserPan }) {
  const [layout, setLayout] = useState(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const layoutSeq = useRef(0);
  const prevHeight = useRef(0);
  const prevRunId = useRef(null);
  const prevInspectorOpen = useRef(false);

  // Re-layout when the graph changes (stale results discarded).
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setLayout(null);
      return;
    }
    const seq = ++layoutSeq.current;
    layoutGraph(graph).then((l) => {
      if (seq === layoutSeq.current) setLayout(l);
    });
  }, [graph]);

  // Fit on the first layout of each run; follow the growing bottom when live.
  useEffect(() => {
    if (!layout || !wrapRef.current) return;
    const box = wrapRef.current.getBoundingClientRect();
    const runId = graph?.meta?.runId;
    const isNewRun = runId !== prevRunId.current || prevHeight.current === 0;
    prevRunId.current = runId;
    if (isNewRun) {
      setView(fitView(layout, box));
    } else if (follow && layout.height > prevHeight.current) {
      setView((v) => ({
        ...v,
        ty: box.height - (layout.height + 40) * v.scale,
      }));
    }
    prevHeight.current = layout.height;
  }, [layout, follow]);

  // The inspector sliding open shrinks the canvas — shift the view by half
  // the lost width so the graph stays centered instead of hiding.
  useEffect(() => {
    const open = Boolean(selection);
    if (open === prevInspectorOpen.current) return;
    prevInspectorOpen.current = open;
    const w = Math.min(384, window.innerWidth * 0.46);
    setView((v) => ({ ...v, tx: v.tx + (open ? -w / 2 : w / 2) }));
  }, [selection]);

  const onWheel = (e) => {
    e.preventDefault();
    const box = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    setView((v) => {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(2.5, Math.max(0.08, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };

  const onPointerDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    onUserPan?.();
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && e.target.tagName === 'svg') onSelect(null);
  };

  const fit = () => {
    if (!layout || !wrapRef.current) return;
    setView(fitView(layout, wrapRef.current.getBoundingClientRect()));
  };

  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );

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

  return (
    <div class="canvas-wrap" ref={wrapRef}>
      <svg
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
                  onSelect={() => onSelect({ type: 'edge', id: e.id })}
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
                  onSelect={() => onSelect({ type: 'node', id: n.id })}
                />
              );
            })}
        </g>
      </svg>
      {graph.meta.unrecognizedLineCount > 0 && (
        <div class="banner">
          {graph.meta.unrecognizedLineCount} line
          {graph.meta.unrecognizedLineCount === 1 ? '' : 's'} unrecognized — transcript
          format may be newer than this rungraph version. Graph may be incomplete.
        </div>
      )}
      <div class="canvas-hud">
        <button class="ghost" onClick={fit}>fit</button>
      </div>
    </div>
  );
}

function fitView(layout, box) {
  const pad = 40;
  const scale = Math.min(
    1,
    (box.width - pad * 2) / layout.width,
    (box.height - pad * 2) / layout.height,
  );
  return {
    scale: Math.max(0.08, scale),
    tx: (box.width - layout.width * scale) / 2,
    ty: pad,
  };
}

function NodeView({ node, pos, selected, onSelect }) {
  const meta = nodeMeta(node);
  const clip = `clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <g
      class="node"
      data-kind={node.kind}
      data-status={node.status}
      data-selected={String(selected)}
      transform={`translate(${pos.x} ${pos.y})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
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

function EdgeView({ edge, pts, selected, onSelect }) {
  const d = edgePath(pts);
  const mid = pts[Math.floor(pts.length / 2)];
  return (
    <g
      class={`edge${edge.reason ? ' has-reason' : ''}`}
      data-kind={edge.kind}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
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
