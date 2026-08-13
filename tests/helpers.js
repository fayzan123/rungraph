import { readdir, utimes, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');

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

/** Every run the fixture tree contains (2 sessions + clean + trouble + 1 workflow). */
export const FIXTURE_RUN_COUNT = 5;
