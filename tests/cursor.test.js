import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detect,
  parse,
  scanWarnings,
  resumeInfo,
  fingerprint,
  watchTargets,
  matchesProject,
} from '../src/adapters/cursor/index.js';
import { ideProject } from '../src/adapters/cursor/detect.js';
import { cliOutcome, ideOutcome } from '../src/adapters/cursor/outcome.js';
import { CLIENT_SIDE_TOOL_V2, toolFamily, toolFiles, toolHint } from '../src/adapters/cursor/tools.js';
import { instant, isoAny, parseJson } from '../src/adapters/cursor/db.js';
import { decodeMessageBlob, readMeta0, rootMessageIds } from '../src/adapters/cursor/cli/read.js';
import { cliToolFiles, parseProseTimestamp, unwrapUserQuery } from '../src/adapters/cursor/cli/parse.js';
import { composerUpdatedAt, isSubagentComposer, isValidComposer, toolLabel } from '../src/adapters/cursor/ide/parse.js';
import { scan, toIndexEntry, ADAPTERS, defaultRootDirs } from '../src/scanner.js';
import { deriveSignals } from '../src/signals.js';
import { classifyCoverage, coveragePercent } from '../src/coverage.js';
import { redactTree, scanText, walkStrings, SECRET_KEY_NAMES } from '../src/secrets.js';
import { CLIENTS, clientByName } from '../src/clients.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CURSOR_IDE_FIXTURE_ROOT,
  CURSOR_CLI_FIXTURE_ROOT,
  CURSOR_FIXTURE_ROOTS,
  CU_CLEAN_RUN_ID,
  CU_TROUBLE_RUN_ID,
  CU_REJECTION_RUN_ID,
  CU_INFLIGHT_RUN_ID,
  CU_SUBAGENT_RUN_ID,
  CU_CHILD_TASK_ID,
  CU_CHILD_INFO_ID,
  CU_MISSING_CHILD_ID,
  CU_TOMBSTONED_RUN_ID,
  CU_UNSUPPORTED_RUN_ID,
  CU_DEGRADED_RUN_ID,
  CU_CROSS_PROJECT_RUN_ID,
  CU_BUCKET_RUN_ID,
  CU_SECRETS_RUN_ID,
  CU_CLI_REV2_RUN_ID,
  CU_CLI_REV3_RUN_ID,
  CU_CLI_INFLIGHT_RUN_ID,
  CU_CLI_BROKEN_ROOT_RUN_ID,
  CU_GRANDCHILD_ID,
  CU_BATCH_RUN_ID,
  CU_EDIT_RUN_ID,
  CU_CLI_BATCH_RUN_ID,
  CU_CLI_SIBLING_RUN_ID,
  CU_IDE_BLOB_KEY,
  CU_IDE_SUMMARY_KEY,
  CU_CLI_BLOB_KEY,
} from './helpers.js';

