import { describe, expect, it } from 'vitest';
import { diffGraphs } from '../src/watcher.js';

const node = (id, over = {}) => ({ id, kind: 'tool', label: id, status: 'completed', ...over });
const graph = (over = {}) => ({
  irVersion: 1,
  meta: { runId: 'r', totals: { tokens: 1, toolCalls: 1, agents: 0 } },
  nodes: [node('a'), node('b')],
  edges: [{ id: 'e1', kind: 'sequence', from: 'a', to: 'b' }],
  groups: [],
  signals: [],
  ...over,
});

const SIGNAL = {
  id: 'sig:unresolved-error:b',
  kind: 'unresolved-error',
  severity: 'high',
  nodeIds: ['b'],
  label: 'unresolved Bash error',
  reason: 'nothing came back to fix it',
};

describe('diffGraphs', () => {
  it('sends a snapshot when there is no previous graph', () => {
    const g = graph();
    expect(diffGraphs(null, g)).toEqual({ type: 'snapshot', graph: g });
  });

  it('returns null when genuinely nothing changed', () => {
    expect(diffGraphs(graph(), graph())).toBeNull();
  });

  it('carries signals in full on every delta', () => {
    const next = graph({ nodes: [node('a'), node('b'), node('c')], signals: [SIGNAL] });
    const delta = diffGraphs(graph(), next);
    expect(delta.nodes.map((n) => n.id)).toEqual(['c']); // nodes still diffed…
    expect(delta.signals).toEqual([SIGNAL]); // …signals ride along whole
  });

  // Phase 3 hinges on this: the escalation moment is often a rebuild where the
  // node set is unchanged and only the run's opinion of it moved. Suppressing
  // that as "nothing happened" means the strip never goes loud.
  it('treats a signal-only change as a delta', () => {
    const delta = diffGraphs(graph(), graph({ signals: [SIGNAL] }));
    expect(delta).not.toBeNull();
    expect(delta.type).toBe('delta');
    expect(delta.nodes).toEqual([]);
    expect(delta.signals).toEqual([SIGNAL]);
  });

  // Without this, a run that drifts mid-tail would show the coverage badge only
  // on first load: the badge reads meta, and a delta whose meta was stale would
  // freeze the percentage at whatever the first snapshot happened to see.
  it('carries meta.coverage on every delta, so a drifting live run updates', () => {
    const before = graph({ meta: { runId: 'r', coverage: { records: 10, unrecognized: 0, sourcesUnread: 0 } } });
    const after = graph({
      meta: { runId: 'r', coverage: { records: 14, unrecognized: 3, sourcesUnread: 0 } },
      nodes: [node('a'), node('b'), node('c')],
    });
    const delta = diffGraphs(before, after);
    expect(delta.meta.coverage).toEqual({ records: 14, unrecognized: 3, sourcesUnread: 0 });
  });

  it('treats a signal disappearing as a delta too', () => {
    const delta = diffGraphs(graph({ signals: [SIGNAL] }), graph({ signals: [] }));
    expect(delta).not.toBeNull();
    expect(delta.signals).toEqual([]);
  });

  it('does not fire on a re-derivation that produced the same signals', () => {
    // Signal ids are derived from stable node ids precisely so this holds — a
    // counter-based id would make every single tick look like new trouble.
    expect(diffGraphs(graph({ signals: [SIGNAL] }), graph({ signals: [{ ...SIGNAL }] }))).toBeNull();
  });

  it('tolerates graphs from before signals existed', () => {
    const before = graph();
    delete before.signals;
    const after = graph();
    delete after.signals;
    expect(diffGraphs(before, after)).toBeNull();
    expect(diffGraphs(before, graph({ signals: [SIGNAL] })).signals).toEqual([SIGNAL]);
  });

  it('reports removals so the client can drop stale nodes', () => {
    const delta = diffGraphs(graph(), graph({ nodes: [node('a')] }));
    expect(delta.removedNodeIds).toEqual(['b']);
  });
});
