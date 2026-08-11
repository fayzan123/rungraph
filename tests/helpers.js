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
