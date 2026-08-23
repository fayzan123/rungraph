import { readdir, utimes, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
export const CODEX_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
export const HERMES_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hermes');
export const OPENCODE_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
/** Cursor is two roots under one adapter: the IDE store dir and the cursor-agent data dir. */
export const CURSOR_IDE_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor', 'ide');
export const CURSOR_CLI_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor', 'cli');
export const CURSOR_FIXTURE_ROOTS = [CURSOR_IDE_FIXTURE_ROOT, CURSOR_CLI_FIXTURE_ROOT];

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
  await walk(OPENCODE_FIXTURE_ROOT);
  await walk(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor'));
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
/** Lightly drifted, zero signals — the coverage QUIET trigger (95% read). */
export const DRIFT_QUIET_RUN_ID =
  'claude-code:-home-dev-acme:66666666-6666-4666-8666-666666666666';
/** Heavily drifted, zero signals — the coverage LOUD trigger (21% read). */
export const DRIFT_LOUD_RUN_ID =
  'claude-code:-home-dev-acme:77777777-7777-4777-8777-777777777777';

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
 * opencode: the fixture DB corpus (tests/opencode.test.js, Node ≥ 22.13 only).
 * Ids are deliberately NOT in time order — real opencode session ids sort
 * DESCENDING with time, so anything that orders by id fails on this corpus.
 */
export const OC_CLEAN_RUN_ID = 'opencode:ses_fx9000000000000000clean';
export const OC_BATCH_RUN_ID = 'opencode:ses_fxd0000000000000batch';
export const OC_TROUBLE_RUN_ID = 'opencode:ses_fx8000000000000trouble';
export const OC_SUBAGENT_RUN_ID = 'opencode:ses_fx7000000000000000task';
export const OC_CHILD_ID = 'ses_fx7a00000000000child01';
export const OC_ORPHAN_CHILD_ID = 'ses_fx7b00000000000child02';
export const OC_MISSING_CHILD_ID = 'ses_fx7c00000000000missing';
export const OC_DRIFT_QUIET_RUN_ID = 'opencode:ses_fx6000000000000quiet0';
export const OC_DRIFT_LOUD_RUN_ID = 'opencode:ses_fx5000000000000000loud';
export const OC_TRUNCATION_RUN_ID = 'opencode:ses_fx4000000000000trunca';
export const OC_SECRETS_RUN_ID = 'opencode:ses_fx3000000000000secret';
export const OC_ARCHIVED_RUN_ID = 'opencode:ses_fx2000000000000archiv';
export const OC_REVERTED_RUN_ID = 'opencode:ses_fx1000000000000revert';
export const OC_INTERRUPTED_RUN_ID = 'opencode:ses_fx0000000000000000int';
export const OC_FORK_RUN_ID = 'opencode:ses_fxa000000000000000fork';
export const OC_COMPACTION_RUN_ID = 'opencode:ses_fxb00000000000compact';
export const OC_SHAPE_RUN_ID = 'opencode:ses_fxc0000000000000shape';
/** Revert crossing a subagent lane — the lane must inherit the boundary. */
export const OC_REVERT_LANE_RUN_ID = 'opencode:ses_fxe0000000000revertlane';
export const OC_LANE_CHILD_ID = 'ses_fxe1000000000lanechild';
/** A refused `task`, an in-flight one, and a refused parallel batch. */
export const OC_DENY_TASK_RUN_ID = 'opencode:ses_fxf00000000000denytask';

/**
 * Cursor: the fixture corpus (tests/cursor.test.js, Node ≥ 22.13 only).
 * IDE composers under tests/fixtures/cursor/ide/state.vscdb, CLI chats under
 * tests/fixtures/cursor/cli/chats/<md5(cwd)>/<agentId>/.
 */
export const CU_CLEAN_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-00000000c1ea';
export const CU_TROUBLE_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-000000780b1e';
export const CU_REJECTION_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-0000000e7ec7';
export const CU_INFLIGHT_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-00000000f11e';
export const CU_SUBAGENT_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-0000005ab000';
export const CU_CHILD_TASK_ID = 'task-c0c0c0c0-0000-4000-8000-0000005ab001';
export const CU_CHILD_INFO_ID = 'c0c0c0c0-0000-4000-8000-0000005ab002';
export const CU_MISSING_CHILD_ID = 'c0c0c0c0-0000-4000-8000-0000005ab0ff';
export const CU_TOMBSTONED_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-0000007011b5';
export const CU_UNSUPPORTED_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-000000000003';
export const CU_DEGRADED_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-000000000009';
export const CU_CROSS_PROJECT_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-00000000c055';
export const CU_BUCKET_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-000000b0c4e7';
export const CU_SECRETS_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-0000005ec7e7';
export const CU_CLI_REV2_RUN_ID = 'cursor:13fc220d-0000-4000-8000-000000000002';
export const CU_CLI_REV3_RUN_ID = 'cursor:2acba01b-0000-4000-8000-000000000003';
export const CU_CLI_INFLIGHT_RUN_ID = 'cursor:f11ef11e-0000-4000-8000-000000000004';
export const CU_CLI_BROKEN_ROOT_RUN_ID = 'cursor:badf00d0-0000-4000-8000-000000000005';
export const CU_GRANDCHILD_ID = 'c0c0c0c0-0000-4000-8000-0000005ab011';
export const CU_BATCH_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-00000000ba7c';
export const CU_EDIT_RUN_ID = 'cursor:c0c0c0c0-0000-4000-8000-000000000ed1';
export const CU_CLI_BATCH_RUN_ID = 'cursor:ba7cba7c-0000-4000-8000-000000000006';
export const CU_CLI_SIBLING_RUN_ID = 'cursor:51b11b51-0000-4000-8000-000000000007';
/** The two live key values the IDE fixtures carry, and the CLI's 64-hex one. None may ever reach an IR. */
export const CU_IDE_BLOB_KEY = 'Q3Vyc29yQmxvYktleUZpeHR1cmVTZWNyZXRWYWx1ZTAwMDE=';
export const CU_IDE_SUMMARY_KEY = 'U3BlY3VsYXRpdmVLZXlGaXh0dXJlU2VjcmV0VmFsdWUwMDAy';
export const CU_CLI_BLOB_KEY = 'fe5262' + 'c0ffee'.repeat(9) + '0042';

/**
 * Every run a full scan of the claude + codex fixture roots contains: 8
 * Claude (2 sessions + clean + trouble + secrets + 2 drift + 1 workflow) + 3 Codex
 * (clean + subagent parent + old-format; child/grandchild rollouts are not
 * independent runs). Hermes fixture runs are NOT in this count — the
 * cross-cutting suites disable all THREE SQLite adapters (RUNGRAPH_HERMES_HOME='',
 * RUNGRAPH_OPENCODE_HOME='', and both Cursor roots) so they stay green on the
 * Node 20 CI leg, and tests/hermes.test.js / tests/opencode.test.js /
 * tests/cursor.test.js scan those fixtures behind their own node:sqlite gates.
 * Disabling them also keeps a suite from wandering into the developer's REAL
 * opencode and Cursor databases, which are global files in fixed locations
 * rather than per-project trees.
 */
export const FIXTURE_RUN_COUNT = 11;
