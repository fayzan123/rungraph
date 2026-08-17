/**
 * The FocusSet spine.
 *
 * Attention markers, file clicks, text find and the agent's answer all reduce
 * to "light up this set of nodes, and say why" — so the canvas learns that
 * concept exactly once. Exactly one `FocusSet | null` lives in App state and is
 * passed to the canvas, the strip and the inspector.
 *
 *   FocusSet = { nodeIds: string[], label: string, reason: string,
 *                source: 'signal' | 'find' | 'file' | 'agent' }
 *
 * Everything here is pure (no preact, no DOM) so it unit-tests alongside
 * viewmath — this is where the "focus points at nodes that no longer exist"
 * class of bug lives.
 */

import { matchNodes } from '../../src/find.js';

/** @param {{id,kind,severity,nodeIds,label,reason}} signal */
export function focusFromSignal(signal) {
  if (!signal) return null;
  return {
    nodeIds: [...(signal.nodeIds ?? [])],
    label: signal.label ?? 'signal',
    reason: signal.reason ?? '',
    source: 'signal',
    signalId: signal.id,
  };
}

/**
 * Text find. Returns null for an empty query (clears focus) and a FocusSet
 * with zero ids for a query that matched nothing — the strip needs to say
 * "no matches" rather than silently keeping the previous focus.
 */
export function focusFromFind(ir, query) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return null;
  const nodeIds = matchNodes(ir, q);
  return {
    nodeIds,
    label: `${nodeIds.length} match${nodeIds.length === 1 ? '' : 'es'}`,
    reason: `nodes whose label or files contain “${q}”`,
    source: 'find',
    query: q,
  };
}

export function focusFromFile(ir, path, projectRoot) {
  const nodeIds = (ir?.nodes ?? []).filter((n) => (n.files ?? []).includes(path)).map((n) => n.id);
  return {
    nodeIds,
    label: relPath(path, projectRoot),
    reason: `${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'} touched ${relPath(path, projectRoot)}`,
    source: 'file',
    path,
  };
}

/** A `{type:'focus', …}` frame off the SSE channel, sent by POST /api/focus. */
export function focusFromAgent(msg) {
  if (!msg || !Array.isArray(msg.nodeIds)) return null;
  return {
    nodeIds: [...msg.nodeIds],
    label: typeof msg.label === 'string' && msg.label ? msg.label : 'from your agent',
    reason: typeof msg.reason === 'string' ? msg.reason : '',
    source: 'agent',
  };
}

/**
 * Reconcile a FocusSet against the graph it points into. A live delta can
 * remove nodes underneath a focus; pointing at ids that no longer exist would
 * silently show an empty highlight.
 *
 * Returns the same object when nothing changed (so preact skips the re-render),
 * a filtered copy when some ids survived, and null when none did — the caller
 * clears focus and tells the user the nodes are gone.
 */
export function pruneFocus(focus, ir) {
  if (!focus) return null;
  // An agent can POST an empty node set; "dim the whole canvas and light
  // nothing" is never the right rendering of that, so it clears instead.
  if (!Array.isArray(focus.nodeIds) || focus.nodeIds.length === 0) return null;
  const known = new Set((ir?.nodes ?? []).map((n) => n.id));
  const kept = focus.nodeIds.filter((id) => known.has(id));
  if (kept.length === focus.nodeIds.length) return focus;
  if (kept.length === 0) return null;
  return { ...focus, nodeIds: kept, dropped: focus.nodeIds.length - kept.length };
}

/**
 * Every file the run touched, with how many nodes touched it.
 * Ranked by touch count, then path — the file the run fought with floats up.
 */
export function filesIndex(ir) {
  const byPath = new Map();
  for (const n of ir?.nodes ?? []) {
    for (const f of n.files ?? []) {
      if (typeof f !== 'string' || !f) continue;
      if (!byPath.has(f)) byPath.set(f, { path: f, count: 0, nodeIds: [] });
      const e = byPath.get(f);
      e.count += 1;
      e.nodeIds.push(n.id);
    }
  }
  return [...byPath.values()].sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}

