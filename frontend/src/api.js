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
 * Ask the server to light up a node set in every browser watching this run.
 * The dashboard has no reason to call this — the agent does, over MCP — but the
 * endpoint is part of the contract, so the client speaks it too. Resolves to
 * `{ ok, runId, clientCount, url }`; zero clients is a success, not an error.
 */
export async function postFocus(runId, nodeIds, label, reason) {
  const r = await fetch('/api/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, nodeIds, label, reason }),
  });
  if (!r.ok) throw new Error(`focus: ${r.status}`);
  return r.json();
}

/**
 * Ask the server to resume this run in a new terminal window (macOS launch
 * tier). Resolves to `{ launched: true }` or — on any launcher problem —
 * `{ launched: false, copyCommand }` so the caller can degrade to the copy
 * tier. Only a non-2xx (stale runId, bundle mode, unforkable vendor) throws.
 */
export async function postResume(runId, fork) {
  const r = await fetch('/api/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, ...(fork ? { fork: true } : {}) }),
  });
  if (!r.ok) throw new Error(`resume: ${r.status}`);
  return r.json();
}

/**
 * Subscribe to live IR deltas. onMessage receives {type:'snapshot', graph},
 * {type:'delta', …} or {type:'focus', …} (an agent's answer, broadcast by
 * POST /api/focus). onStatus(connected) fires on connection state changes
 * (EventSource auto-reconnects). Returns unsubscribe.
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
  if (msg.type !== 'delta') return graph; // focus frames ride the same channel
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
    // Signals ship whole in every delta — the array is small and diffing it is
    // not worth the complexity. Absent means "unchanged", not "none left", so a
    // delta that predates signals must not silently wipe them.
    signals: msg.signals ?? graph.signals,
  };
}
