import { describe, expect, it } from 'vitest';
import {
  focusFromSignal,
  focusFromFind,
  focusFromFile,
  focusFromAgent,
  pruneFocus,
  filesIndex,
  relPath,
  rankedFocusNodes,
  signalsForNode,
  badgedNodeIds,
  newHighSignalIds,
  signalKey,
  refocus,
} from '../frontend/src/focus.js';
import { fitNodes } from '../frontend/src/viewmath.js';

const ROOT = '/home/dev/acme';
const graph = {
  nodes: [
    { id: 'n1', kind: 'tool', label: 'Edit · token.js', files: [`${ROOT}/src/auth/token.js`] },
    { id: 'n2', kind: 'tool', label: 'Read · token.js', files: [`${ROOT}/src/auth/token.js`] },
    { id: 'n3', kind: 'tool', label: 'Bash · npm test' },
    { id: 'n4', kind: 'agent', label: 'audit auth', files: [`${ROOT}/src/auth/session.ts`] },
  ],
  signals: [
    { id: 'sig:a', kind: 'retry-storm', severity: 'high', nodeIds: ['n1'], label: '3 failed Edit calls', reason: 'because' },
    { id: 'sig:b', kind: 'outlier', severity: 'info', nodeIds: ['n4'], label: '1 outsized step', reason: 'big' },
  ],
};

describe('FocusSet producers', () => {
  it('a signal becomes a focus carrying its own explanation', () => {
    const f = focusFromSignal(graph.signals[0]);
    expect(f).toMatchObject({ nodeIds: ['n1'], label: '3 failed Edit calls', source: 'signal', signalId: 'sig:a' });
  });

  it('find matches labels and files, and an empty query clears focus', () => {
    expect(focusFromFind(graph, 'token.js').nodeIds).toEqual(['n1', 'n2']);
    expect(focusFromFind(graph, '  ')).toBeNull();
  });

  it('a query that matches nothing is still a focus, so the strip can say so', () => {
    const f = focusFromFind(graph, 'zzzz');
    expect(f.nodeIds).toEqual([]);
    expect(f.label).toBe('0 matches');
  });

  it('a file click focuses every node that touched it', () => {
    const f = focusFromFile(graph, `${ROOT}/src/auth/token.js`, ROOT);
    expect(f.nodeIds).toEqual(['n1', 'n2']);
    expect(f.label).toBe('src/auth/token.js'); // displayed relative to the project
    expect(f.reason).toContain('2 nodes');
  });

  it('an SSE focus frame from the agent becomes a focus, and junk does not', () => {
    expect(focusFromAgent({ nodeIds: ['n1'], label: 'x', reason: 'y' }).source).toBe('agent');
    expect(focusFromAgent({ nodeIds: ['n1'] }).label).toBe('from your agent');
    expect(focusFromAgent({})).toBeNull();
    expect(focusFromAgent(null)).toBeNull();
  });
});

describe('pruneFocus', () => {
  // A live delta can remove nodes underneath a focus. Pointing at ids that no
  // longer exist would silently render an empty highlight.
  it('returns the same object when every node survives', () => {
    const f = focusFromSignal(graph.signals[0]);
    expect(pruneFocus(f, graph)).toBe(f);
  });

  it('filters to the ids that still exist', () => {
    const f = { nodeIds: ['n1', 'gone'], label: 'x', reason: '', source: 'agent' };
    const out = pruneFocus(f, graph);
    expect(out.nodeIds).toEqual(['n1']);
    expect(out.dropped).toBe(1);
  });

  it('clears entirely when nothing survives, so the caller can say so', () => {
    expect(pruneFocus({ nodeIds: ['gone'], label: 'x', reason: '', source: 'agent' }, graph)).toBeNull();
    expect(pruneFocus(null, graph)).toBeNull();
  });

  it('clears an agent focus with an empty node set — never dim-everything-light-nothing', () => {
    expect(pruneFocus({ nodeIds: [], label: 'x', reason: '', source: 'agent' }, graph)).toBeNull();
  });
});

describe('files lane', () => {
  it('ranks touched files by how many nodes touched them', () => {
    expect(filesIndex(graph)).toEqual([
      { path: `${ROOT}/src/auth/token.js`, count: 2, nodeIds: ['n1', 'n2'] },
      { path: `${ROOT}/src/auth/session.ts`, count: 1, nodeIds: ['n4'] },
    ]);
  });

  it('is empty, not broken, for a graph with no attribution', () => {
    expect(filesIndex({ nodes: [{ id: 'a' }] })).toEqual([]);
    expect(filesIndex(null)).toEqual([]);
  });

  it('displays paths relative to the project root, and falls back to absolute', () => {
    expect(relPath(`${ROOT}/src/a.js`, ROOT)).toBe('src/a.js');
    expect(relPath('/elsewhere/b.js', ROOT)).toBe('/elsewhere/b.js');
    expect(relPath('/elsewhere/b.js', undefined)).toBe('/elsewhere/b.js');
    expect(relPath(ROOT, ROOT)).toBe(ROOT); // the root itself keeps its name
  });
});

describe('adapterName', () => {
  it('names each adapter the same way everywhere, passing unknowns through', async () => {
    const { adapterName } = await import('../frontend/src/focus.js');
    expect(adapterName('claude-code')).toBe('claude');
    expect(adapterName('codex')).toBe('codex');
    expect(adapterName('future-vendor')).toBe('future-vendor'); // named, never blank
    expect(adapterName(undefined)).toBe('');
  });
});