// The whole file rides on node:sqlite, like the Hermes and opencode suites:
// the Node 20 CI leg skips it (the adapter self-disables there — covered by
// the graceful-degrade block at the bottom, which is NOT skipped).
const requireBuiltin = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    requireBuiltin('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'rungraph.js');
const ADAPTER_DIR = join(HERE, '..', 'src', 'adapters', 'cursor');
const POSIX = process.platform !== 'win32';

beforeAll(() => pinFixtureMtimes());

const refFor = async (runId) => {
  const refs = await detect(CURSOR_FIXTURE_ROOTS);
  return refs.find((r) => r.runId === runId);
};
const irFor = async (runId, opts) => parse(await refFor(runId), opts);
const signalsFor = async (runId) => deriveSignals((await irFor(runId)).ir);
const kindsOf = (signals) => signals.map((s) => `${s.kind}:${s.label}`);
const nodesOf = (ir, kind) => ir.nodes.filter((n) => n.kind === kind);

/** Every string in an IR + its details, for the never-emit assertions. */
function allStrings(ir, details) {
  const out = [];
  walkStrings({ ir, details: Object.fromEntries(details) }, [], (_p, text) => out.push(text));
  return out;
}

// ---------------------------------------------------------------------------
// Shared SQLite module — the shared-code rule, applied to the third SQLite adapter.
// ---------------------------------------------------------------------------

describe('shared sqlite module', () => {
  it('the Cursor seam re-exports the SAME functions as src/sqlite.js', async () => {
    const shared = await import('../src/sqlite.js');
    const cursorDb = await import('../src/adapters/cursor/db.js');
    for (const name of ['loadSqlite', 'tableColumns', 'selectList']) {
      expect(cursorDb[name], name).toBe(shared[name]);
    }
    // Composer-level timestamps are epoch MILLISECONDS, like opencode's.
    expect(cursorDb.iso).toBe(shared.isoMillis);
  });

  it('the two time units parse to the same instant — the 1970 / 58000 AD trap', () => {
    // Composer-level `createdAt` (ms) and header-level `createdAt` (ISO) for
    // one moment must compare equal, or every spawn/turn placement is wrong.
    const ms = 1787250605847;
    const iso = '2026-08-20T18:30:05.847Z';
    expect(instant(ms)).toBe(ms);
    expect(instant(iso)).toBe(ms);
    expect(isoAny(ms)).toBe(iso);
    expect(isoAny(iso)).toBe(iso);
    expect(instant('not a date')).toBeUndefined();
    expect(isoAny(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor detect', () => {
  it('indexes both surfaces, newest first, with no warnings', async () => {
    const refs = await detect(CURSOR_FIXTURE_ROOTS);
    const index = refs.map(({ runId, surface, kind, title, project, projectFromCwd, version, supported, archived, startedAt, modifiedAt, sizeBytes }) => ({
      runId,
      surface,
      kind,
      title,
      project,
      projectFromCwd,
      version,
      supported,
      archived,
      startedAt,
      modifiedAt,
      sizeBytes,
    }));
    expect(index).toMatchSnapshot();
    expect(scanWarnings()).toEqual([]);
  });

  it('roots are classified by SHAPE: either one alone yields only its surface', async () => {
    const ide = await detect([CURSOR_IDE_FIXTURE_ROOT]);
    expect(ide.length).toBeGreaterThan(0);
    expect(ide.every((r) => r.surface === 'ide')).toBe(true);
    const cli = await detect([CURSOR_CLI_FIXTURE_ROOT]);
    expect(cli.length).toBeGreaterThan(0);
    expect(cli.every((r) => r.surface === 'cli')).toBe(true);
    // A root that is neither is skipped silently — an uninstalled surface is not a warning.
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-none-'));
    try {
      expect(await detect([tmp])).toEqual([]);
      expect(scanWarnings()).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('excludes what Cursor itself excludes: placeholders, drafts, cloud agents, subagents', async () => {
    const ids = (await detect(CURSOR_FIXTURE_ROOTS)).map((r) => r.runId);
    for (const excluded of [
      'cursor:c0c0c0c0-0000-4000-8000-0000000e0001', // 0 headers
      'cursor:c0c0c0c0-0000-4000-8000-0000000e0002', // 0 headers, _v:10
      'cursor:c0c0c0c0-0000-4000-8000-0000000d4af7', // isDraft
      'cursor:bc-c0c0c0c0-0000-4000-8000-00000000c10d', // cloud
      'cursor:c0c0c0c0-0000-4000-8000-00000000de4d', // NULL record
      `cursor:${CU_CHILD_TASK_ID}`, // subagent by `task-` prefix
      `cursor:${CU_CHILD_INFO_ID}`, // subagent by subagentInfo.parentComposerId
    ]) {
      expect(ids, excluded).not.toContain(excluded);
    }
  });

  it('CLI: a chat with no store.db, and one with hasConversation:false, are skipped silently', async () => {
    const ids = (await detect(CURSOR_FIXTURE_ROOTS)).map((r) => r.runId);
    expect(ids).not.toContain('cursor:00000000-0000-4000-8000-000000000570');
    expect(ids).not.toContain('cursor:00000000-0000-4000-8000-0000000000c0');
    expect(scanWarnings()).toEqual([]);
  });

  it('old composers are LISTED, flagged unsupported, never hidden', async () => {
    const ref = await refFor(CU_UNSUPPORTED_RUN_ID);
    expect(ref).toBeDefined();
    expect(ref.version).toBe(3);
    expect(ref.supported).toBe(false);
    expect(ref.title).toBe('Grocery List App Development Concept');
  });

  it('project attribution: repo → workspace → bucket, and the bucket is loose and unmatchable', async () => {
    expect(ideProject({ trackedGitRepos: [{ repoPath: '/a' }], workspaceIdentifier: { uri: { fsPath: '/b' } } })).toEqual({ project: '/a', projectFromCwd: true });
    expect(ideProject({ workspaceIdentifier: { uri: { fsPath: '/b' } } })).toEqual({ project: '/b', projectFromCwd: true });
    expect(ideProject({})).toEqual({ project: '✦ Cursor chats', projectFromCwd: false });
    const bucket = await refFor(CU_BUCKET_RUN_ID);
    expect(bucket.project).toBe('✦ Cursor chats');
    expect(bucket.projectFromCwd).toBe(false);
    expect(toIndexEntry(bucket).loose).toBe(true);
    expect(matchesProject(bucket, '/home/dev/acme')).toBe(false);
    // The degraded composer has no trackedGitRepos: the workspace fallback carries it.
    expect((await refFor(CU_DEGRADED_RUN_ID)).project).toBe('/home/dev/acme');
  });

  it('titles: name → first human bubble (ONE point lookup) → id; CLI: name unless "New Agent" → <user_query> → id', async () => {
    expect((await refFor(CU_CLEAN_RUN_ID)).title).toBe('Find.js functionality overview');
    expect((await refFor(CU_BUCKET_RUN_ID)).title).toBe('What is a monad?');
    expect((await refFor(CU_CLI_REV2_RUN_ID)).title).toMatch(/^Read src\/find\.js and summarize/);
    expect((await refFor(CU_CLI_REV2_RUN_ID)).title).not.toContain('<user_query>');
    expect((await refFor(CU_CLI_BROKEN_ROOT_RUN_ID)).title).toBe('Broken root');
  });

  it('archived composers are included and flagged', async () => {
    expect((await refFor(CU_TROUBLE_RUN_ID)).archived).toBe(true);
    expect((await refFor(CU_CLEAN_RUN_ID)).archived).toBe(false);
  });

  it('strict project scoping: a --project scan carries NOTHING from another project', async () => {
    const { runs } = await scan({ rootDirs: { cursor: CURSOR_FIXTURE_ROOTS }, project: '/home/dev/acme' });
    const ids = runs.map((r) => r.runId);
    expect(ids).toContain(CU_CLEAN_RUN_ID);
    expect(ids).toContain(CU_CLI_REV3_RUN_ID);
    expect(ids).not.toContain(CU_CROSS_PROJECT_RUN_ID);
    expect(ids).not.toContain(CU_BUCKET_RUN_ID);
    const notes = await scan({ rootDirs: { cursor: CURSOR_FIXTURE_ROOTS }, project: '/home/dev/notes' });
    expect(notes.runs.map((r) => r.runId)).toEqual([CU_CROSS_PROJECT_RUN_ID]);
  });

  it('defaultRootDirs composes two roots, each disabled alone by the empty string', () => {
    const saved = [process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE, process.env.RUNGRAPH_CURSOR_CLI_HOME, process.env.CURSOR_DATA_DIR];
    try {
      process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE = '/x/ide';
      process.env.RUNGRAPH_CURSOR_CLI_HOME = '/x/cli';
      expect(defaultRootDirs().cursor).toEqual(['/x/ide', '/x/cli']);
      process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE = '';
      expect(defaultRootDirs().cursor).toEqual(['/x/cli']);
      process.env.RUNGRAPH_CURSOR_CLI_HOME = '';
      expect(defaultRootDirs().cursor).toEqual([]);
      // `||`, not `??`: an exported-but-empty CURSOR_DATA_DIR spells "unset".
      delete process.env.RUNGRAPH_CURSOR_CLI_HOME;
      process.env.CURSOR_DATA_DIR = '';
      expect(defaultRootDirs().cursor[0]).toMatch(/\.cursor$/);
      process.env.CURSOR_DATA_DIR = '/data/cursor';
      expect(defaultRootDirs().cursor).toEqual(['/data/cursor']);
    } finally {
      for (const [i, k] of ['RUNGRAPH_CURSOR_GLOBAL_STORAGE', 'RUNGRAPH_CURSOR_CLI_HOME', 'CURSOR_DATA_DIR'].entries()) {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      }
    }
  });

  it('Cursor own predicates, verbatim', () => {
    expect(isSubagentComposer({ composerId: 'task-abc' })).toBe(true);
    expect(isSubagentComposer({ composerId: 'abc', subagentInfo: { parentComposerId: 'p' } })).toBe(true);
    expect(isSubagentComposer({ composerId: 'task-abc', isBestOfNSubcomposer: true })).toBe(false);
    expect(isSubagentComposer({ composerId: 'abc' })).toBe(false);
    expect(isValidComposer({ _v: 17, composerId: 'x', fullConversationHeadersOnly: [] })).toBe(true);
    expect(isValidComposer({ _v: 1, composerId: 'x', fullConversationHeadersOnly: [] })).toBe(false);
    expect(isValidComposer({ _v: 17, composerId: 'x', fullConversationHeadersOnly: [], isDraft: true })).toBe(false);
    expect(isValidComposer({ _v: 17, composerId: 'x', fullConversationHeadersOnly: [], isEphemeral: true })).toBe(false);
    expect(isValidComposer({ _v: 17, composerId: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parse — IDE
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor parse (IDE)', () => {
  it('clean run: the expected IR, zero signals, zero unread', async () => {
    const { ir } = await irFor(CU_CLEAN_RUN_ID);
    expect(ir).toMatchSnapshot();
    expect(deriveSignals(ir)).toEqual([]);
    expect(ir.meta.coverage).toEqual({ records: 7, unrecognized: 0, sourcesUnread: 0 });
    expect(classifyCoverage(ir.meta, 0)).toBe('none');
    expect(coveragePercent(ir.meta)).toBe(100);
    // Tokens are NOT reported; the context gauge lives in ext with its meaning intact.
    expect(ir.meta.totals.tokens).toBe(0);
    expect(nodesOf(ir, 'turn')[0].tokens).toBeUndefined();
    expect(ir.meta.ext.cursor.contextUsage).toEqual({ tokensUsed: 29900, tokenLimit: 256000, percent: 11.6796875 });
  });

  it('trouble run: the expected IR — error, rejected, cancelled and abort, each with its edge', async () => {
    const { ir } = await irFor(CU_TROUBLE_RUN_ID);
    expect(ir).toMatchSnapshot();
    const humans = nodesOf(ir, 'human');
    expect(humans.map((h) => h.interventionKind)).toEqual(['denial', 'denial', 'interrupt']);
    // EVERY denial carries a sequence edge FROM A TOOL NODE — what
    // humanRefused() in signals.js keys its exclusion on. The interrupt sits
    // after the run's last node: here that is the Edit's denial, so its edge
    // comes from that human node (the Edit is already excused by the denial).
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    for (const h of humans.filter((x) => x.interventionKind === 'denial')) {
      const from = ir.edges.filter((e) => e.kind === 'sequence' && e.to === h.id).map((e) => byId.get(e.from));
      expect(from.some((n) => n?.kind === 'tool'), `${h.label} has a tool→human edge`).toBe(true);
    }
    const interrupt = humans[2];
    const into = ir.edges.filter((e) => e.kind === 'sequence' && e.to === interrupt.id);
    expect(into).toHaveLength(1);
    expect(into[0].from).toBe(humans[1].id);
    // The refused command is a Shell group with a rejected call counted in errorCount.
    const deniedShell = humans[0];
    const shellEdge = ir.edges.find((e) => e.to === deniedShell.id && byId.get(e.from)?.kind === 'tool');
    expect(byId.get(shellEdge.from).label).toMatch(/^Shell/);
    expect(byId.get(shellEdge.from).errorCount).toBe(1);
    // The cancelled edit is its own failed node, then its denial, then the abort.
    const edit = ir.nodes.find((n) => n.label === 'Edit · permissions.json');
    expect(edit.status).toBe('error');
    expect(ir.edges.some((e) => e.from === edit.id && e.to === humans[1].id)).toBe(true);
    expect(ir.edges.some((e) => e.from === humans[1].id && e.to === humans[2].id)).toBe(true);
    expect(ir.meta.ext.cursor.isArchived).toBe(true);
    expect(ir.meta.ext.cursor.status).toBe('aborted');
  });

  it('trouble run: signals are the interventions and NOTHING work-quality for the refused calls', async () => {
    const signals = await signalsFor(CU_TROUBLE_RUN_ID);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain('intervention');
    expect(kinds).not.toContain('unresolved-error');
    expect(kinds).not.toContain('retry-storm');
    expect(kinds).not.toContain('outlier');
    expect(kindsOf(signals)).toEqual(expect.arrayContaining(['intervention:2 denials', 'intervention:1 interrupt']));
  });

  it('rejection run: a `completed` status with a `rejected` outcome → denial node + edge, no unresolved-error', async () => {
    const { ir } = await irFor(CU_REJECTION_RUN_ID);
    expect(ir).toMatchSnapshot();
    const denial = nodesOf(ir, 'human')[0];
    expect(denial.interventionKind).toBe('denial');
    expect(denial.label).toBe('denied Shell');
    const shell = ir.nodes.find((n) => n.label === 'Shell · Run npm test suite');
    expect(shell.status).toBe('error');
    expect(ir.edges.some((e) => e.kind === 'sequence' && e.from === shell.id && e.to === denial.id)).toBe(true);
    const signals = deriveSignals(ir);
    expect(kindsOf(signals)).toEqual(['intervention:1 denial']);
  });

  it('calibration guards: blockReason and the default selectedOption are NOT failures', async () => {
    const { ir, details } = await irFor(CU_TROUBLE_RUN_ID, { collectDetails: true });
    // Nine approved-and-ran commands carry `blockReason` + the default
    // `selectedOption: rejectAndTellWhatToDoDifferently`. All nine are ok.
    const shellCalls = [...details.values()].filter((d) => d.kind === 'tool' && d.name === 'Shell').flatMap((d) => d.calls);
    const okCalls = shellCalls.filter((c) => !c.isError);
    expect(okCalls.length).toBe(9);
    expect(shellCalls.filter((c) => c.isError).length).toBe(2); // the exit-1 and the refusal
    expect(ir.meta.totals.toolCalls).toBe(27);
  });

  it('turn durations come ONLY from turnDurationMs; thinking goes to the detail', async () => {
    const { ir, details } = await irFor(CU_CLEAN_RUN_ID, { collectDetails: true });
    const turn = nodesOf(ir, 'turn')[0];
    expect(turn.durationMs).toBe(10852);
    const d = details.get(turn.id);
    expect(d.kind).toBe('turn');
    expect(d.prompt).toMatch(/^Read src\/find\.js/);
    expect(d.responseText).toContain('pure, import-free substring matcher');
    expect(d.thinkingDurationMs).toBe(3387); // 3386 + 1
    expect(d.thinking).toContain('Reading src/find.js');
    // A turn whose final bubble has no turnDurationMs has NO duration — never a header delta.
    const trouble = (await irFor(CU_TROUBLE_RUN_ID)).ir;
    expect(nodesOf(trouble, 'turn')[0].durationMs).toBeUndefined();
    // IDE tool nodes never carry a duration.
    for (const n of nodesOf(trouble, 'tool')) expect(n.durationMs).toBeUndefined();
  });

  it('tool details: input/output from the parsed JSON strings, the error message when there is one', async () => {
    const { ir, details } = await irFor(CU_TROUBLE_RUN_ID, { collectDetails: true });
    const read = ir.nodes.find((n) => n.label === 'Read · SKILL.md ×3');
    const d = details.get(read.id);
    expect(d.calls).toHaveLength(3);
    const failed = d.calls.find((c) => c.isError);
    expect(failed.output).toContain('File not found');
    expect(failed.input).toContain('targetFile');
    expect(read.files).toHaveLength(3);
    expect(read.errorCount).toBe(1);
    expect(read.status).toBe('completed'); // 1 of 3 failed → not an error node
  });

  it('labels follow `<Family> · <hint>`; tool 0 keys on `name`; MCP tools report their own name', () => {
    expect(toolLabel('Shell', 'Run npm test suite')).toBe('Shell · Run npm test suite');
    expect(toolLabel('Read', undefined)).toBe('Read');
    expect(toolFamily({ name: 'run_terminal_command_v2', tool: 15 })).toBe('Shell');
    expect(toolFamily({ name: 'search_conversations', tool: 0 })).toBe('search_conversations');
    expect(toolFamily({ tool: 41 })).toBe('Grep'); // name absent → enum member
    expect(toolFamily({ tool: 0 })).toBe('tool');
    expect(toolFamily({ name: 'call_mcp_tool', tool: 49 }, { name: 'focus_nodes', server: 'rungraph' })).toBe('focus_nodes');
    expect(toolFamily({ name: 'call_mcp_tool', tool: 49 }, {})).toBe('MCP');
    expect(toolFamily({ name: 'brand_new_tool', tool: 99 })).toBe('brand_new_tool');
    expect(toolHint({ name: 'read_file_v2' }, { targetFile: '/a/b/c.js' })).toBe('c.js');
    expect(toolHint({ name: 'run_terminal_command_v2' }, { command: 'ls', commandDescription: 'List' })).toBe('List');
    expect(toolHint({ name: 'run_terminal_command_v2' }, { command: 'ls' })).toBe('ls');
    expect(toolHint({ name: 'ripgrep_raw_search' }, { pattern: 'x|y' })).toBe('x|y');
    expect(toolHint({ name: 'glob_file_search' }, { globPattern: '**/*' })).toBe('**/*');
    expect(Object.keys(CLIENT_SIDE_TOOL_V2)).toHaveLength(55);
    expect(CLIENT_SIDE_TOOL_V2[48]).toBe('TASK_V2');
    expect(CLIENT_SIDE_TOOL_V2[49]).toBe('CALL_MCP_TOOL');
  });

  it('files: read targetFile and edit relativeWorkspacePath (absolute despite the name); nothing else', () => {
    expect(toolFiles({ name: 'read_file_v2' }, { targetFile: '/a/b.js' })).toEqual(['/a/b.js']);
    expect(toolFiles({ name: 'edit_file_v2' }, { relativeWorkspacePath: '/a/c.js' })).toEqual(['/a/c.js']);
    expect(toolFiles({ name: 'ripgrep_raw_search' }, { path: '/a' })).toEqual([]);
    expect(toolFiles({ name: 'run_terminal_command_v2' }, { command: 'cat /a/b.js' })).toEqual([]);
    expect(toolFiles({ name: 'read_file_v2' }, { targetFile: 'bad\npath' })).toEqual([]);
  });

  it('in-flight: a `loading` call is running and nothing fires; an UNKNOWN status is not running and is tallied', async () => {
    const { ir } = await irFor(CU_INFLIGHT_RUN_ID);
    const shell = ir.nodes.find((n) => n.label.startsWith('Shell'));
    expect(shell.status).toBe('running');
    expect(shell.errorCount).toBe(0);
    expect(nodesOf(ir, 'turn')[0].status).toBe('running');
    expect(ir.meta.ext.cursor.unknownToolStatuses).toEqual({ finalizing: 1 });
    expect(ir.meta.ext.cursor.unknownTypes).toBeUndefined(); // drift in a status is not an unread record
    expect(deriveSignals(ir)).toEqual([]);
  });

  it('tombstoned: NULL / absent rows are sourcesUnread, skeleton nodes still render, skip flags are honoured', async () => {
    const { ir, details } = await irFor(CU_TOMBSTONED_RUN_ID, { collectDetails: true });
    expect(ir.meta.coverage).toEqual({ records: 10, unrecognized: 0, sourcesUnread: 5 });
    expect(classifyCoverage(ir.meta, 0)).toBe('quiet');
    expect(coveragePercent(ir.meta)).toBe(99);
    // The tombstoned HUMAN bubble is still a turn — the header said so.
    const turns = nodesOf(ir, 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1].label).toBe('(prompt not retained)');
    expect(details.get(turns[1].id).prompt).toContain('tombstoned');
    // The tombstoned TOOL bubble is still a Read — the header's grouping carries the tool id.
    const read = ir.nodes.find((n) => n.label === 'Read ×2');
    expect(read.callCount).toBe(2);
    expect(read.status).toBe('completed');
    expect(details.get(read.id).calls[0].output).toContain('tombstoned');
    expect(ir.meta.ext.cursor.skippedBubbles).toBe(2);
    expect(ir.meta.ext.cursor.orphanBubbles).toBe(1);
    // A tombstoned REFUSED command: the header's `shellStatus: 'rejected'`
    // still yields the denial node and its edge, with no body to read.
    const shell = ir.nodes.find((n) => n.kind === 'tool' && n.label === 'Shell');
    expect(shell.errorCount).toBe(1);
    const denial = nodesOf(ir, 'human').find((h) => h.interventionKind === 'denial');
    expect(denial.label).toBe('denied Shell');
    expect(ir.edges.some((e) => e.kind === 'sequence' && e.from === shell.id && e.to === denial.id)).toBe(true);
    expect(deriveSignals(ir).map((s) => s.kind)).toEqual(['intervention']);
    expect(ir.meta.coverage.sourcesUnread).toBe(5);
  });

  it('a refused batch of three families collapses into ONE denial; a retry after it is a second', async () => {
    const { ir } = await irFor(CU_BATCH_RUN_ID);
    const humans = nodesOf(ir, 'human');
    expect(humans.map((h) => h.label)).toEqual(['denied Shell, Edit, Shell', 'denied Shell']);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    // Every refused tool node points at the batch's one denial node…
    const intoBatch = ir.edges.filter((e) => e.kind === 'sequence' && e.to === humans[0].id).map((e) => byId.get(e.from));
    expect(intoBatch.filter((n) => n.kind === 'tool').map((n) => n.label).sort()).toEqual(['Edit · .gitignore', 'Shell · Force push', 'Shell · Remove dist']);
    // …and the retry chains off it as its own node with its own denial.
    const retry = ir.nodes.find((n) => n.label === 'Shell · Push');
    expect(ir.edges.some((e) => e.kind === 'sequence' && e.from === humans[0].id && e.to === retry.id)).toBe(true);
    expect(ir.edges.some((e) => e.kind === 'sequence' && e.from === retry.id && e.to === humans[1].id)).toBe(true);
    // A retry after a refusal IS a course change; nothing work-quality fires.
    const signals = deriveSignals(ir);
    expect(kindsOf(signals)).toContain('intervention:2 denials');
    expect(signals.map((s) => s.kind)).not.toContain('unresolved-error');
  });

  it('checkpoint files attach to the most recent Edit node, and to nothing after a read-only turn', async () => {
    const { ir } = await irFor(CU_EDIT_RUN_ID);
    const edit = ir.nodes.find((n) => n.label === 'Edit · math.js');
    expect(edit.status).toBe('completed');
    expect(edit.errorCount).toBe(0);
    // The edit's own path plus the checkpoint's `files[].uri.fsPath`, deduped; `nonExistentFiles` excluded.
    expect(edit.files).toEqual(['/home/dev/acme/math.js', '/home/dev/acme/math.test.js']);
    const read = ir.nodes.find((n) => n.label === 'Read · math.js');
    expect(read.files).toEqual(['/home/dev/acme/math.js']); // README.md from the read-only checkpoint is NOT attached
    expect(deriveSignals(ir)).toEqual([]);
  });

  it('the interrupt is stamped from the conversation, not from lastUpdatedAt', async () => {
    const { ir } = await irFor(CU_TROUBLE_RUN_ID);
    const ref = await refFor(CU_TROUBLE_RUN_ID);
    const interrupt = nodesOf(ir, 'human').find((h) => h.interventionKind === 'interrupt');
    const lastHeaderAt = ir.nodes
      .map((n) => n.endedAt ?? n.startedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    expect(interrupt.startedAt).toBe(lastHeaderAt);
    expect(ir.meta.endedAt).toBe(lastHeaderAt);
    // lastUpdatedAt (the fixture writes it 60 s later) is the liveness gate, never the stamp.
    expect(Date.parse(ref.modifiedAt)).toBeGreaterThan(Date.parse(lastHeaderAt));
  });

  it('unsupported `_v:3`: listed, fully unread, loud, no crash', async () => {
    const { ir } = await irFor(CU_UNSUPPORTED_RUN_ID);
    expect(ir.nodes).toEqual([]);
    expect(ir.meta.coverage).toEqual({ records: 30, unrecognized: 30, sourcesUnread: 0 });
    expect(classifyCoverage(ir.meta, 0)).toBe('loud');
    expect(coveragePercent(ir.meta)).toBe(0);
    expect(ir.meta.ext.cursor.unsupportedVersion).toBe(true);
    expect(ir.meta.ext.cursor.unknownTypes).toEqual({ 'composer-v3': 30 });
    expect(ir.meta.title).toBe('Grocery List App Development Concept');
    expect(ir.meta.startedAt).toBe('2025-05-06T23:40:00.000Z');
  });

  it('degraded modern `_v:9`: valid IR at reduced coverage, no crash', async () => {
    const { ir } = await irFor(CU_DEGRADED_RUN_ID);
    expect(ir.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['turn', 'degraded: explain the scanner'],
      ['tool', 'Read · scanner.js'],
      ['tool', 'Shell · node --version'],
    ]);
    expect(ir.meta.coverage).toEqual({ records: 7, unrecognized: 2, sourcesUnread: 0 });
    expect(ir.meta.ext.cursor.unknownTypes).toEqual({ bubble: 1, 'bubble-type:3': 1 });
    expect(classifyCoverage(ir.meta, 0)).toBe('quiet');
    // No header createdAt, no bubble createdAt: nodes simply carry no timestamps.
    for (const n of ir.nodes) expect(n.startedAt).toBeUndefined();
    expect(ir.meta.ext.cursor._v).toBe(9);
    expect(ir.meta.ext.cursor.model).toBeUndefined();
  });

  it('subagents: lanes, spawn/return edges, both discovery routes, and a missing child as sourcesUnread', async () => {
    const { ir, details } = await irFor(CU_SUBAGENT_RUN_ID, { collectDetails: true });
    expect(ir).toMatchSnapshot();
    const agents = nodesOf(ir, 'agent');
    // Three lanes: the child listed in subComposerIds, the child found only by
    // its own parentComposerId, and a GRANDCHILD found only by that route
    // under the first child — the second route at depth 2.
    expect(agents.map((a) => a.agentId)).toEqual([CU_CHILD_TASK_ID, CU_GRANDCHILD_ID, CU_CHILD_INFO_ID]);
    expect(ir.groups.map((g) => g.label)).toEqual(['Audit hermes adapter', 'Check hermes fixtures', 'Audit opencode adapter']);
    expect(ir.meta.totals.agents).toBe(3);
    const grandchild = agents[1];
    const childTurn = ir.nodes.find((n) => n.kind === 'turn' && n.group === `lane:a:${CU_CHILD_TASK_ID}`);
    expect(ir.edges.some((e) => e.kind === 'spawn' && e.from === childTurn.id && e.to === grandchild.id)).toBe(true);
    const turn = nodesOf(ir, 'turn')[0];
    for (const a of agents.filter((x) => x.agentId !== CU_GRANDCHILD_ID)) {
      expect(ir.edges.some((e) => e.kind === 'spawn' && e.from === turn.id && e.to === a.id), 'spawn').toBe(true);
      expect(ir.edges.some((e) => e.kind === 'return' && e.from === a.id && e.to === turn.id), 'return').toBe(true);
      expect(details.get(a.id).kind).toBe('agent');
    }
    // The lane's nodes carry the group; the aborted child has its interrupt INSIDE the lane.
    const lane2 = ir.nodes.filter((n) => n.group === `lane:a:${CU_CHILD_INFO_ID}`);
    expect(lane2.some((n) => n.kind === 'human' && n.interventionKind === 'interrupt')).toBe(true);
    expect(agents[2].ext.cursor.status).toBe('aborted');
    expect(agents[0].files).toHaveLength(2);
    expect(ir.meta.coverage.sourcesUnread).toBe(1);
    expect(ir.meta.ext.cursor.missingChildComposers).toEqual([CU_MISSING_CHILD_ID]);
    expect(deriveSignals(ir).map((s) => s.kind)).toEqual(['intervention']);
  });

  it('the tree fingerprint moves when ONLY a child composer changes', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-fp-'));
    try {
      const copy = join(tmp, 'state.vscdb');
      await copyFile(join(CURSOR_IDE_FIXTURE_ROOT, 'state.vscdb'), copy);
      const before = fingerprint((await detect([tmp])).find((r) => r.runId === CU_SUBAGENT_RUN_ID));
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const db = new DatabaseSync(copy);
      const key = `composerData:${CU_CHILD_TASK_ID}`;
      const rec = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key).value);
      rec.lastUpdatedAt = Date.parse('2026-08-02T00:00:00Z');
      rec.fullConversationHeadersOnly.push({ bubbleId: 'new-bubble', type: 2, createdAt: '2026-08-02T00:00:00.000Z', grouping: { isRenderable: true, hasText: true } });
      db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(JSON.stringify(rec), key);
      db.close();
      const after = (await detect([tmp])).find((r) => r.runId === CU_SUBAGENT_RUN_ID);
      expect(fingerprint(after)).not.toBe(before);
      expect(after.modifiedAt).toBe('2026-08-02T00:00:00.000Z'); // liveness follows the tree too
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('`modifiedAt` source chain: lastUpdatedAt → last header → createdAt', () => {
    expect(composerUpdatedAt({ lastUpdatedAt: 5, createdAt: 1, fullConversationHeadersOnly: [{ createdAt: '2026-01-01T00:00:00Z' }] })).toBe(5);
    expect(composerUpdatedAt({ createdAt: 1, fullConversationHeadersOnly: [{ createdAt: '2026-01-01T00:00:00.000Z' }] })).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(composerUpdatedAt({ createdAt: 1, fullConversationHeadersOnly: [{}] })).toBe(1);
  });

  it('graph invariants hold for every run on both surfaces', async () => {
    for (const ref of await detect(CURSOR_FIXTURE_ROOTS)) {
      const { ir } = await parse(ref);
      const ids = new Set(ir.nodes.map((n) => n.id));
      expect(ids.size, ref.runId).toBe(ir.nodes.length);
      for (const e of ir.edges) {
        expect(ids.has(e.from), `${ref.runId} edge from ${e.from}`).toBe(true);
        expect(ids.has(e.to), `${ref.runId} edge to ${e.to}`).toBe(true);
      }
      for (const n of ir.nodes) {
        if (n.kind === 'tool' && n.status !== 'running') {
          expect(n.status === 'error', `${ref.runId} ${n.label}`).toBe(n.errorCount > 0 && n.errorCount >= n.callCount);
        }
        if (n.files) expect(n.files.length).toBeGreaterThan(0);
      }
      expect(ir.irVersion).toBe(1);
      expect(ir.meta.adapter).toBe('cursor');
      expect(ir.meta.kind).toBe('session');
      expect(ir.meta.totals.tokens).toBe(0);
      expect(['ide', 'cli']).toContain(ir.meta.ext.cursor.surface);
    }
  });
});

// ---------------------------------------------------------------------------
// The outcome classifier — §6, pinned
// ---------------------------------------------------------------------------

describe('cursor outcome classifier', () => {
  it('IDE: the four observed encodings of "did not succeed"', () => {
    expect(ideOutcome({ status: 'error' }, undefined)).toBe('error');
    expect(ideOutcome({ status: 'completed', additionalData: { status: 'rejected' } }, { rejected: true })).toBe('rejected');
    expect(ideOutcome({ status: 'completed', additionalData: { status: 'error' } }, { exitCode: 1 })).toBe('error');
    expect(ideOutcome({ status: 'cancelled' }, undefined)).toBe('rejected');
    // …and the plain success.
    expect(ideOutcome({ status: 'completed' }, { totalLinesInFile: 10 })).toBe('ok');
  });

  it('IDE calibration guards: blockReason and the dialog default are NOT failures', () => {
    const approved = {
      status: 'completed',
      additionalData: { status: 'success', blockReason: 'Not in allowlist: sqlite3', reviewData: { selectedOption: 'rejectAndTellWhatToDoDifferently' } },
    };
    expect(ideOutcome(approved, { output: 'rows', rejected: false })).toBe('ok');
    // Corroboration only: `selectedOption: skip` without the trigger is still ok.
    expect(ideOutcome({ status: 'completed', additionalData: { reviewData: { selectedOption: 'skip' } } }, {})).toBe('ok');
  });

  it('IDE: in-flight is exact; an unknown status is NOT running and is tallied', () => {
    for (const s of ['pending', 'loading', 'running', 'in_progress']) expect(ideOutcome({ status: s }, undefined)).toBe('running');
    for (const s of ['rejected', 'skipped']) expect(ideOutcome({ status: s }, undefined)).toBe('rejected');
    const seen = [];
    expect(ideOutcome({ status: 'finalizing' }, undefined, (s) => seen.push(s))).toBe('ok');
    expect(ideOutcome({ status: 'finalizing' }, { exitCode: 2 }, (s) => seen.push(s))).toBe('error');
    expect(ideOutcome({}, undefined, (s) => seen.push(s))).toBe('ok');
    expect(seen).toEqual(['finalizing', 'finalizing', '(none)']);
    // A known terminal status is never tallied.
    const none = [];
    ideOutcome({ status: 'completed' }, undefined, (s) => none.push(s));
    expect(none).toEqual([]);
  });

  it('IDE: a non-zero exitCode in the parsed result is an error even when nothing else says so', () => {
    expect(ideOutcome({ status: 'completed' }, { exitCode: 3 })).toBe('error');
    expect(ideOutcome({ status: 'completed' }, { exitCode: 0 })).toBe('ok');
    expect(ideOutcome({ status: 'completed' }, { exitCode: '3' })).toBe('ok'); // not an integer → not evidence
  });

  it('CLI: structure before prose, never isError', () => {
    const hl = (output, isError) => ({ providerOptions: { cursor: { highLevelToolCallResult: { output, isError } } } });
    expect(cliOutcome(hl({ success: {} }, false), { result: 'x' })).toBe('ok');
    expect(cliOutcome(hl({ error: { errorMessage: 'File not found' } }, true), { result: 'Error: File not found' })).toBe('error');
    // THE calibration guard: a non-zero exit is `failure` with isError FALSE.
    expect(cliOutcome(hl({ failure: { exitCode: 3 } }, false), { result: 'Exit code: 3' })).toBe('error');
    expect(cliOutcome(hl({ rejected: { command: 'x' } }, true), { result: 'Rejected: ' })).toBe('rejected');
    // A success whose isError is (wrongly) true is still ok: isError is never read.
    expect(cliOutcome(hl({ success: {} }, true), { result: 'x' })).toBe('ok');
  });

  it('CLI: the prose fallback when providerOptions is absent', () => {
    expect(cliOutcome({}, { result: 'Rejected: ' })).toBe('rejected');
    expect(cliOutcome({}, { result: 'Error: File not found' })).toBe('error');
    expect(cliOutcome({}, { result: 'Exit code: 3\n\nCommand output:' })).toBe('error');
    expect(cliOutcome({}, { result: 'Exit code: 0\n\nCommand output:' })).toBe('ok');
    expect(cliOutcome({}, { result: 'export function add() {}' })).toBe('ok');
    expect(cliOutcome({}, {})).toBe('ok');
    // Status lines, not content: a Read whose FILE begins with `Error:` or
    // `Exit code:` is a successful read of an unlucky file.
    expect(cliOutcome({}, { toolName: 'Read', result: 'Error: connection refused\nRetrying in 5s\n' })).toBe('ok');
    expect(cliOutcome({}, { toolName: 'Read', result: 'Exit code: 3 is what the script returns\n' })).toBe('ok');
    expect(cliOutcome({}, { toolName: 'Read', result: 'Error: File not found' })).toBe('error');
    expect(cliOutcome({}, { toolName: 'Shell', result: 'Exit code: 3\n\nCommand output:' })).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// parse — CLI
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor parse (CLI)', () => {
  it('rev 2 shape: the expected IR — a parallel batch, and two refusals as two denial nodes with edges', async () => {
    const { ir } = await irFor(CU_CLI_REV2_RUN_ID);
    expect(ir).toMatchSnapshot();
    const denials = nodesOf(ir, 'human');
    expect(denials).toHaveLength(2);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    for (const h of denials) {
      expect(h.interventionKind).toBe('denial');
      const from = ir.edges.filter((e) => e.kind === 'sequence' && e.to === h.id).map((e) => byId.get(e.from));
      expect(from.some((n) => n?.kind === 'tool')).toBe(true);
    }
    // The batch: Read, then Shell ×2 (ls ok + exit-3 refused) — one error of two calls, not an error node.
    const shell = ir.nodes.find((n) => n.label === 'Shell · List adapters directory contents ×2');
    expect(shell.callCount).toBe(2);
    expect(shell.errorCount).toBe(1);
    expect(shell.status).toBe('completed');
    // The retry after the refusal is its own Shell node, fully failed.
    const retry = ir.nodes.find((n) => n.label === 'Shell · Exit Node with code 3');
    expect(retry.status).toBe('error');
    expect(kindsOf(deriveSignals(ir))).toContain('intervention:2 denials');
    expect(deriveSignals(ir).map((s) => s.kind)).not.toContain('unresolved-error');
    expect(ir.meta.ext.cursor).toMatchObject({ surface: 'cli', mode: 'default', isRunEverything: false, model: 'cursor-grok-4.5-high' });
  });

  it('rev 3 shape: error + failure → error; applied StrReplace → files; injected context is not a turn; <user_query> is the label', async () => {
    const { ir, details } = await irFor(CU_CLI_REV3_RUN_ID, { collectDetails: true });
    expect(ir).toMatchSnapshot();
    const turns = nodesOf(ir, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].label).toMatch(/^You are in a throwaway calibration repo/);
    expect(turns[0].label).not.toContain('<user_query>');
    expect(turns[0].startedAt).toBe('2026-08-01T17:25:00.000Z'); // `Saturday, Aug 1, 2026, 1:25 PM (UTC-4)`
    // The missing-file Read and the exit-3 Shell are both errors at the call level.
    const read = ir.nodes.find((n) => n.label === 'Read · math.js ×2');
    expect(read.errorCount).toBe(1);
    const readCalls = details.get(read.id).calls;
    expect(readCalls.map((c) => c.isError)).toEqual([false, true]);
    expect(readCalls[1].output).toBe('Error: File not found');
    const shell = ir.nodes.find((n) => n.label === 'Shell · Run node with exit code 3 ×2');
    expect(shell.errorCount).toBe(1);
    const shellCalls = details.get(shell.id).calls;
    expect(shellCalls[0].isError).toBe(true); // failure{exitCode:3}, isError:false on the record
    expect(shellCalls[0].durationMs).toBe(1554); // localExecutionTimeMs
    expect(shellCalls[1].durationMs).toBe(8276);
    const edit = ir.nodes.find((n) => n.label === 'StrReplace · math.js');
    expect(edit.files).toEqual(['/home/dev/acme/math.js']);
    expect(edit.status).toBe('completed');
    expect(ir.meta.coverage).toEqual({ records: 16, unrecognized: 0, sourcesUnread: 0 });
    expect(deriveSignals(ir).map((s) => s.kind)).not.toContain('intervention');
    expect(ir.meta.ext.cursor.isRunEverything).toBe(true);
  });

  it('a refused batch from ONE assistant message collapses into one denial node with an edge from every refused call', async () => {
    const { ir } = await irFor(CU_CLI_BATCH_RUN_ID);
    const humans = nodesOf(ir, 'human');
    expect(humans.map((h) => h.label)).toEqual(['denied Read, Shell, StrReplace']);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const from = ir.edges.filter((e) => e.kind === 'sequence' && e.to === humans[0].id).map((e) => byId.get(e.from).label).sort();
    expect(from).toEqual(['Read · secrets.env', 'Shell · Remove dist', 'StrReplace · .gitignore']);
    for (const n of nodesOf(ir, 'tool')) expect(n.status).toBe('error');
    expect(kindsOf(deriveSignals(ir))).toEqual(['intervention:1 denial']);
  });

  it('a refusal excuses ONLY the refused call: a failed sibling in the same batch still reports unresolved-error', async () => {
    const { ir } = await irFor(CU_CLI_SIBLING_RUN_ID);
    const denial = nodesOf(ir, 'human')[0];
    const read = ir.nodes.find((n) => n.label === 'Read · secrets.env');
    const shell = ir.nodes.find((n) => n.label === 'Shell · Run the build');
    expect(shell.status).toBe('error');
    // The only tool→denial edge is from the refused Read; the failed Shell
    // must not inherit one just because it was the chain tip when the
    // rejection landed — that would silence its own failure.
    const intoDenial = ir.edges.filter((e) => e.kind === 'sequence' && e.to === denial.id).map((e) => e.from);
    expect(intoDenial).toEqual([read.id]);
    const kinds = deriveSignals(ir).map((s) => s.kind);
    expect(kinds).toContain('intervention');
    expect(kinds).toContain('unresolved-error');
  });

  it('the injected context is READ (it counts) and never rendered — nothing of it reaches IR or details', async () => {
    for (const runId of [CU_CLI_REV2_RUN_ID, CU_CLI_REV3_RUN_ID]) {
      const { ir, details } = await irFor(runId, { collectDetails: true });
      const text = allStrings(ir, details).join('\n');
      expect(text).not.toContain('<user_info>');
      expect(text).not.toContain('Do not leak this file into the graph');
      expect(text).not.toContain('<git_status>');
      expect(text).not.toContain('powered by Composer'); // the system prompt
      expect(ir.meta.coverage.records).toBeGreaterThanOrEqual(10); // …yet both are counted as read
    }
  });

  it('in-flight: a tool-call with no tool-result is running, and so is its turn', async () => {
    const { ir } = await irFor(CU_CLI_INFLIGHT_RUN_ID);
    expect(nodesOf(ir, 'tool').map((n) => [n.label, n.status])).toEqual([['Read · math.js', 'running']]);
    expect(nodesOf(ir, 'turn')[0].status).toBe('running');
    expect(deriveSignals(ir)).toEqual([]);
    expect(ir.meta.coverage).toEqual({ records: 4, unrecognized: 0, sourcesUnread: 0 });
  });

  it('an unreadable root: records 0, sourcesUnread 1, empty graph, run still listed', async () => {
    const ref = await refFor(CU_CLI_BROKEN_ROOT_RUN_ID);
    expect(ref).toBeDefined();
    const { ir } = await parse(ref);
    expect(ir.nodes).toEqual([]);
    expect(ir.meta.coverage).toEqual({ records: 0, unrecognized: 0, sourcesUnread: 1 });
    expect(ir.meta.ext.cursor.rootUnreadable).toBe('root-missing');
    expect(ir.meta.title).toBe('Broken root');
  });

  it('<user_query> unwrapping and the prose timestamp', () => {
    const wrapped = '<timestamp>Sunday, Aug 23, 2026, 1:25 PM (UTC-4)</timestamp>\n<user_query>\nRead math.js.\n</user_query>';
    expect(unwrapUserQuery(wrapped)).toEqual({ prompt: 'Read math.js.', at: '2026-08-23T17:25:00.000Z' });
    expect(unwrapUserQuery('plain prompt')).toEqual({ prompt: 'plain prompt', at: undefined });
    expect(unwrapUserQuery('<timestamp>garbage</timestamp>\nno wrapper')).toEqual({ prompt: 'no wrapper', at: undefined });
    expect(parseProseTimestamp('Thursday, Aug 20, 2026, 2:18 PM (UTC-4)')).toBe('2026-08-20T18:18:00.000Z');
    expect(parseProseTimestamp('Jan 5, 2026, 12:05 AM (UTC+5:30)')).toBe('2026-01-04T18:35:00.000Z');
    expect(parseProseTimestamp('Dec 31, 2025, 12:00 PM (UTC+0)')).toBe('2025-12-31T12:00:00.000Z');
    expect(parseProseTimestamp('2026-08-23T17:25:00Z')).toBeUndefined(); // not the prose shape → absent, never guessed
    expect(parseProseTimestamp('')).toBeUndefined();
  });

  it('CLI files: StrReplace.path and Read.path only', () => {
    expect(cliToolFiles('Read', { path: '/a.js' })).toEqual(['/a.js']);
    expect(cliToolFiles('StrReplace', { path: '/a.js', old_string: 'x' })).toEqual(['/a.js']);
    expect(cliToolFiles('Shell', { command: 'cat /a.js' })).toEqual([]);
    expect(cliToolFiles('Glob', { path: '/a' })).toEqual([]);
  });

  it('the protobuf walker: field 1 in order, non-32-byte entries skipped, bad wire types → null', () => {
    const id1 = Buffer.alloc(32, 1);
    const id2 = Buffer.alloc(32, 2);
    const len = (field, buf) => Buffer.concat([Buffer.from([(field << 3) | 2, buf.length]), buf]);
    const vi = (field, n) => Buffer.from([field << 3, n]);
    const root = Buffer.concat([len(1, id1), len(1, id2), len(5, Buffer.from('state')), vi(10, 1), len(1, Buffer.from('short'))]);
    expect(rootMessageIds(root)).toEqual(['01'.repeat(32), '02'.repeat(32)]);
    // A 64-bit field and a 32-bit field are skipped by size.
    const withFixed = Buffer.concat([Buffer.from([(3 << 3) | 1, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([(4 << 3) | 5, 0, 0, 0, 0]), len(1, id1)]);
    expect(rootMessageIds(withFixed)).toEqual(['01'.repeat(32)]);
    // A group wire type (3) is not a shape this reader knows.
    expect(rootMessageIds(Buffer.from([(1 << 3) | 3]))).toBeNull();
    // A length past the end is a truncated root.
    expect(rootMessageIds(Buffer.from([(1 << 3) | 2, 50, 1, 2]))).toBeNull();
    expect(rootMessageIds(Buffer.alloc(0))).toBeNull();
    expect(rootMessageIds('not a buffer')).toBeNull();
    // A JSON message blob vs. anything else.
    expect(decodeMessageBlob(Buffer.from('{"role":"user"}')).json).toEqual({ role: 'user' });
    expect(decodeMessageBlob(Buffer.from('{broken')).miss).toBe('invalid');
    expect(decodeMessageBlob(Buffer.from([0x0a, 0x20])).miss).toBe('binary');
    expect(decodeMessageBlob(Buffer.from('[1]')).miss).toBe('binary');
  });

  it('readMeta0 decodes the hex JSON and DROPS blobEncryptionKey', async () => {
    const ref = await refFor(CU_CLI_REV3_RUN_ID);
    const { openDb } = await import('../src/adapters/cursor/db.js');
    const { db, close } = await openDb(ref.dbPath);
    try {
      const m = readMeta0(db);
      expect(m.agentId).toBe('2acba01b-0000-4000-8000-000000000003');
      expect(m.blobEncryptionKey).toBeUndefined();
      expect('blobEncryptionKey' in m).toBe(false);
      expect(JSON.stringify(m)).not.toContain(CU_CLI_BLOB_KEY);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy: the never-emit rule and key-name redaction
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor privacy', () => {
  it('no fixture IR or details contains either encryption-key value (string walk over every run)', async () => {
    for (const ref of await detect(CURSOR_FIXTURE_ROOTS)) {
      const { ir, details } = await parse(ref, { collectDetails: true });
      const text = allStrings(ir, details).join('\n') + JSON.stringify(ref);
      expect(text, ref.runId).not.toContain(CU_IDE_BLOB_KEY);
      expect(text, ref.runId).not.toContain(CU_IDE_SUMMARY_KEY);
      expect(text, ref.runId).not.toContain(CU_CLI_BLOB_KEY);
      expect(text, ref.runId).not.toContain('blobEncryptionKey');
      expect(text, ref.runId).not.toContain('speculativeSummarizationEncryptionKey');
    }
  });

  it('the secrets run carries one pattern in each of the five outgoing places, and export blocks on it', async () => {
    const { ir, details } = await irFor(CU_SECRETS_RUN_ID, { collectDetails: true });
    const turn = nodesOf(ir, 'turn')[0];
    const tool = nodesOf(ir, 'tool')[0];
    const hits = (text) => scanText(text).map((h) => h.kind);
    expect(hits(turn.label)).toEqual(['github-token']); // 1. the prompt, as a label
    expect(hits(details.get(tool.id).calls[0].input)).toContain('aws-secret-key'); // 2. tool input
    expect(hits(details.get(tool.id).calls[0].output)).toEqual(['slack-token']); // 3. tool output
    expect(hits(details.get(turn.id).responseText)).toEqual(['anthropic-key']); // 4. assistant text
    expect(hits(tool.label)).toEqual(['aws-access-key']); // 5. a NODE LABEL
    // …and the 64-hex blob id beside the Slack token is NOT a finding.
    expect(hits('blob d5f4f380a5d1c0ffee00000000000000000000000000000000000000000000aa')).toEqual([]);

    const { buildBundle } = await import('../src/bundle.js');
    const saved = { ide: process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE, cli: process.env.RUNGRAPH_CURSOR_CLI_HOME };
    try {
      process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE = CURSOR_IDE_FIXTURE_ROOT;
      process.env.RUNGRAPH_CURSOR_CLI_HOME = CURSOR_CLI_FIXTURE_ROOT;
      const blocked = await buildBundle([CU_SECRETS_RUN_ID], { sharedBy: 'test' });
      expect(blocked.blocked).toBe(true);
      expect(new Set(blocked.findings.map((f) => f.kind))).toEqual(
        new Set(['github-token', 'aws-secret-key', 'slack-token', 'anthropic-key', 'aws-access-key']),
      );
      const redacted = await buildBundle([CU_SECRETS_RUN_ID], { sharedBy: 'test', redaction: 'redact-secrets' });
      expect(redacted.blocked).toBe(false);
      expect(JSON.stringify(redacted.envelope)).toContain('[REDACTED:aws-access-key]');
      expect(JSON.stringify(redacted.envelope)).toContain('d5f4f380a5d1c0ffee'); // the id survives
    } finally {
      for (const [k, v] of [['RUNGRAPH_CURSOR_GLOBAL_STORAGE', saved.ide], ['RUNGRAPH_CURSOR_CLI_HOME', saved.cli]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('key-name redaction: redactTree redacts both key fields by POSITION and leaves a 64-hex id alone', () => {
    expect([...SECRET_KEY_NAMES]).toEqual(['blobEncryptionKey', 'speculativeSummarizationEncryptionKey']);
    const raw = {
      composer: { blobEncryptionKey: CU_IDE_BLOB_KEY, speculativeSummarizationEncryptionKey: CU_IDE_SUMMARY_KEY, name: 'ok' },
      meta0: { blobEncryptionKey: CU_CLI_BLOB_KEY, latestRootBlobId: 'ab'.repeat(32) },
      nested: [{ blobEncryptionKey: '' }, { notAKey: 'fe52'.repeat(16) }],
    };
    // The value-shape scanner sees nothing here — which is the hole.
    expect(scanText(JSON.stringify(raw))).toEqual([]);
    const n = redactTree(raw);
    expect(n).toBe(3);
    expect(raw.composer.blobEncryptionKey).toBe('[REDACTED:key-name]');
    expect(raw.composer.speculativeSummarizationEncryptionKey).toBe('[REDACTED:key-name]');
    expect(raw.meta0.blobEncryptionKey).toBe('[REDACTED:key-name]');
    expect(raw.meta0.latestRootBlobId).toBe('ab'.repeat(32));
    expect(raw.nested[0].blobEncryptionKey).toBe('');
    expect(raw.nested[1].notAKey).toBe('fe52'.repeat(16));
    expect(raw.composer.name).toBe('ok');
  });

  it('export: a raw record with a key field is a finding by name, so it BLOCKS', async () => {
    const { scanEnvelope } = await import('../src/bundle.js');
    const findings = scanEnvelope({ runs: [{ ir: { meta: { ext: { cursor: { blobEncryptionKey: CU_CLI_BLOB_KEY } } } } }] });
    expect(findings.map((f) => f.kind)).toEqual(['key-name']);
    expect(scanEnvelope({ runs: [{ ir: { meta: { ext: { cursor: { blobEncryptionKey: '' } } } } }] })).toEqual([]);
  });

  it('the adapter never names the list-caches Cursor rebuilds', async () => {
    const files = [];
    const walk = async (dir) => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else files.push(p);
      }
    };
    await walk(ADAPTER_DIR);
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      // The names appear ONLY in comments that say "never queried" — strip
      // comments and assert on code.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code.includes('composerHeaders'), `${f} queries composerHeaders`).toBe(false);
      expect(code.includes('conversation-search'), `${f} queries conversation-search`).toBe(false);
      expect(code.includes('workspaceStorage'), `${f} joins workspaceStorage`).toBe(false);
    }
    // …and the fixture has that table POPULATED, so "never queried" is distinguishable from "nothing to read".
    const { DatabaseSync } = requireBuiltin('node:sqlite');
    const db = new DatabaseSync(join(CURSOR_IDE_FIXTURE_ROOT, 'state.vscdb'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS c FROM composerHeaders').get().c).toBeGreaterThan(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Guards that need a store shaped on purpose (temp DBs, never the fixture)
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor guards (synthetic stores)', () => {
  /** A throwaway IDE store; `records` is [key, value]. Returns the root dir (caller rm's it). */
  async function ideStore(records) {
    const dir = await mkdtemp(join(tmpdir(), 'rg-cu-guard-'));
    const { DatabaseSync } = requireBuiltin('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state.vscdb'));
    db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const [k, v] of records) put.run(k, v == null || typeof v === 'string' ? v : JSON.stringify(v));
    db.close();
    return dir;
  }
  const composerOf = (id, over = {}) => ({
    _v: 17, composerId: id, status: 'completed', createdAt: 1785592800000, lastUpdatedAt: 1785592900000,
    trackedGitRepos: [{ repoPath: '/home/dev/acme', branches: [] }],
    fullConversationHeadersOnly: [{ bubbleId: `${id}-h`, type: 1, createdAt: '2026-08-01T14:00:00.000Z', grouping: { isRenderable: true } }],
    ...over,
  });
  const bubbleOf = (id, text) => [`bubbleId:${id}:${id}-h`, { _v: 3, type: 1, bubbleId: `${id}-h`, text }];

  it('a value over the 2 MB guard is sourcesUnread, never loaded; an oversized or invalid COMPOSER is warned about', async () => {
    const big = 'x'.repeat(2_000_001);
    const dir = await ideStore([
      ['composerData:r1', composerOf('r1', { fullConversationHeadersOnly: [{ bubbleId: 'r1-h', type: 1 }, { bubbleId: 'r1-big', type: 2 }] })],
      bubbleOf('r1', 'hello'),
      ['bubbleId:r1:r1-big', JSON.stringify({ _v: 3, type: 2, bubbleId: 'r1-big', text: big })],
      ['composerData:r2', JSON.stringify({ ...composerOf('r2'), pad: big })],
      ['composerData:r3', '{not json'],
      ['composerData:r4', null],
    ]);
    try {
      const refs = await detect([dir]);
      expect(refs.map((r) => r.composerId)).toEqual(['r1']);
      // One warning naming both unreadable records; the NULL one (Cursor's own
      // deletion marker) is deliberately silent.
      expect(scanWarnings()).toHaveLength(1);
      expect(scanWarnings()[0].reason).toMatch(/2 conversation records could not be read \(1 over the 2 MB value guard, 1 not valid JSON\)/);
      const { ir } = await parse(refs[0]);
      expect(ir.meta.coverage).toEqual({ records: 2, unrecognized: 0, sourcesUnread: 1 });
      expect(classifyCoverage(ir.meta, 0)).toBe('quiet');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a subagent cycle terminates and yields one lane; a child body without composerId keeps its key id', async () => {
    const dir = await ideStore([
      ['composerData:p', composerOf('p', { subComposerIds: ['c', 'nobody'] })],
      bubbleOf('p', 'parent'),
      // c points back at p by BOTH routes — a cycle.
      ['composerData:c', composerOf('c', { subComposerIds: ['p'], subagentInfo: { parentComposerId: 'p' } })],
      bubbleOf('c', 'child'),
      // The body has no composerId at all; the key is what the parent referenced.
      ['composerData:nobody', (() => { const r = composerOf('nobody'); delete r.composerId; return r; })()],
      bubbleOf('nobody', 'anonymous child'),
    ]);
    try {
      const refs = await detect([dir]);
      expect(refs.map((r) => r.composerId)).toEqual(['p']); // c is a subagent, never a root
      const { ir } = await parse(refs[0]);
      expect(nodesOf(ir, 'agent').map((a) => a.agentId)).toEqual(['c', 'nobody']);
      expect(ir.meta.totals.agents).toBe(2);
      expect(ir.meta.coverage.sourcesUnread).toBe(0);
      expect(nodesOf(ir, 'turn').map((t) => t.label)).toEqual(['parent', 'child', 'anonymous child']);
      // The tree fingerprint counts each composer ONCE (the cycle does not
      // double-count) and only composers Cursor's own validity predicate
      // accepts — the body without a composerId is not one, so it is a lane
      // (the key is what the parent referenced) but not a fingerprint input.
      expect(fingerprint(refs[0])).toMatch(/:2$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a child spawned AFTER the ref was built still appears on the next parse (live tail)', async () => {
    const dir = await ideStore([['composerData:p', composerOf('p')], bubbleOf('p', 'parent')]);
    try {
      const ref = (await detect([dir]))[0];
      expect(nodesOf((await parse(ref)).ir, 'agent')).toEqual([]);
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const db = new DatabaseSync(join(dir, 'state.vscdb'));
      const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      put.run('composerData:late', JSON.stringify(composerOf('late', { subagentInfo: { parentComposerId: 'p' } })));
      put.run(...bubbleOf('late', 'late child').map((v, i) => (i === 0 ? v : JSON.stringify(v))));
      db.close();
      // The SAME ref — what watchRun holds — now shows the lane.
      expect(nodesOf((await parse(ref)).ir, 'agent').map((a) => a.agentId)).toEqual(['late']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detect warnings: an unopenable store, and one run present in two roots', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'rg-cu-bad-'));
    const twin = await mkdtemp(join(tmpdir(), 'rg-cu-twin-'));
    try {
      await writeFile(join(bad, 'state.vscdb'), 'this is not a sqlite database at all');
      expect(await detect([bad])).toEqual([]);
      expect(scanWarnings()).toHaveLength(1);
      expect(scanWarnings()[0]).toMatchObject({ adapter: 'cursor' });
      expect(scanWarnings()[0].reason).toContain(join(bad, 'state.vscdb'));
      // Surfaced through scan() too, where list --json and the dashboard read it.
      const out = await scan({ rootDirs: { cursor: [bad] } });
      expect(out.runs).toEqual([]);
      expect(out.warnings).toHaveLength(1);

      const { cp } = await import('node:fs/promises');
      await cp(CURSOR_CLI_FIXTURE_ROOT, twin, { recursive: true });
      const once = await detect([CURSOR_CLI_FIXTURE_ROOT]);
      const twice = await detect([CURSOR_CLI_FIXTURE_ROOT, twin]);
      expect(twice).toHaveLength(once.length);
      expect(scanWarnings()).toHaveLength(once.length);
      for (const w of scanWarnings()) expect(w.reason).toMatch(/exists in both .* and .*; showing the most recently active copy/);
    } finally {
      await rm(bad, { recursive: true, force: true });
      await rm(twin, { recursive: true, force: true });
    }
  });

  it('CLI: a blob id repeated in the root list never yields two nodes with one id', async () => {
    const { createHash } = requireBuiltin('node:crypto');
    const { DatabaseSync } = requireBuiltin('node:sqlite');
    const dir = await mkdtemp(join(tmpdir(), 'rg-cu-dup-'));
    try {
      const chat = join(dir, 'chats', 'ws', 'dd000000-0000-4000-8000-000000000001');
      await mkdir(chat, { recursive: true });
      await writeFile(join(chat, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation: true, updatedAtMs: 2, cwd: '/home/dev/acme' }));
      const db = new DatabaseSync(join(chat, 'store.db'));
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      const ins = db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
      const blob = (o) => { const b = Buffer.from(JSON.stringify(o)); const id = createHash('sha256').update(b).digest('hex'); ins.run(id, b); return id; };
      const u = blob({ role: 'user', content: [{ type: 'text', text: '<user_query>again</user_query>' }] });
      const a = blob({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], id: '1' });
      const root = Buffer.concat([u, a, u, a].map((h) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(h, 'hex')])));
      const rootId = createHash('sha256').update(root).digest('hex');
      ins.run(rootId, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({ agentId: 'dd000000-0000-4000-8000-000000000001', latestRootBlobId: rootId, name: 'New Agent', mode: 'default', isRunEverything: false, createdAt: 1, blobEncryptionKey: 'ab'.repeat(32) })).toString('hex'));
      db.close();
      const ref = (await detect([dir]))[0];
      const { ir } = await parse(ref);
      expect(nodesOf(ir, 'turn')).toHaveLength(2);
      expect(new Set(ir.nodes.map((n) => n.id)).size).toBe(ir.nodes.length);
      expect(ir.edges).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Performance budget (§4)
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor performance budget', () => {
  it('detect() stays under 1 s against a synthesised 10 000-composer store', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-big-'));
    try {
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const db = new DatabaseSync(join(tmp, 'state.vscdb'));
      db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
      const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      db.exec('BEGIN');
      for (let i = 0; i < 10_000; i++) {
        const id = `b1b1b1b1-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const h = `h-${i}`;
        put.run(
          `composerData:${id}`,
          JSON.stringify({
            _v: 17, composerId: id, status: 'completed', createdAt: 1785592800000 + i * 1000, lastUpdatedAt: 1785592900000 + i * 1000,
            // Every THIRD composer is unnamed, so the title fallback's point lookup is exercised at scale.
            ...(i % 3 === 0 ? {} : { name: `Chat ${i}` }),
            trackedGitRepos: [{ repoPath: '/home/dev/acme', branches: [] }],
            subComposerIds: [], isDraft: false,
            fullConversationHeadersOnly: [
              { bubbleId: h, type: 1, createdAt: '2026-08-01T14:00:00.000Z', grouping: { isRenderable: true, hasText: true } },
              { bubbleId: `${h}-a`, type: 2, createdAt: '2026-08-01T14:00:05.000Z', grouping: { isRenderable: true, hasText: true } },
            ],
          }),
        );
        put.run(`bubbleId:${id}:${h}`, JSON.stringify({ _v: 3, type: 1, bubbleId: h, text: `prompt number ${i}` }));
        put.run(`bubbleId:${id}:${h}-a`, JSON.stringify({ _v: 3, type: 2, bubbleId: `${h}-a`, text: 'answer' }));
      }
      db.exec('COMMIT');
      db.close();
      const t0 = performance.now();
      const refs = await detect([tmp]);
      const ms = performance.now() - t0;
      expect(refs).toHaveLength(10_000);
      expect(refs.filter((r) => r.title.startsWith('prompt number')).length).toBeGreaterThan(3000);
      expect(ms, `detect() took ${ms.toFixed(0)}ms`).toBeLessThan(1000);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// File-layout hooks: fingerprint, watchTargets, resume
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor layout hooks', () => {
  it('watchTargets: the directory is the load-bearing target, the files are belt and braces', async () => {
    for (const runId of [CU_CLEAN_RUN_ID, CU_CLI_REV3_RUN_ID]) {
      const ref = await refFor(runId);
      const targets = watchTargets(ref);
      expect(targets[0]).toEqual({ path: dirname(ref.dbPath), recursive: false });
      expect(targets.map((t) => t.path)).toContain(ref.dbPath);
      expect(targets.map((t) => t.path)).toContain(ref.dbPath + '-wal');
    }
  });

  it('fingerprint: per run, from the records, never from file mtime', async () => {
    const ide = await refFor(CU_CLEAN_RUN_ID);
    expect(fingerprint(ide)).toBe(`${ide.treeUpdatedAt}:7`);
    const cli = await refFor(CU_CLI_REV3_RUN_ID);
    expect(fingerprint(cli)).toBe(`${cli.updatedAtMs}:${cli.blobCount}`);
    expect(cli.blobCount).toBeGreaterThan(16); // messages + roots + spine
  });

  it('resume: CLI runs offer `cursor-agent --resume <id>` with no fork; IDE runs offer nothing', async () => {
    const cli = await refFor(CU_CLI_REV3_RUN_ID);
    const info = resumeInfo(cli);
    expect(info.argv).toEqual(['cursor-agent', '--resume', '2acba01b-0000-4000-8000-000000000003']);
    expect(info.forkArgv).toBeUndefined();
    // /home/dev/acme does not exist here, so no `cd` prefix and no cwd.
    expect(info.cwd).toBeNull();
    expect(info.copyCommand).toBe('cursor-agent --resume 2acba01b-0000-4000-8000-000000000003');
    const entry = toIndexEntry(cli);
    expect(entry.resume.copyCommand).toBe(info.copyCommand);
    expect(entry.resume.forkCopyCommand).toBeUndefined();
    // The agentId matches the CLI's own --resume validation regex.
    expect(cli.agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const ide = await refFor(CU_CLEAN_RUN_ID);
    expect(resumeInfo(ide)).toBeNull();
    expect(toIndexEntry(ide).resume).toBeUndefined();
  });

  it('the adapter is registered and exposes the contract', () => {
    const cursor = ADAPTERS.find((a) => a.name === 'cursor');
    expect(cursor).toBeDefined();
    for (const fn of ['detect', 'parse', 'scanWarnings', 'fingerprint', 'watchTargets', 'resumeInfo', 'matchesProject']) {
      expect(typeof cursor[fn], fn).toBe('function');
    }
    // The cursor runs sort into the scan index by modifiedAt like everyone else.
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('nope')).toBeUndefined();
    expect(parseJson(Buffer.from('{"b":2}'))).toEqual({ b: 2 });
  });
});

// ---------------------------------------------------------------------------
// The loop: the MCP client entry (§9)
// ---------------------------------------------------------------------------

describe('cursor MCP client entry', () => {
  const launch = { command: 'npx', args: ['-y', 'rungraph', 'mcp'], via: 'npx-cache' };

  it('is the paste tier, with the vendor reason, a JSON block and the IDE deeplink', () => {
    const c = clientByName('cursor');
    expect(c).toBeDefined();
    expect(c.adapter).toBe('cursor');
    expect(c.tier).toBe('paste');
    expect(c.bin).toBe('cursor-agent');
    expect(c.pasteReason).toContain('no `add`');
    const block = c.configBlock(launch);
    expect(block.format).toBe('json');
    expect(block.value).toEqual({ mcpServers: { rungraph: { command: 'npx', args: ['-y', 'rungraph', 'mcp'] } } });
    expect(block.text).toContain('"mcpServers"');
    expect(c.configPath()).toMatch(/mcp\.json$/);
    const link = c.deeplink(launch);
    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=rungraph&config=')).toBe(true);
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(link.split('config=')[1]), 'base64').toString('utf8'));
    expect(decoded).toEqual({ command: 'npx', args: ['-y', 'rungraph', 'mcp'] });
    expect(c.instructionsFile).toBe('AGENTS.md');
    expect(CLIENTS.map((x) => x.name)).toContain('cursor');
  });

  it('configPath is ~/.cursor/mcp.json — the file BOTH surfaces read — whatever XDG says', () => {
    const c = clientByName('cursor');
    const saved = [process.env.CURSOR_CONFIG_DIR, process.env.XDG_CONFIG_HOME];
    try {
      delete process.env.CURSOR_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      expect(c.configPath()).toBe(join(homedir(), '.cursor', 'mcp.json'));
      // The CLI's own config-dir resolution honours these; the IDE does not
      // read a file there, so the printed path must not follow them.
      process.env.XDG_CONFIG_HOME = '/x/xdg';
      process.env.CURSOR_CONFIG_DIR = '/x/cfg';
      expect(c.configPath()).toBe(join(homedir(), '.cursor', 'mcp.json'));
    } finally {
      for (const [i, k] of ['CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME'].entries()) {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      }
    }
  });

  it('reads `absent` off the verbatim empty-list line, `ok` off a line naming rungraph, `broken` off a disabled one', () => {
    const c = clientByName('cursor');
    expect(c.isRegistered('No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)\n')).toMatchObject({ ok: false, state: 'absent' });
    expect(c.isRegistered('')).toMatchObject({ ok: false, state: 'absent' });
    expect(c.isRegistered('rungraph: npx -y rungraph mcp\n')).toMatchObject({ ok: true, state: 'ok' });
    expect(c.isRegistered('  ● rungraph  connected\n')).toMatchObject({ ok: true, state: 'ok' });
    expect(c.isRegistered('[2mrungraph[0m  disabled\n')).toMatchObject({ ok: false, state: 'broken' });
    // Precision: a server whose name merely CONTAINS rungraph, or whose args
    // name a rungraph PATH, is not rungraph — that would make --check report
    // the loop usable when it is not.
    expect(c.isRegistered('rungraph-other: x\n')).toMatchObject({ ok: false, state: 'absent' });
    expect(c.isRegistered('filesystem: npx -y @modelcontextprotocol/server-filesystem /Users/x/GitHub/rungraph\n')).toMatchObject({ ok: false, state: 'absent' });
    expect(c.isRegistered('rungraph.backup: x\n')).toMatchObject({ ok: false, state: 'absent' });
  });

  it('the deeplink survives a query parser: base64 is percent-encoded, and a `+` comes back intact', () => {
    const c = clientByName('cursor');
    // A launch whose JSON base64 contains `+` and `=` (a non-ASCII path does it).
    const link = c.deeplink({ command: '/Users/한/.nvm/node', args: ['/Users/한/rungraph/bin/rungraph.js', 'mcp'] });
    const back = new URL(link).searchParams.get('config');
    expect(link.split('config=')[1]).not.toMatch(/[+=]/); // nothing a query parser would mangle
    expect(JSON.parse(Buffer.from(back, 'base64').toString('utf8'))).toEqual({
      command: '/Users/한/.nvm/node',
      args: ['/Users/한/rungraph/bin/rungraph.js', 'mcp'],
    });
  });

  const pasteEnv = (extra = {}) => ({
    ...process.env,
    CLAUDE_CONFIG_DIR: join(tmpdir(), 'rg-cu-never'),
    CODEX_HOME: join(tmpdir(), 'rg-cu-never'),
    HERMES_HOME: join(tmpdir(), 'rg-cu-never'),
    XDG_CONFIG_HOME: join(tmpdir(), 'rg-cu-never'),
    CURSOR_CONFIG_DIR: join(tmpdir(), 'rg-cu-never', 'cursor'),
    RUNGRAPH_CLAUDE_PROJECTS: '',
    RUNGRAPH_CODEX_SESSIONS: '',
    RUNGRAPH_HERMES_HOME: '',
    RUNGRAPH_OPENCODE_HOME: '',
    RUNGRAPH_CURSOR_GLOBAL_STORAGE: '',
    RUNGRAPH_CURSOR_CLI_HOME: '',
    ...extra,
  });

  it('`mcp --install --client cursor` prints the path, the block and the deeplink, writes nothing, exits 0', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-install-'));
    try {
      // HOME is redirected so the printed path (and any write, were there
      // one) lands in the sandbox; the paste path never creates that dir,
      // which is what "writes nothing" asserts below.
      const home = join(tmp, 'home');
      const cfgDir = join(home, '.cursor');
      const { stdout } = await exec('node', [BIN, 'mcp', '--install', '--client', 'cursor'], {
        env: pasteEnv({ HOME: home, RUNGRAPH_STATE_DIR: tmp }),
      });
      expect(stdout).toContain('paste required');
      expect(stdout).toContain(join(cfgDir, 'mcp.json'));
      expect(stdout).toContain('"mcpServers"');
      expect(stdout).toContain('cursor://anysphere.cursor-deeplink/mcp/install?name=rungraph&config=');
      expect(stdout).toContain('AGENTS.md');
      // Writes nothing: the config dir was never created.
      await expect(readdir(cfgDir)).rejects.toThrow();

      const { stdout: json } = await exec('node', [BIN, 'mcp', '--install', '--client', 'cursor', '--json'], {
        env: pasteEnv({ HOME: home, RUNGRAPH_STATE_DIR: tmp }),
      });
      const report = JSON.parse(json);
      expect(report.pasted).toBe(1);
      const c = report.clients[0];
      expect(c).toMatchObject({ client: 'cursor', adapter: 'cursor', tier: 'paste', status: 'pasted', configFormat: 'json', configExists: false });
      expect(c.config).toEqual({ mcpServers: { rungraph: { command: report.launch.command, args: report.launch.args } } });
      expect(c.deeplink).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=rungraph&config=/);
      expect(c.reason).toContain('no `add`');
      expect(c.notes.join(' ')).toContain('vendor fact');
      await expect(readdir(cfgDir)).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!POSIX || !hasNodeSqlite)('`mcp --check --json` with a PATH shim: the verbatim empty line reads as absent', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-check-'));
    try {
      const shims = join(tmp, 'shims');
      await mkdir(shims);
      await writeFile(
        join(shims, 'cursor-agent'),
        '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then\n' +
          '  echo "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)"\n  exit 0\nfi\nexit 1\n',
      );
      await chmod(join(shims, 'cursor-agent'), 0o755);
      const env = pasteEnv({
        RUNGRAPH_CURSOR_GLOBAL_STORAGE: CURSOR_IDE_FIXTURE_ROOT,
        RUNGRAPH_CURSOR_CLI_HOME: CURSOR_CLI_FIXTURE_ROOT,
        RUNGRAPH_STATE_DIR: join(tmp, 'state'),
        RUNGRAPH_PORT_DIR: join(tmp, 'ports'),
        PATH: `${shims}${delimiter}${process.env.PATH}`,
      });
      const r = await exec(process.execPath, [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
      const report = JSON.parse(r.stdout);
      const row = report.checks.find((c) => c.client === 'cursor');
      expect(row).toMatchObject({ ok: false, state: 'absent', advisory: true });
      expect(row.fix).toBe('npx rungraph mcp --install --client cursor');
      expect(report.checks.find((c) => c.name === 'runs on disk').ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The whole CLI, end to end (Node ≥ 22.13)
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor via the CLI', () => {
  const env = {
    ...process.env,
    RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
    RUNGRAPH_CODEX_SESSIONS: '',
    RUNGRAPH_HERMES_HOME: '',
    RUNGRAPH_OPENCODE_HOME: '',
    RUNGRAPH_CURSOR_GLOBAL_STORAGE: CURSOR_IDE_FIXTURE_ROOT,
    RUNGRAPH_CURSOR_CLI_HOME: CURSOR_CLI_FIXTURE_ROOT,
  };

  it('list --json includes both surfaces with correct attribution, and --project scopes them', async () => {
    const { stdout } = await exec(process.execPath, [BIN, 'list', '--json'], { env });
    const data = JSON.parse(stdout);
    const cursor = data.runs.filter((r) => r.adapter === 'cursor');
    expect(cursor.map((r) => r.runId)).toEqual(expect.arrayContaining([CU_CLEAN_RUN_ID, CU_CLI_REV3_RUN_ID, CU_UNSUPPORTED_RUN_ID]));
    expect(cursor.find((r) => r.runId === CU_CLEAN_RUN_ID).project).toBe('/home/dev/acme');
    expect(cursor.find((r) => r.runId === CU_BUCKET_RUN_ID).loose).toBe(true);
    expect(cursor.find((r) => r.runId === CU_CLI_REV3_RUN_ID).resume.copyCommand).toContain('cursor-agent --resume');
    expect(cursor.find((r) => r.runId === CU_CLEAN_RUN_ID).resume).toBeUndefined();
    expect(data.warnings).toBeUndefined();

    const scoped = JSON.parse((await exec(process.execPath, [BIN, 'list', '--json', '--project', '/home/dev/notes'], { env })).stdout);
    expect(scoped.runs.filter((r) => r.adapter === 'cursor').map((r) => r.runId)).toEqual([CU_CROSS_PROJECT_RUN_ID]);
  });

  it('graph --json carries derived signals and coverage for a Cursor run', async () => {
    const { stdout } = await exec(process.execPath, [BIN, 'graph', CU_TROUBLE_RUN_ID, '--json'], { env });
    const ir = JSON.parse(stdout);
    expect(ir.meta.adapter).toBe('cursor');
    expect(ir.signals.map((s) => s.kind)).toContain('intervention');
    expect(ir.signals.map((s) => s.kind)).not.toContain('unresolved-error');
    expect(ir.meta.coverage).toEqual({ records: 39, unrecognized: 0, sourcesUnread: 0 });
    const old = JSON.parse((await exec(process.execPath, [BIN, 'graph', CU_UNSUPPORTED_RUN_ID, '--json'], { env })).stdout);
    expect(old.meta.coverage.unrecognized).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Graceful degrade on Node 20 — deliberately NOT skipped
// ---------------------------------------------------------------------------

describe('cursor graceful degrade (adapter self-disables)', () => {
  it('list --json: one warning, zero Cursor runs, exit 0, one stderr line', async () => {
    const nodeArgs = hasNodeSqlite ? ['--no-experimental-sqlite'] : [];
    const { stdout, stderr } = await exec(process.execPath, [...nodeArgs, BIN, 'list', '--json'], {
      env: {
        ...process.env,
        RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
        RUNGRAPH_CODEX_SESSIONS: '',
        RUNGRAPH_HERMES_HOME: '',
        RUNGRAPH_OPENCODE_HOME: '',
        RUNGRAPH_CURSOR_GLOBAL_STORAGE: CURSOR_IDE_FIXTURE_ROOT,
        RUNGRAPH_CURSOR_CLI_HOME: CURSOR_CLI_FIXTURE_ROOT,
      },
    });
    const data = JSON.parse(stdout);
    expect(data.runs.some((r) => r.adapter === 'cursor')).toBe(false);
    expect(data.runs.length).toBeGreaterThan(0);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0].adapter).toBe('cursor');
    expect(data.warnings[0].reason).toContain('node:sqlite');
    expect(stderr).toContain('Cursor runs need Node 22.13+');
  });

  it('…and says NOTHING at all when there is no Cursor install to skip', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-none-'));
    try {
      const nodeArgs = hasNodeSqlite ? ['--no-experimental-sqlite'] : [];
      const { stdout, stderr } = await exec(process.execPath, [...nodeArgs, BIN, 'list', '--json'], {
        env: {
          ...process.env,
          RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
          RUNGRAPH_CODEX_SESSIONS: '',
          RUNGRAPH_HERMES_HOME: '',
          RUNGRAPH_OPENCODE_HOME: '',
          RUNGRAPH_CURSOR_GLOBAL_STORAGE: tmp,
          RUNGRAPH_CURSOR_CLI_HOME: join(tmp, 'cli'),
        },
      });
      expect(JSON.parse(stdout).warnings).toBeUndefined();
      expect(stderr).not.toContain('Cursor runs need');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live tail across the CLI's WAL delete/recreate (acceptance criterion 9)
// ---------------------------------------------------------------------------

describe.skipIf(!hasNodeSqlite)('cursor live tail (CLI store, WAL lifecycle)', () => {
  it('a watched CLI run re-parses after a write, after the WAL is checkpointed away, and after it is recreated', async () => {
    const { watchRun } = await import('../src/watcher.js');
    const cursor = ADAPTERS.find((a) => a.name === 'cursor');
    const tmp = await mkdtemp(join(tmpdir(), 'rg-cu-tail-'));
    let handle;
    try {
      // A private copy of the in-flight chat, as a CLI root shape: <root>/chats/<ws>/<id>/.
      const src = join(CURSOR_CLI_FIXTURE_ROOT, 'chats');
      const [ws] = (await readdir(src)).filter((d) => !d.includes('.'));
      const wsDir = (await readdir(join(src, ws))).includes('f11ef11e-0000-4000-8000-000000000004')
        ? ws
        : (await readdir(src)).find((d) => d !== ws);
      const chat = join(tmp, 'chats', wsDir, 'f11ef11e-0000-4000-8000-000000000004');
      await mkdir(chat, { recursive: true });
      for (const f of ['meta.json', 'store.db']) await copyFile(join(src, wsDir, 'f11ef11e-0000-4000-8000-000000000004', f), join(chat, f));

      const ref = (await detect([tmp])).find((r) => r.runId === CU_CLI_INFLIGHT_RUN_ID);
      expect(ref).toBeDefined();
      const graphs = [];
      let resolveNext = null;
      const next = () => new Promise((res) => (resolveNext = res));
      handle = watchRun(ref, cursor, {
        debounceMs: 50,
        onGraph: (ir) => {
          graphs.push(ir);
          resolveNext?.(ir);
        },
        onError: (e) => {
          throw e;
        },
      });
      const first = await next();
      expect(nodesOf(first, 'tool')[0].status).toBe('running');

      // 1. The CLI flushes a step: WAL mode on, new blobs, new root, meta.json rewritten.
      const { DatabaseSync } = requireBuiltin('node:sqlite');
      const writer = new DatabaseSync(join(chat, 'store.db'));
      writer.exec('PRAGMA journal_mode = WAL');
      const appendResult = (db, text) => {
        const m0 = JSON.parse(Buffer.from(db.prepare("SELECT value FROM meta WHERE key = '0'").get().value, 'hex').toString('utf8'));
        const root = Buffer.from(db.prepare('SELECT data FROM blobs WHERE id = ?').get(m0.latestRootBlobId).data);
        const ids = rootMessageIds(root);
        // The open call's id, read off the last assistant message in the root.
        const last = JSON.parse(Buffer.from(db.prepare('SELECT data FROM blobs WHERE id = ?').get(ids.at(-1)).data).toString('utf8'));
        const call = last.content.find((b) => b.type === 'tool-call');
        const msg = Buffer.from(
          JSON.stringify({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, result: text }],
            id: call.toolCallId,
            providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { content: text } }, isError: false } } },
          }),
        );
        const { createHash } = requireBuiltin('node:crypto');
        const id = createHash('sha256').update(msg).digest('hex');
        db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)').run(id, msg);
        const newRoot = Buffer.concat([...ids, id].map((h) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(h, 'hex')])));
        const rootId = createHash('sha256').update(newRoot).digest('hex');
        db.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)').run(rootId, newRoot);
        m0.latestRootBlobId = rootId;
        db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(m0), 'utf8').toString('hex'));
      };
      const bump = async () => {
        const meta = JSON.parse(await readFile(join(chat, 'meta.json'), 'utf8'));
        meta.updatedAtMs += 1000;
        await writeFile(join(chat, 'meta.json'), JSON.stringify(meta));
      };
      let pending = next();
      appendResult(writer, 'export function add(a, b) { return a + b; }');
      await bump();
      const second = await pending;
      expect(nodesOf(second, 'tool')[0].status).toBe('completed');
      expect(nodesOf(second, 'turn')[0].status).toBe('completed');

      // 2. Session end: checkpoint and DELETE the -wal/-shm (what cursor-agent does on close).
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      writer.close();
      await rm(join(chat, 'store.db-wal'), { force: true });
      await rm(join(chat, 'store.db-shm'), { force: true });

      // 3. `--resume`: a NEW connection recreates the WAL with a new inode and writes again.
      const writer2 = new DatabaseSync(join(chat, 'store.db'));
      writer2.exec('PRAGMA journal_mode = WAL');
      const before = graphs.length;
      pending = next();
      // A second assistant step with a new open call, then its result: the
      // graph must grow by a tool node after the WAL came back.
      const { createHash } = requireBuiltin('node:crypto');
      const m0 = JSON.parse(Buffer.from(writer2.prepare("SELECT value FROM meta WHERE key = '0'").get().value, 'hex').toString('utf8'));
      const ids = rootMessageIds(Buffer.from(writer2.prepare('SELECT data FROM blobs WHERE id = ?').get(m0.latestRootBlobId).data));
      const step = Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_resumed', toolName: 'Shell', args: { command: 'ls', description: 'List' } }], id: '1' }));
      const stepId = createHash('sha256').update(step).digest('hex');
      writer2.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)').run(stepId, step);
      const root2 = Buffer.concat([...ids, stepId].map((h) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(h, 'hex')])));
      const root2Id = createHash('sha256').update(root2).digest('hex');
      writer2.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)').run(root2Id, root2);
      m0.latestRootBlobId = root2Id;
      writer2.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from(JSON.stringify(m0), 'utf8').toString('hex'));
      await bump();
      const third = await pending;
      writer2.close();
      expect(graphs.length).toBeGreaterThan(before);
      const tools = nodesOf(third, 'tool');
      expect(tools).toHaveLength(2);
      expect(tools[1].label).toBe('Shell · List');
      expect(tools[1].status).toBe('running');
    } finally {
      handle?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