/**
 * Display name for an adapter id. One implementation, three consumers
 * (picker, header, inspector) — a run must be called the same thing
 * everywhere it appears. Unknown adapters pass through, so a future vendor
 * shows up named rather than blank.
 */
export function adapterName(adapter) {
  if (adapter === 'claude-code') return 'claude';
  return typeof adapter === 'string' && adapter ? adapter : '';
}

/**
 * Display form of an absolute path. Paths are stored exactly as the adapter
 * observed them (absolute, as Claude Code records them); only the display is
 * relative to the run's project root, which comes from /api/index.
 */
export function relPath(path, root) {
  if (typeof path !== 'string') return '';
  if (typeof root === 'string' && root && path.startsWith(root)) {
    const rest = path.slice(root.length).replace(/^[/\\]/, '');
    if (rest) return rest;
  }
  return path;
}

/** The focused nodes, in run order, for the inspector's ranked list. */
export function rankedFocusNodes(ir, focus) {
  if (!focus) return [];
  const want = new Set(focus.nodeIds);
  return (ir?.nodes ?? []).filter((n) => want.has(n.id));
}

/**
 * Signals a given node participates in — used to explain, in the node
 * inspector, why the canvas badged it.
 */
export function signalsForNode(ir, nodeId) {
  return (ir?.signals ?? []).filter((s) => (s.nodeIds ?? []).includes(nodeId));
}

/** Node ids that carry a canvas badge: `high` severity only, by display budget. */
export function badgedNodeIds(ir) {
  const out = new Set();
  for (const s of ir?.signals ?? []) {
    if (s.severity !== 'high') continue;
    for (const id of s.nodeIds ?? []) out.add(id);
  }
  return out;
}

/**
 * Escalation identity — deliberately NOT the signal id.
 *
 * Intervention signals are keyed by kind (`sig:intervention:denial`) because
 * denials cluster into one chip, so a second denial re-derives the very same
 * id with a longer `nodeIds`. Keyed on the id alone, the strip would go quiet
 * forever after the first one — and "the agent got denied again while you were
 * away" is exactly the moment Phase 3 exists to catch. Membership is what makes
 * a signal a different signal.
 *
 * A storm that GROWS re-escalates for the same reason: it got worse.
 */
export function signalKey(s) {
  return `${s?.id}#${(s?.nodeIds ?? []).join(',')}`;
}

/**
 * High-severity signals that are new since `seenKeys` (a set of signalKey()s).
 * Returns their ids, for display.
 */
export function newHighSignalIds(signals, seenKeys) {
  const out = [];
  for (const s of signals ?? []) {
    if (s.severity === 'high' && !seenKeys.has(signalKey(s))) out.push(s.id);
  }
  return out;
}

/**
 * Re-resolve a FocusSet against the graph it now points into.
 *
 * Producer-backed focuses (signal / find / file) are re-derived, so a storm that
 * grows keeps the canvas in step with its own chip instead of lighting up the
 * two nodes it happened to cover when it was clicked. An agent's answer is a
 * snapshot of a question already asked, so it can only ever lose ids.
 *
 * Returns the SAME object when nothing changed, so preact skips the re-render;
 * null when the focus no longer resolves to anything.
 */
export function refocus(focus, ir, projectRoot) {
  if (!focus) return null;
  let next;
  switch (focus.source) {
    case 'find':
      next = focusFromFind(ir, focus.query);
      break;
    case 'file':
      next = focusFromFile(ir, focus.path, projectRoot);
      break;
    case 'signal': {
      const sig = (ir?.signals ?? []).find((s) => s.id === focus.signalId);
      next = sig ? focusFromSignal(sig) : null;
      break;
    }
    default:
      return pruneFocus(focus, ir);
  }
  if (!next || next.nodeIds.length === 0) return next?.source === 'find' ? next : null;
  return sameFocus(focus, next) ? focus : next;
}

function sameFocus(a, b) {
  return (
    a.label === b.label &&
    a.reason === b.reason &&
    a.nodeIds.length === b.nodeIds.length &&
    a.nodeIds.every((id, i) => id === b.nodeIds[i])
  );
}
