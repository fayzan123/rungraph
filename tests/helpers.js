import { readdir, utimes, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
export const CODEX_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');

/**
 * Pin every fixture file's mtime to a fixed past instant so liveness
 * detection and index ordering are deterministic in snapshots.
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

/**
 * Every run a full scan of both fixture roots contains: 6 Claude
 * (2 sessions + clean + trouble + secrets + 1 workflow) + 3 Codex
 * (clean + subagent parent + old-format; child/grandchild rollouts are not
 * independent runs).
 */
export const FIXTURE_RUN_COUNT = 9;
