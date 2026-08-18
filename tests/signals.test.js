import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { deriveSignals, attachSignals, toolFamily, THRESHOLDS } from '../src/signals.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
} from './helpers.js';

let refs;
beforeAll(async () => {
  await pinFixtureMtimes();
  refs = await detect([FIXTURE_ROOT]);
});

const signalsFor = async (runId) => {
  const { ir } = await parse(refs.find((r) => r.runId === runId));
  return { ir, signals: deriveSignals(ir) };
};

/** Minimal IR builder for the cases a transcript fixture cannot express cheaply. */
function ir(nodes, edges = []) {
  return { irVersion: 1, meta: {}, nodes, edges, groups: [] };
}
let seq = 0;
const tool = (label, over = {}) => ({
  id: `g${++seq}`,
  kind: 'tool',
  label,
  status: 'completed',
  callCount: 1,
  errorCount: 0,
  startedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
  ...over,
});
const chain = (nodes) =>
  nodes.slice(1).map((n, i) => ({
    id: `e${i}`,
    kind: 'sequence',
    from: nodes[i].id,
    to: n.id,
  }));

describe('deriveSignals over the fixture corpus', () => {
  it('matches the snapshot for every run', async () => {
    const out = {};
    for (const ref of refs) {
      const { ir: graph } = await parse(ref);
      out[ref.runId] = deriveSignals(graph);
    }
    expect(out).toMatchSnapshot();
  });

  // THE precision guard. If a run where nothing went wrong starts producing
  // markers, the markers stop meaning anything and the user is back to reading
  // the whole graph — so this test failing is a threshold regression, not a
  // snapshot to update.
  it('a clean run produces ZERO signals', async () => {
    const { ir: graph, signals } = await signalsFor(CLEAN_RUN_ID);
    expect(graph.nodes.length).toBeGreaterThan(3); // not vacuously clean
    expect(signals).toEqual([]);
  });

  it('an empty run produces no signals and does not throw', () => {
    expect(deriveSignals(ir([]))).toEqual([]);
  });
});

// The Hermes leg of the corpus-wide snapshot, behind the same node:sqlite
// gate as tests/hermes.test.js so the Node 20 CI leg stays green. Probed
// with require — vite-node mangles a literal `import('node:sqlite')`.
const hasNodeSqlite = await import('node:module').then(
  ({ createRequire }) => {
    try {
      createRequire(import.meta.url)('node:sqlite');
      return true;
    } catch {
      return false;
    }
  },
  () => false,
);

describe.skipIf(!hasNodeSqlite)('deriveSignals over the hermes fixture corpus', () => {
  it('matches the snapshot for every hermes run', async () => {
    const { detect: hermesDetect, parse: hermesParse } = await import('../src/adapters/hermes/index.js');
    const { HERMES_FIXTURE_ROOT } = await import('./helpers.js');
    const out = {};
    for (const ref of await hermesDetect([HERMES_FIXTURE_ROOT])) {
      const { ir: graph } = await hermesParse(ref);
      out[ref.runId] = deriveSignals(graph);
    }
    expect(out).toMatchSnapshot();
  });
});

