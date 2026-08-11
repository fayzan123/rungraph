import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonLines } from '../src/util.js';
import { diffGraphs } from '../src/watcher.js';

describe('readJsonLines', () => {
  it('tolerates a truncated trailing line (live tail mid-write)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rg-'));
    const f = join(dir, 'x.jsonl');
    await writeFile(f, '{"a":1}\n{"b":2}\n{"c":3,"tru'); // no closing brace
    const objs = [];
    let bad = 0;
    for await (const { obj } of readJsonLines(f, { onBadLine: () => bad++ })) objs.push(obj);
    expect(objs).toEqual([{ a: 1 }, { b: 2 }]);
    expect(bad).toBe(1);
  });
});

describe('diffGraphs', () => {
  const g = (nodes, edges = []) => ({
    irVersion: 1,
    meta: { runId: 'r', totals: {} },
    nodes,
    edges,
    groups: [],
  });

  it('emits a snapshot when there is no previous graph', () => {
    const next = g([{ id: 'n1', kind: 'turn' }]);
    expect(diffGraphs(null, next)).toEqual({ type: 'snapshot', graph: next });
  });

  it('emits only changed and added items, keyed by id', () => {
    const prev = g([{ id: 'n1', status: 'running' }, { id: 'n2', status: 'completed' }]);
    const next = g([{ id: 'n1', status: 'completed' }, { id: 'n2', status: 'completed' }, { id: 'n3', status: 'running' }]);
    const d = diffGraphs(prev, next);
    expect(d.type).toBe('delta');
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n3']);
    expect(d.removedNodeIds).toEqual([]);
  });

  it('returns null when nothing changed', () => {
    const a = g([{ id: 'n1' }]);
    expect(diffGraphs(a, structuredClone(a))).toBeNull();
  });

  it('reports removals', () => {
    const d = diffGraphs(g([{ id: 'n1' }, { id: 'n2' }]), g([{ id: 'n1' }]));
    expect(d.removedNodeIds).toEqual(['n2']);
  });
});
