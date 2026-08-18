import { readdir, utimes, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
export const CODEX_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
export const HERMES_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hermes');

/**
 * Pin every fixture file's mtime to a fixed past instant so liveness
 * detection and index ordering are deterministic in snapshots. (Hermes runs
 * derive both from DB columns, not file stats — pinned anyway for hygiene.)
 */
export async function pinFixtureMtimes(when = new Date('2026-08-01T13:00:00Z')) {
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      await utimes(p, when, when);
    }
  }
  await walk(FIXTURE_ROOT);
  await walk(CODEX_FIXTURE_ROOT);
  await walk(HERMES_FIXTURE_ROOT);
}

export const SESSION_RUN_ID =
  'claude-code:-home-dev-acme:11111111-1111-4111-8111-111111111111';
export const WORKFLOW_RUN_ID = `${SESSION_RUN_ID}:wf_12345678-abc`;
export const EMPTY_RUN_ID =
  'claude-code:-home-dev-acme:22222222-2222-4222-8222-222222222222';
/** A run where nothing went wrong — the signal layer's precision guard. */
export const CLEAN_RUN_ID =
  'claude-code:-home-dev-acme:33333333-3333-4333-8333-333333333333';
/** One of every high-severity signal, end to end through the real adapter. */
export const TROUBLE_RUN_ID =
  'claude-code:-home-dev-acme:44444444-4444-4444-8444-444444444444';
/** One of every secrets-scanner pattern kind — `export` must block on it. */
export const SECRETS_RUN_ID =
  'claude-code:-home-dev-acme:55555555-5555-4555-8555-555555555555';

/** Codex: a clean run (zero signals) and a subagent run (cross-file lineage). */
export const CODEX_CLEAN_RUN_ID = 'codex:c1c1c1c1-0000-7000-8000-000000000001';
export const CODEX_SUBAGENT_RUN_ID = 'codex:c2c2c2c2-0000-7000-8000-000000000002';
export const CODEX_CHILD_THREAD_ID = 'c2c2c2c2-0000-7000-8000-00000000c41d';
export const CODEX_GRANDCHILD_THREAD_ID = 'c2c2c2c2-0000-7000-8000-00000000c42d';
/** 0.89-era: no task events; turns bound by user_message ordering. */
export const CODEX_OLD_RUN_ID = 'codex:c3c3c3c3-0000-7000-8000-000000000003';

/** Hermes: the fixture DB corpus (tests/hermes.test.js, Node ≥ 22.13 only). */
export const HERMES_CLEAN_RUN_ID = 'hermes:20260801_120000_c1ea01';
export const HERMES_TROUBLE_RUN_ID = 'hermes:20260801_121500_780b1e';
export const HERMES_DELEG_RUN_ID = 'hermes:20260801_123000_de1e60';
export const HERMES_CHILD_A_ID = '20260801_123001_c41d01';
export const HERMES_CHILD_B_ID = '20260801_123002_c41d02';
export const HERMES_EMPTY_RUN_ID = 'hermes:20260801_124500_e30071';
export const HERMES_REPO_RUN_ID = 'hermes:20260801_125000_9e0666';
export const HERMES_GATEWAY_RUN_ID = 'hermes:20260801_125500_6a7e3a';
export const HERMES_LEGACY_RUN_ID = 'hermes:20260701_090000_1e64c1';

/**
 * Every run a full scan of the claude + codex fixture roots contains: 6
 * Claude (2 sessions + clean + trouble + secrets + 1 workflow) + 3 Codex
 * (clean + subagent parent + old-format; child/grandchild rollouts are not
 * independent runs). Hermes fixture runs are NOT in this count — the
 * cross-cutting suites disable that adapter (RUNGRAPH_HERMES_HOME='') so
 * they stay green on the Node 20 CI leg, and tests/hermes.test.js scans the
 * Hermes fixtures behind its own node:sqlite gate.
 */
export const FIXTURE_RUN_COUNT = 9;
