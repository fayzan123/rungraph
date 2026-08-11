export async function fetchIndex() {
  const r = await fetch('/api/index');
  if (!r.ok) throw new Error(`index: ${r.status}`);
  return r.json();
}

export async function fetchGraph(runId) {
  const r = await fetch(`/api/graph/${encodeURIComponent(runId)}`);
  if (!r.ok) throw new Error(`graph: ${r.status}`);
  return r.json();
}

export async function fetchDetail(runId, nodeId) {
  const r = await fetch(
    `/api/detail/${encodeURIComponent(nodeId)}?run=${encodeURIComponent(runId)}`,
  );
  if (!r.ok) throw new Error(`detail: ${r.status}`);
  return r.json();
}

/**
 * Subscribe to live IR deltas. onMessage receives either
 * {type:'snapshot', graph} or {type:'delta', …}. onStatus(connected) fires on
 * connection state changes (EventSource auto-reconnects). Returns unsubscribe.
 */
export function watchGraph(runId, onMessage, onStatus) {
  const es = new EventSource(`/api/watch/${encodeURIComponent(runId)}`);
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  es.onmessage = (ev) => {
    onStatus?.(true);
    try {
      onMessage(JSON.parse(ev.data));
    } catch {
      /* partial frame; ignore */
    }
  };
  return () => es.close();
}

/** Merge a delta (or snapshot) into a graph, returning a new graph object. */
export function applyDelta(graph, msg) {
  if (msg.type === 'snapshot') return msg.graph;
  if (!graph) return graph;
  const mergeById = (arr, changes, removed = []) => {
    const gone = new Set(removed);
    const byId = new Map(arr.filter((x) => !gone.has(x.id)).map((x) => [x.id, x]));
    for (const c of changes) byId.set(c.id, c);
    return [...byId.values()];
  };
  return {
    ...graph,
    meta: msg.meta ?? graph.meta,
    nodes: mergeById(graph.nodes, msg.nodes ?? [], msg.removedNodeIds),
    edges: mergeById(graph.edges, msg.edges ?? [], msg.removedEdgeIds),
    groups: mergeById(graph.groups, msg.groups ?? []),
  };
}
