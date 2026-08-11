import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

const SIZES = {
  turn: { minW: 250, maxW: 340, h: 48 },
  agent: { minW: 190, maxW: 280, h: 54 },
  tool: { minW: 120, maxW: 230, h: 36 },
  workflow: { minW: 210, maxW: 300, h: 54 },
  human: { minW: 150, maxW: 260, h: 42 },
};

export function nodeSize(node) {
  const s = SIZES[node.kind] ?? SIZES.tool;
  const w = Math.max(s.minW, Math.min(s.maxW, 34 + node.label.length * 6.6));
  return { w, h: s.h };
}

/**
 * elkjs layered layout, time flowing top-to-bottom, parallel agents fanning
 * into side-by-side lanes. Workflow phases become compound group boxes.
 * Returns absolute positions.
 */
export async function layoutGraph(graph) {
  const groupIds = new Set(graph.groups.map((g) => g.id));
  const byGroup = new Map();
  const topLevel = [];
  for (const n of graph.nodes) {
    const size = nodeSize(n);
    const child = {
      id: n.id,
      width: size.w,
      height: size.h,
      properties: { 'org.eclipse.elk.portConstraints': 'FREE' },
    };
    if (n.group && groupIds.has(n.group)) {
      if (!byGroup.has(n.group)) byGroup.set(n.group, []);
      byGroup.get(n.group).push(child);
    } else {
      topLevel.push(child);
    }
  }

  const children = [
    ...topLevel,
    ...graph.groups
      .filter((g) => byGroup.has(g.id))
      .map((g) => ({
        id: g.id,
        children: byGroup.get(g.id),
        layoutOptions: {
          'elk.padding': '[top=34,left=14,bottom=14,right=14]',
          'elk.direction': 'DOWN',
        },
      })),
  ];

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '46',
      'elk.spacing.nodeNode': '26',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.edgeRouting': 'SPLINES',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=30,left=30,bottom=60,right=30]',
    },
    children,
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const out = await elk.layout(elkGraph);

  const nodes = new Map();
  const groups = new Map();
  walk(out, 0, 0, (item, ax, ay) => {
    if (groupIds.has(item.id)) {
      groups.set(item.id, { x: ax, y: ay, w: item.width, h: item.height });
    } else if (item.id !== 'root') {
      nodes.set(item.id, { x: ax, y: ay, w: item.width, h: item.height });
    }
  });

  const edges = new Map();
  collectEdges(out, 0, 0, edges);

  return {
    nodes,
    groups,
    edges,
    width: out.width ?? 800,
    height: out.height ?? 600,
  };
}

function walk(item, ox, oy, visit) {
  const ax = ox + (item.x ?? 0);
  const ay = oy + (item.y ?? 0);
  if (item.id) visit(item, ax, ay);
  for (const c of item.children ?? []) walk(c, ax, ay, visit);
}

function collectEdges(item, ox, oy, acc) {
  const ax = ox + (item.x ?? 0);
  const ay = oy + (item.y ?? 0);
  for (const e of item.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({
      x: p.x + ax,
      y: p.y + ay,
    }));
    acc.set(e.id, pts);
  }
  for (const c of item.children ?? []) collectEdges(c, ax, ay, acc);
}

/** Smooth path through elk points. */
export function edgePath(pts) {
  if (!pts || pts.length === 0) return '';
  if (pts.length === 2) {
    const [a, b] = pts;
    const my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    d += ` Q ${p.x} ${p.y}, ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