describe('retry-storm', () => {
  it('fires on a single tool node that failed retryErrors times', async () => {
    const { signals } = await signalsFor(TROUBLE_RUN_ID);
    const storm = signals.find((s) => s.kind === 'retry-storm');
    expect(storm.severity).toBe('high');
    expect(storm.label).toBe('3 failed Edit calls');
    expect(storm.reason).toContain('token.js'); // files[] names the file it fought with
    expect(storm.nodeIds).toHaveLength(1);
  });

  it('spans same-tool failures with other tools interleaved', () => {
    // The real shape of a spiral: Edit fails, the agent Reads the file to see
    // why, Edit fails again. The Read must not end the storm.
    const nodes = [
      tool('Edit · a.js', { status: 'error', errorCount: 1 }),
      tool('Read · a.js'),
      tool('Edit · a.js', { status: 'error', errorCount: 1 }),
    ];
    const [storm] = deriveSignals(ir(nodes, chain(nodes))).filter((s) => s.kind === 'retry-storm');
    expect(storm.nodeIds).toEqual([nodes[0].id, nodes[2].id]);
    expect(storm.label).toBe('2 failed Edit calls');
  });

  it('a successful call of the same tool ends the storm', () => {
    const nodes = [
      tool('Edit · a.js', { status: 'error', errorCount: 1 }),
      tool('Edit · a.js'), // resolved
      tool('Edit · a.js', { status: 'error', errorCount: 1 }),
    ];
    expect(deriveSignals(ir(nodes, chain(nodes))).filter((s) => s.kind === 'retry-storm')).toEqual([]);
  });

  it('ignores a busy tool node with a few failures among many successes', () => {
    // "Bash ×24 with 2 errors" is a test loop working normally, and it is the
    // single most common error-bearing shape in real sessions.
    const nodes = [
      tool('Bash · npm test ×24', { callCount: 24, errorCount: 2 }),
      tool('Bash · npm test ×6', { callCount: 6, errorCount: 2 }),
    ];
    expect(deriveSignals(ir(nodes, chain(nodes)))).toEqual([]);
  });

  it('does not fire on calls a human refused', () => {
    const edit = tool('Edit · secrets.env', { status: 'error', errorCount: 3 });
    const human = {
      id: 'h1',
      kind: 'human',
      label: 'denied Edit',
      status: 'completed',
      interventionKind: 'denial',
    };
    const kinds = deriveSignals(ir([edit, human], chain([edit, human]))).map((s) => s.kind);
    expect(kinds).not.toContain('retry-storm');
    expect(kinds).toContain('intervention');
  });
});

describe('unresolved-error', () => {
  it('fires on the last failing call of its tool in the lane', async () => {
    const { signals } = await signalsFor(TROUBLE_RUN_ID);
    const un = signals.filter((s) => s.kind === 'unresolved-error');
    expect(un).toHaveLength(1);
    expect(un[0].label).toBe('unresolved Bash error');
    expect(un[0].severity).toBe('high');
  });

  it('does not double-report a node already inside a retry storm', async () => {
    const { signals } = await signalsFor(TROUBLE_RUN_ID);
    const stormIds = new Set(signals.filter((s) => s.kind === 'retry-storm').flatMap((s) => s.nodeIds));
    for (const s of signals.filter((x) => x.kind === 'unresolved-error')) {
      expect(stormIds.has(s.nodeIds[0])).toBe(false);
    }
  });

  it('does not fire for a call the user denied — that is an intervention, not a failure', async () => {
    const { ir: graph, signals } = await signalsFor(SESSION_RUN_ID);
    const denied = graph.nodes.find((n) => n.label.includes('session.ts'));
    expect(denied.status).toBe('error'); // the adapter did record it as failed
    const flagged = signals.filter((s) => s.nodeIds.includes(denied.id) && s.severity === 'high');
    expect(flagged).toEqual([]);
  });
});

describe('intervention', () => {
  it('groups by kind, with denials high and answers info', async () => {
    const { signals } = await signalsFor(SESSION_RUN_ID);
    const byKind = Object.fromEntries(
      signals.filter((s) => s.kind === 'intervention').map((s) => [s.label, s.severity]),
    );
    expect(byKind).toEqual({ '1 denial': 'high', '1 answered question': 'info' });
  });

  it('collapses several denials into one chip', () => {
    const nodes = [1, 2, 3].map((i) => ({
      id: `h${i}`,
      kind: 'human',
      label: 'denied Edit',
      status: 'completed',
      interventionKind: 'denial',
    }));
    const [sig] = deriveSignals(ir(nodes, chain(nodes)));
    expect(sig.label).toBe('3 denials');
    expect(sig.nodeIds).toHaveLength(3);
  });
});

describe('outlier', () => {
  it('is one info signal for the whole run, never a per-node badge', async () => {
    const { signals } = await signalsFor(TROUBLE_RUN_ID);
    const hot = signals.filter((s) => s.kind === 'outlier');
    expect(hot).toHaveLength(1);
    expect(hot[0].severity).toBe('info');
    expect(hot[0].label).toBe('1 outsized step');
  });

  it('respects the absolute floor, so a small run flags nothing', () => {
    // 10× the median, but nowhere near the floor: in a six-node run everything
    // is 3× the median, which is exactly why the floor exists.
    const nodes = [
      tool('a', { durationMs: 1000 }),
      tool('b', { durationMs: 1000 }),
      tool('c', { durationMs: 10000 }),
    ];
    expect(deriveSignals(ir(nodes, chain(nodes)))).toEqual([]);
  });

  it('fires once past the floor', () => {
    const big = THRESHOLDS.outlierMinDurationMs * 4;
    const nodes = [
      tool('a', { durationMs: big / 20 }),
      tool('b', { durationMs: big / 20 }),
      tool('c', { durationMs: big }),
    ];
    const [sig] = deriveSignals(ir(nodes, chain(nodes)));
    expect(sig.kind).toBe('outlier');
    expect(sig.nodeIds).toEqual([nodes[2].id]);
  });
});

