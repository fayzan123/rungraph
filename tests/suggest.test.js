import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { attachSignals } from '../src/signals.js';
import { suggestQuestions } from '../frontend/src/suggest.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
  TROUBLE_RUN_ID,
  CLEAN_RUN_ID,
  EMPTY_RUN_ID,
} from './helpers.js';

const ROOT = '/home/dev/acme';
let irs;
beforeAll(async () => {
  await pinFixtureMtimes();
  const refs = await detect([FIXTURE_ROOT]);
  irs = {};
  for (const ref of refs) {
    const { ir } = await parse(ref);
    irs[ref.runId] = attachSignals(ir);
  }
});

const texts = (runId) => suggestQuestions(irs[runId], ROOT).map((q) => q.text);

describe('suggestQuestions', () => {
  // The whole onboarding bet: a question about *their* run teaches the
  // capability, where "ask your agent about this run" teaches nothing.
  it('names the file a retry storm fought with', () => {
    const qs = texts(TROUBLE_RUN_ID);
    expect(qs[0]).toBe('why did the Edit on token.js keep failing in this run?');
  });

  it('asks about an unresolved error by tool name', () => {
    expect(texts(TROUBLE_RUN_ID)).toContain(
      'what was the unresolved Bash error in this run, and did anything fix it?',
    );
  });

  it('asks what the human refused, when the run has a denial', () => {
    expect(texts(SESSION_RUN_ID)).toContain(
      'what did I refuse in this run, and what did the agent do instead?',
    );
  });

  it('names a subagent the user cannot otherwise see inside', () => {
    expect(texts(SESSION_RUN_ID).some((t) => t.includes('agent find?'))).toBe(true);
  });

  it('offers the files lane with a path relative to the project', () => {
    const qs = texts(CLEAN_RUN_ID);
    expect(qs).toContain('which steps touched CHANGELOG.md in this run?');
    expect(qs.every((t) => !t.includes(ROOT))).toBe(true); // never an absolute path
  });

  // A clean run has no signals at all, and is exactly where a first-time user
  // is most likely to be looking.
  it('always leaves the user with something to try', () => {
    for (const runId of Object.keys(irs)) {
      const qs = texts(runId);
      if (runId === EMPTY_RUN_ID) continue; // no nodes, nothing to ask about
      expect(qs.length, runId).toBeGreaterThan(0);
      expect(qs.length, runId).toBeLessThanOrEqual(4);
      expect(new Set(qs).size, runId).toBe(qs.length); // no duplicates
    }
  });

  it('says nothing about a run with no nodes', () => {
    expect(suggestQuestions(irs[EMPTY_RUN_ID], ROOT)).toEqual([]);
    expect(suggestQuestions(null, ROOT)).toEqual([]);
    expect(suggestQuestions({ nodes: [] }, ROOT)).toEqual([]);
  });

  it('falls back to the file name when the path is too long to read in a sentence', () => {
    const ir = {
      nodes: [
        { id: 'a', kind: 'tool', label: 'Edit · x', files: [`${ROOT}/docs/specs/2026-08-12-a-very-long-design-document.md`] },
      ],
    };
    const q = suggestQuestions(ir, ROOT).find((x) => x.from === 'files');
    expect(q.text).toBe('which steps touched 2026-08-12-a-very-long-design-document.md in this run?');
  });

  it('asks about an outsized step by name', () => {
    const ir = {
      nodes: [{ id: 'a', kind: 'turn', label: 'ship it' }],
      signals: [{ id: 'sig:outlier', kind: 'outlier', severity: 'info', nodeIds: ['a'], label: '1 outsized step' }],
    };
    expect(suggestQuestions(ir, ROOT)[0].text).toBe(
      'why did “ship it” cost so much more than the rest of this run?',
    );
  });

  it('puts the most specific question first', () => {
    // trouble run leads with its storm, clean run leads with its files
    expect(suggestQuestions(irs[TROUBLE_RUN_ID], ROOT)[0].from).toBe('retry-storm');
    expect(suggestQuestions(irs[CLEAN_RUN_ID], ROOT)[0].from).toBe('files');
  });

  it('survives a graph with no signals or files field at all', () => {
    const bare = { nodes: [{ id: 'a', kind: 'turn', label: 'do the thing' }] };
    const qs = suggestQuestions(bare);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => typeof q.text === 'string')).toBe(true);
  });
});
