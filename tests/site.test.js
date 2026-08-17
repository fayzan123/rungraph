import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realApi from '../frontend/src/api.js';
import * as staticApi from '../site/src/api-static.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data');
const load = async (name) => JSON.parse(await readFile(join(DATA, name), 'utf8'));

describe('api-static (the embed data layer)', () => {
  it('exports exactly the api.js contract', () => {
    expect(Object.keys(staticApi).sort()).toEqual(Object.keys(realApi).sort());
  });

  it('re-exports applyDelta unchanged — one merge implementation', () => {
    expect(staticApi.applyDelta).toBe(realApi.applyDelta);
  });

  it('watchGraph never constructs an EventSource and reports connected', () => {
    let status = null;
    const unsub = staticApi.watchGraph('any', () => {}, (ok) => (status = ok));
    expect(status).toBe(true);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('postFocus resolves like a healthy one-client dashboard', async () => {
    const r = await staticApi.postFocus('run', ['n1'], 'label', 'reason');
    expect(r.ok).toBe(true);
    expect(r.clientCount).toBe(1);
  });

  // Round-trip against the COMMITTED data files, with fetch stubbed to serve
  // them: a path typo inside api-static would otherwise only surface as a
  // broken embed in a browser.
  it('fetchIndex/fetchGraph/fetchDetail resolve against the baked files', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (path) => {
      try {
        const body = await readFile(join(DATA, String(path).replace(/^data\//, '')), 'utf8');
        return { ok: true, json: async () => JSON.parse(body), text: async () => body };
      } catch {
        return { ok: false, status: 404 };
      }
    };
    try {
      const index = await staticApi.fetchIndex();
      const runId = index.runs[0].runId;
      const graph = await staticApi.fetchGraph(runId);
      expect(graph.meta.runId).toBe(runId);
      const withDetail = graph.nodes.find((n) => n.hasDetail);
      const detail = await staticApi.fetchDetail(runId, withDetail.id);
      expect(detail.kind).toBeTruthy();
      await expect(staticApi.fetchGraph('nope')).rejects.toThrow(/404/);
      await expect(staticApi.fetchDetail(runId, 'nope')).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the baked demo run', () => {
  // The bake step is the fourth deriveSignals consumer (cli, server, watcher,
  // bake): a baked graph without signals means the static embed and every
  // other surface would disagree about what went wrong in the run.
  it('graph.json carries derived signals, and the story-bearing kinds', async () => {
    const g = await load('graph.json');
    expect(g.irVersion).toBe(1);
    expect(Array.isArray(g.signals)).toBe(true);
    const kinds = g.signals.map((s) => s.kind);
    for (const kind of ['retry-storm', 'unresolved-error', 'intervention']) {
      expect(kinds).toContain(kind);
    }
    const known = new Set(g.nodes.map((n) => n.id));
    for (const s of g.signals) {
      expect(s.nodeIds.length).toBeGreaterThan(0);
      for (const id of s.nodeIds) expect(known.has(id)).toBe(true);
    }
  });

  it('details.json covers every node that promises detail', async () => {
    const g = await load('graph.json');
    const details = await load('details.json');
    for (const n of g.nodes) {
      if (n.hasDetail) expect(details[n.id], `missing detail for ${n.label}`).toBeTruthy();
    }
    for (const id of Object.keys(details)) {
      expect(g.nodes.some((n) => n.id === id)).toBe(true);
    }
  });

  it('index.json names the one baked run', async () => {
    const g = await load('graph.json');
    const index = await load('index.json');
    expect(index.runs).toHaveLength(1);
    expect(index.runs[0].runId).toBe(g.meta.runId);
    expect(index.runs[0].active).toBe(false);
  });

  it('loop.json is a captured answer pointing at real nodes', async () => {
    const g = await load('graph.json');
    const loop = await load('loop.json');
    expect(loop.question.length).toBeGreaterThan(10);
    expect(loop.answer.length).toBeGreaterThan(40);
    const known = new Set(g.nodes.map((n) => n.id));
    expect(loop.nodeIds.length).toBeGreaterThan(0);
    for (const id of loop.nodeIds) expect(known.has(id)).toBe(true);
  });

  // The staging privacy rule, as a tripwire: nothing from the owner's real
  // working sessions — paths, identity — may ever enter site/data. The demo
  // run lives at /Users/Shared/rungraph-demo precisely so no home-directory
  // path can appear. If this fails, re-stage; never hand-edit the JSON.
  it('carries nothing from the owner machine outside the demo repo', async () => {
    for (const name of ['graph.json', 'details.json', 'index.json', 'loop.json', 'export.txt']) {
      const text = await readFile(join(DATA, name), 'utf8').catch(() => '');
      for (const banned of ['/Users/fayzanmalik', 'fayzanm786', 'Documents/GitHub/rungraph']) {
        expect(text.includes(banned), `${name} leaks "${banned}"`).toBe(false);
      }
    }
  });
});