describe('inspector + canvas helpers', () => {
  it('lists focused nodes in run order', () => {
    const f = { nodeIds: ['n4', 'n1'], label: '', reason: '', source: 'agent' };
    expect(rankedFocusNodes(graph, f).map((n) => n.id)).toEqual(['n1', 'n4']);
  });

  it('explains why a node is badged', () => {
    expect(signalsForNode(graph, 'n1').map((s) => s.id)).toEqual(['sig:a']);
    expect(signalsForNode(graph, 'n3')).toEqual([]);
  });

  // info signals never badge: in a large session the biggest node is usually
  // just the biggest node.
  it('badges high severity only', () => {
    expect([...badgedNodeIds(graph)]).toEqual(['n1']);
    expect([...badgedNodeIds({})]).toEqual([]);
  });

  it('spots newly-appeared high signals for live escalation', () => {
    expect(newHighSignalIds(graph.signals, new Set())).toEqual(['sig:a']);
    expect(newHighSignalIds(graph.signals, new Set([signalKey(graph.signals[0])]))).toEqual([]);
    expect(newHighSignalIds(undefined, new Set())).toEqual([]);
  });

  // The escalation identity is membership, not the id. Intervention signals are
  // keyed by KIND (`sig:intervention:denial`), so a second denial re-derives the
  // same id — keyed on the id alone the strip would go quiet forever after the
  // first one, which is exactly the moment Phase 3 exists to catch.
  it('re-escalates when a kind-keyed signal covers new nodes', () => {
    const one = { id: 'sig:intervention:denial', severity: 'high', nodeIds: ['h1'] };
    const two = { id: 'sig:intervention:denial', severity: 'high', nodeIds: ['h1', 'h2'] };
    const seen = new Set([signalKey(one)]);
    expect(newHighSignalIds([one], seen)).toEqual([]); // unchanged: still quiet
    expect(newHighSignalIds([two], seen)).toEqual(['sig:intervention:denial']); // it got worse
  });

  it('does not escalate on a bare re-derivation of the same signal', () => {
    const seen = new Set(graph.signals.map(signalKey));
    expect(newHighSignalIds(graph.signals.map((s) => ({ ...s })), seen)).toEqual([]);
  });
});

describe('refocus', () => {
  // A live delta can grow the very signal the user is looking at. Pruning alone
  // would leave the canvas lighting up the two nodes the storm had when it was
  // clicked while its own chip reads "9 failed Edit calls".
  it('re-derives a signal focus so a growing storm keeps the canvas in step', () => {
    const before = focusFromSignal(graph.signals[0]);
    const grown = {
      ...graph,
      signals: [{ ...graph.signals[0], nodeIds: ['n1', 'n2'], label: '5 failed Edit calls' }],
    };
    const after = refocus(before, grown, ROOT);
    expect(after.nodeIds).toEqual(['n1', 'n2']);
    expect(after.label).toBe('5 failed Edit calls');
  });

  it('clears a signal focus whose signal resolved itself', () => {
    expect(refocus(focusFromSignal(graph.signals[0]), { ...graph, signals: [] }, ROOT)).toBeNull();
  });

  it('re-runs find against the new graph', () => {
    const f = focusFromFind(graph, 'token.js');
    const withMore = {
      ...graph,
      nodes: [...graph.nodes, { id: 'n5', kind: 'tool', label: 'Edit · token.js' }],
    };
    expect(refocus(f, withMore, ROOT).nodeIds).toEqual(['n1', 'n2', 'n5']);
  });

  it('re-resolves a file focus', () => {
    const f = focusFromFile(graph, `${ROOT}/src/auth/token.js`, ROOT);
    expect(refocus(f, graph, ROOT)).toBe(f); // unchanged → same object, no re-render
  });

  // An agent's answer is a snapshot of a question already asked: it can lose
  // ids to a delta, but re-deriving it would be inventing a new answer.
  it('only prunes an agent focus', () => {
    const f = focusFromAgent({ nodeIds: ['n1', 'gone'], label: 'x', reason: 'y' });
    expect(refocus(f, graph, ROOT).nodeIds).toEqual(['n1']);
    expect(refocus(focusFromAgent({ nodeIds: ['gone'], label: 'x' }), graph, ROOT)).toBeNull();
  });

  it('keeps a zero-match find focus so the strip can still say "no matches"', () => {
    const f = focusFromFind(graph, 'zzzz');
    expect(refocus(f, graph, ROOT).nodeIds).toEqual([]);
  });

  it('is a no-op on null', () => {
    expect(refocus(null, graph, ROOT)).toBeNull();
  });
});

describe('fitNodes', () => {
  const box = { width: 1000, height: 800 };

  it('centres the focused set in the viewport', () => {
    const view = fitNodes([{ x: 100, y: 100, w: 200, h: 100 }], box);
    // the bbox centre (200,150) lands at the box centre
    expect(200 * view.scale + view.tx).toBeCloseTo(box.width / 2);
    expect(150 * view.scale + view.ty).toBeCloseTo(box.height / 2);
  });

  it('never zooms past maxScale on one small node', () => {
    expect(fitNodes([{ x: 0, y: 0, w: 10, h: 10 }], box).scale).toBeLessThanOrEqual(1.1);
  });

  it('zooms out far enough to hold a scattered set', () => {
    const view = fitNodes(
      [
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 3000, y: 5000, w: 100, h: 50 },
      ],
      box,
    );
    expect(view.scale).toBeLessThan(0.2);
  });

  it('leaves the view alone when there is nothing to frame', () => {
    expect(fitNodes([], box)).toBeNull();
    expect(fitNodes(null, box)).toBeNull();
    expect(fitNodes([{ x: 0, y: 0, w: 1, h: 1 }], null)).toBeNull();
  });
});