describe('course-change', () => {
  it('promotes existing edge lineage and infers nothing', () => {
    const nodes = [tool('a'), tool('b'), tool('c')];
    const edges = chain(nodes);
    edges[0].reason = 'after permission denial';
    const [sig] = deriveSignals(ir(nodes, edges));
    expect(sig.kind).toBe('course-change');
    expect(sig.severity).toBe('info');
    expect(sig.nodeIds).toEqual([nodes[1].id]);
    expect(sig.reason).toContain('after permission denial');
  });

  it('stays quiet when no edge carries a reason', () => {
    const nodes = [tool('a'), tool('b')];
    expect(deriveSignals(ir(nodes, chain(nodes)))).toEqual([]);
  });
});

describe('contract', () => {
  it('orders high before info, then by position in the run', async () => {
    for (const ref of refs) {
      const { ir: graph } = await parse(ref);
      const ranks = deriveSignals(graph).map((s) => (s.severity === 'high' ? 0 : 1));
      expect(ranks).toEqual([...ranks].sort());
    }
  });

  it('every nodeId exists, and no signal is empty', async () => {
    for (const ref of refs) {
      const { ir: graph } = await parse(ref);
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const s of deriveSignals(graph)) {
        expect(s.nodeIds.length, s.id).toBeGreaterThan(0);
        for (const id of s.nodeIds) expect(ids.has(id), `${s.id} → ${id}`).toBe(true);
        expect(typeof s.label).toBe('string');
        expect(typeof s.reason).toBe('string');
      }
    }
  });

  // Ids ride on stable node ids so the frontend can tell "a new thing went
  // wrong" from "the same thing, re-derived" — a counter would fire a false
  // escalation on every live-tail tick.
  it('ids are stable across re-parses', async () => {
    const ref = refs.find((r) => r.runId === TROUBLE_RUN_ID);
    const a = deriveSignals((await parse(ref)).ir).map((s) => s.id);
    const b = deriveSignals((await parse(ref)).ir).map((s) => s.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('toolFamily recovers the tool name from a descriptive label', () => {
    expect(toolFamily({ label: 'Edit · token.js ×6' })).toBe('Edit');
    expect(toolFamily({ label: 'Bash · npm test' })).toBe('Bash');
    expect(toolFamily({ label: 'Hypervisor' })).toBe('Hypervisor');
    expect(toolFamily({ label: 'mcp__x__y ×2' })).toBe('mcp__x__y');
    expect(toolFamily({})).toBe('');
  });

  it('tolerates a malformed IR instead of throwing', () => {
    for (const bad of [null, {}, { nodes: null }, { nodes: [null, 7, {}] }, ir([tool('x')], [null, {}])]) {
      expect(() => deriveSignals(bad)).not.toThrow();
    }
  });

  it('attachSignals never lets a derivation failure cost the graph', () => {
    const graph = ir([tool('x')]);
    Object.defineProperty(graph, 'edges', {
      get() {
        throw new Error('boom');
      },
    });
    expect(attachSignals(graph).signals).toEqual([]);
  });

  // Re-derived on every live-tail delta, so "trivial" has to be measured.
  it('is fast enough to run on every live delta of a large run', () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 1000; i++) {
      nodes.push(
        tool(`Bash · step ${i % 17}`, {
          id: `n${i}`,
          status: i % 37 === 0 ? 'error' : 'completed',
          errorCount: i % 37 === 0 ? 1 : 0,
          durationMs: 1000 + (i % 90) * 1000,
          tokens: { input: 100 + i, output: 200 },
          files: [`/repo/src/file${i % 60}.js`],
        }),
      );
      if (i) edges.push({ id: `e${i}`, kind: 'sequence', from: `n${i - 1}`, to: `n${i}` });
    }
    const big = ir(nodes, edges);
    deriveSignals(big); // warm
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) deriveSignals(big);
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});
