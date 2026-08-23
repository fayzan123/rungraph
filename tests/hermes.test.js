import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, parse, scanWarnings, resumeInfo, fingerprint, watchTargets } from '../src/adapters/hermes/index.js';
import { scan } from '../src/scanner.js';
import { deriveSignals } from '../src/signals.js';
import { matchNodes } from '../src/find.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  HERMES_FIXTURE_ROOT,
  HERMES_CLEAN_RUN_ID,
  HERMES_TROUBLE_RUN_ID,
  HERMES_DELEG_RUN_ID,
  HERMES_CHILD_A_ID,
  HERMES_CHILD_B_ID,
  HERMES_EMPTY_RUN_ID,
  HERMES_REPO_RUN_ID,
  HERMES_GATEWAY_RUN_ID,
  HERMES_LEGACY_RUN_ID,
} from './helpers.js';

// The whole file rides on node:sqlite: the Node 20 CI leg skips it (the
// adapter self-disables there — covered by the warnings tests other suites
// can't run), the Node 22 leg runs it. Probed with require, not import —
// vite-node mangles a literal `import('node:sqlite')` (see db.js).
const hasNodeSqlite = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => pinFixtureMtimes());

const refFor = async (runId) => {
  const refs = await detect([HERMES_FIXTURE_ROOT]);
  return refs.find((r) => r.runId === runId);
};

describe.skipIf(!hasNodeSqlite)('hermes detect', () => {
  it('indexes sessions across profile DBs with the three-tier project rule', async () => {
    const refs = await detect([HERMES_FIXTURE_ROOT]);
    const index = refs.map(({ runId, kind, title, project, projectFromCwd, source, profile, startedAt, modifiedAt, sizeBytes }) => ({
      runId,
      kind,
      title,
      project,
      projectFromCwd,
      source,
      profile,
      startedAt,
      modifiedAt,
      sizeBytes,
    }));
    expect(index).toMatchSnapshot();
    expect(scanWarnings()).toEqual([]);
  });

  it('subagent sessions are NOT independent runs — they live inside their parent', async () => {
    const refs = await detect([HERMES_FIXTURE_ROOT]);
    expect(refs.some((r) => r.runId.includes(HERMES_CHILD_A_ID))).toBe(false);
    expect(refs.some((r) => r.runId.includes(HERMES_CHILD_B_ID))).toBe(false);
  });

  it('hidden sessions are skipped; archived ones are shown and marked', async () => {
    const refs = await detect([HERMES_FIXTURE_ROOT]);
    expect(refs.some((r) => r.title === 'A hidden task')).toBe(false);
    const archived = refs.find((r) => r.title === 'An archived task');
    expect(archived).toBeDefined();
    const { ir } = await parse(archived);
    expect(ir.meta.ext.hermes.archived).toBe(true);
  });

  it('untitled sessions with no messages at all fall back to the raw id', async () => {
    const ref = await refFor(HERMES_EMPTY_RUN_ID);
    expect(ref.title).toBe(HERMES_EMPTY_RUN_ID.slice('hermes:'.length));
  });

  it('a repo-rooted run groups with the other adapters\' project view', async () => {
    const ref = await refFor(HERMES_REPO_RUN_ID);
    expect(ref.project).toBe('/home/dev/acme');
    expect(ref.projectFromCwd).toBe(true);
  });

  it('a deliberate existing cwd (tier 2) becomes the project', async () => {
    // The fixture corpus can't carry this one: tier 2 requires a cwd that
    // EXISTS on the test machine, and a committed DB can't name one
    // deterministically. Built here instead.
    const tmp = await mkdtemp(join(tmpdir(), 'rg-hermes-cwd-'));
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const db = new DatabaseSync(join(tmp, 'state.db'));
      db.exec(
        'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, ended_at REAL, cwd TEXT, hidden INTEGER DEFAULT 0, message_count INTEGER DEFAULT 0)',
      );
      db.prepare('INSERT INTO sessions (id, source, title, started_at, ended_at, cwd) VALUES (?,?,?,?,?,?)').run(
        '20260801_140000_c3d001',
        'cli',
        'A run started with --in',
        1754050000,
        1754050100,
        tmp,
      );
      db.close();
      const refs = await detect([tmp]);
      expect(refs).toHaveLength(1);
      expect(refs[0].project).toBe(tmp);
      expect(refs[0].projectFromCwd).toBe(true);
      expect(refs[0].projectExists).toBe(true);
      // …and an existing cwd earns the cd-prefixed copy command.
      expect(resumeInfo(refs[0]).copyCommand).toBe(`cd ${tmp} && hermes --resume 20260801_140000_c3d001`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('the same session id in two profile DBs dedupes with a warning', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-hermes-dupe-'));
    try {
      await mkdir(join(tmp, 'profiles', 'copy'), { recursive: true });
      await copyFile(join(HERMES_FIXTURE_ROOT, 'state.db'), join(tmp, 'state.db'));
      await copyFile(join(HERMES_FIXTURE_ROOT, 'state.db'), join(tmp, 'profiles', 'copy', 'state.db'));
      const refs = await detect([tmp]);
      const warnings = scanWarnings(); // captured now — the next detect() resets it
      const mainOnly = await detect([HERMES_FIXTURE_ROOT]);
      const mainCount = mainOnly.filter((r) => r.profile === 'default').length;
      expect(refs).toHaveLength(mainCount); // every duplicate collapsed
      expect(warnings.length).toBe(mainCount);
      expect(warnings[0].reason).toContain('exists in both');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('an unreadable DB degrades to a scan warning, never a crash', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-hermes-bad-'));
    try {
      await writeFile(join(tmp, 'state.db'), 'this is not a sqlite database at all');
      const refs = await detect([tmp]);
      expect(refs).toEqual([]);
      expect(scanWarnings()).toHaveLength(1);
      expect(scanWarnings()[0].adapter).toBe('hermes');
      // …and the same fact rides the scan index for agents.
      const out = await scan({ rootDirs: { hermes: [tmp] } });
      expect(out.warnings).toHaveLength(1);
      expect(out.runs).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasNodeSqlite)('hermes parse', () => {
  it('clean-run IR matches the snapshot', async () => {
    const { ir } = await parse(await refFor(HERMES_CLEAN_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  it('trouble-run IR matches the snapshot', async () => {
    const { ir } = await parse(await refFor(HERMES_TROUBLE_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  it('delegation-run IR matches the snapshot', async () => {
    const { ir } = await parse(await refFor(HERMES_DELEG_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  // The Hermes precision guard, same role as the Claude and Codex clean runs.
  it('the hermes clean run derives zero signals', async () => {
    const { ir } = await parse(await refFor(HERMES_CLEAN_RUN_ID));
    expect(ir.nodes.length).toBeGreaterThan(3);
    expect(deriveSignals(ir)).toEqual([]);
  });

  it('the trouble run derives one of each intervention-adjacent signal', async () => {
    const { ir } = await parse(await refFor(HERMES_TROUBLE_RUN_ID));
    const signals = deriveSignals(ir);
    const kinds = signals.map((s) => `${s.kind}:${s.label}`);
    expect(kinds).toContain('retry-storm:3 failed terminal calls');
    expect(kinds).toContain('unresolved-error:unresolved patch error');
    expect(kinds).toContain('intervention:1 denial');
    expect(kinds).toContain('intervention:1 answered question');
    // The denied terminal group is the last terminal in the lane — a person
    // said no, which must NOT read as an unresolved tool failure.
    expect(kinds.some((k) => k.includes('unresolved terminal'))).toBe(false);
  });

  it('parse is deterministic: two parses yield byte-identical IR', async () => {
    const ref = await refFor(HERMES_DELEG_RUN_ID);
    const a = await parse(ref, { collectDetails: true });
    const b = await parse(ref, { collectDetails: true });
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
  });

  it('holds graph invariants across the whole fixture corpus', async () => {
    for (const ref of await detect([HERMES_FIXTURE_ROOT])) {
      const { ir } = await parse(ref);
      const ids = new Set(ir.nodes.map((n) => n.id));
      expect(ids.size).toBe(ir.nodes.length);
      const groupIds = new Set(ir.groups.map((g) => g.id));
      for (const e of ir.edges) {
        expect(ids.has(e.from), `edge from ${e.from}`).toBe(true);
        expect(ids.has(e.to), `edge to ${e.to}`).toBe(true);
      }
      for (const n of ir.nodes) {
        if (n.group) expect(groupIds.has(n.group), `group ${n.group}`).toBe(true);
      }
      expect(ir.irVersion).toBe(1);
    }
  });

  it('denials come from Hermes\'s own approval strings, and count against the group', async () => {
    const { ir, details } = await parse(await refFor(HERMES_TROUBLE_RUN_ID), { collectDetails: true });
    const denial = ir.nodes.find((n) => n.interventionKind === 'denial');
    expect(denial.label).toBe('denied terminal');
    expect(details.get(denial.id).answer).toContain('BLOCKED: Action denied by user');
    // The denied call sits in the tool group right before the human node —
    // that adjacency is what signals.js uses to excuse the "error".
    const before = ir.edges.find((e) => e.kind === 'sequence' && e.to === denial.id);
    const group = ir.nodes.find((n) => n.id === before.from);
    expect(group.kind).toBe('tool');
    expect(group.errorCount).toBe(1);
  });

  it('a clarify exchange is a human answer node, never a tool node', async () => {
    const { ir, details } = await parse(await refFor(HERMES_TROUBLE_RUN_ID), { collectDetails: true });
    const answer = ir.nodes.find((n) => n.interventionKind === 'answer');
    expect(answer.label).toBe('answered: GitHub Actions');
    const d = details.get(answer.id);
    expect(d.context).toContain('Which CI provider');
    expect(d.context).toContain('- Buildkite');
    expect(d.answer).toBe('GitHub Actions');
    expect(ir.nodes.some((n) => n.kind === 'tool' && n.label.startsWith('clarify'))).toBe(false);
  });

  it('salvages result JSON with an advisory suffix, and only counts true drift', async () => {
    const { ir, details } = await parse(await refFor(HERMES_TROUBLE_RUN_ID), { collectDetails: true });
    // exactly the unknown role + unknown display_kind rows; the hidden row
    // and the [Tool loop warning] suffix are recognized shapes.
    expect(ir.meta.unrecognizedLineCount).toBe(2);
    const group = [...details.values()].find(
      (d) => d.kind === 'tool' && d.calls?.some((c) => c.output?.includes('token: $CI_TOKEN')),
    );
    const call = group.calls.find((c) => c.output?.includes('token: $CI_TOKEN'));
    expect(call.isError).toBe(false);
  });

  // Hermes counts WALKED ROWS, not lines — the coverage unit is adapter-defined
  // and never compared across adapters. `row()` is the single choke point every
  // row passes through, in the parent backbone and in every delegation lane.
  it('counts every walked row, in rows, with the drifted shapes named', async () => {
    const { ir } = await parse(await refFor(HERMES_TROUBLE_RUN_ID));
    expect(ir.meta.coverage).toEqual({ records: 18, unrecognized: 2, sourcesUnread: 0 });
    expect(ir.meta.coverage.unrecognized).toBe(ir.meta.unrecognizedLineCount);
    expect(ir.meta.ext.hermes.unknownTypes).toEqual({ 'role:system': 1, holo_recap: 1 });
    // The clean hermes run is read completely, the way its Claude counterpart is.
    const clean = (await parse(await refFor(HERMES_CLEAN_RUN_ID))).ir;
    expect(clean.meta.coverage.unrecognized).toBe(0);
    expect(clean.meta.coverage.records).toBeGreaterThan(3);
    // A delegation run's lanes count into the same total as the backbone.
    const deleg = (await parse(await refFor(HERMES_DELEG_RUN_ID))).ir;
    expect(deleg.meta.coverage.records).toBe(15);
  });

  it('rewound rows and model switches land in ext.hermes, not on the canvas', async () => {
    const { ir } = await parse(await refFor(HERMES_TROUBLE_RUN_ID));
    expect(ir.meta.ext.hermes.inactiveMessageCount).toBe(1);
    expect(ir.meta.ext.hermes.modelSwitchCount).toBe(1);
    expect(ir.nodes.some((n) => n.label.includes('abandoned rewound'))).toBe(false);
    expect(ir.nodes.some((n) => n.label.includes('internal bookkeeping'))).toBe(false);
  });

  it('turn tokens sum the turn\'s assistant token_counts', async () => {
    const { ir } = await parse(await refFor(HERMES_CLEAN_RUN_ID));
    const turn = ir.nodes.find((n) => n.kind === 'turn');
    expect(turn.tokens).toEqual({ input: 0, output: 200 });
  });

  it('file attribution reaches find_nodes, including result-proven search_files paths', async () => {
    const { ir } = await parse(await refFor(HERMES_REPO_RUN_ID));
    expect(matchNodes(ir, 'deploy.sh').length).toBeGreaterThan(0);
    const search = ir.nodes.find((n) => n.label.startsWith('search_files'));
    expect(search.files).toEqual(['/home/dev/acme/scripts/deploy.sh']);
  });
});

describe.skipIf(!hasNodeSqlite)('hermes delegation', () => {
  it('children become agent nodes with lanes, spawn labels from goals, returns from the delivery', async () => {
    const { ir, details } = await parse(await refFor(HERMES_DELEG_RUN_ID), { collectDetails: true });
    const agents = ir.nodes.filter((n) => n.kind === 'agent');
    expect(agents.map((a) => a.agentId)).toEqual([HERMES_CHILD_A_ID, HERMES_CHILD_B_ID]);
    for (const a of agents) {
      expect(a.status).toBe('completed');
      expect(a.model).toBe('deepseek-v4-pro');
      expect(a.group).toBe(`lane:${a.id}`);
      expect(ir.groups.some((g) => g.id === a.group)).toBe(true);
    }
    // tokens come from the child session rows
    expect(agents[0].tokens).toEqual({ input: 5000, output: 400 });
    const spawnA = ir.edges.find((e) => e.kind === 'spawn' && e.to === agents[0].id);
    expect(spawnA.label).toBe('Research framework A performance');
    const retA = ir.edges.find((e) => e.kind === 'return' && e.from === agents[0].id);
    expect(retA.label).toContain('✓ TASK 1/2');
    // the delivery decorates the agent detail, and is never a turn
    expect(details.get(agents[0].id).result).toContain('cold-start latency');
    expect(ir.nodes.some((n) => n.label.includes('ASYNC DELEGATION'))).toBe(false);
    // the child's own messages are a lane: its nodes carry the lane group
    const laneNodes = ir.nodes.filter((n) => n.group === agents[0].group && n.id !== agents[0].id);
    expect(laneNodes.length).toBeGreaterThan(1);
    expect(laneNodes.some((n) => n.kind === 'turn')).toBe(true);
    expect(laneNodes.some((n) => n.kind === 'tool')).toBe(true);
    expect(ir.meta.totals.agents).toBe(2);
  });

  it('the lane\'s file touches union onto the agent node', async () => {
    const { ir } = await parse(await refFor(HERMES_DELEG_RUN_ID));
    const b = ir.nodes.find((n) => n.agentId === HERMES_CHILD_B_ID);
    expect(b.files).toEqual(['/home/dev/notes/plugins.md']);
  });

  it('an unpaired FINAL call in an un-ended session is running (live tail)', async () => {
    const { ir } = await parse(await refFor(HERMES_DELEG_RUN_ID));
    const write = ir.nodes.find((n) => n.kind === 'tool' && n.label.startsWith('write_file') && !n.group);
    expect(write.status).toBe('running');
    expect(ir.meta.endedAt).toBeUndefined();
  });

  it('auto_continue rows fold into the flow instead of becoming turns', async () => {
    const { ir } = await parse(await refFor(HERMES_DELEG_RUN_ID));
    expect(ir.nodes.some((n) => n.label.includes('auto-continue'))).toBe(false);
    // exactly one real turn on the backbone
    expect(ir.nodes.filter((n) => n.kind === 'turn' && !n.group)).toHaveLength(1);
  });
});

describe.skipIf(!hasNodeSqlite)('hermes schema tolerance', () => {
  it('an older, narrower schema parses with degraded fields, no crash', async () => {
    const ref = await refFor(HERMES_LEGACY_RUN_ID);
    expect(ref).toBeDefined();
    expect(ref.profile).toBe('legacy');
    expect(ref.project).toBe('✦ Hermes tasks'); // no cwd column at all
    // modifiedAt falls back to ended_at when last_activity_at is missing
    expect(ref.modifiedAt > ref.startedAt).toBe(true);
    const { ir } = await parse(ref);
    expect(ir.nodes.filter((n) => n.kind === 'tool')).toHaveLength(1);
    expect(ir.meta.ext.hermes.gitBranch).toBeUndefined();
    expect(ir.meta.ext.hermes.schemaVersion).toBeUndefined();
    expect(ir.meta.unrecognizedLineCount).toBe(0);
  });
});

describe.skipIf(!hasNodeSqlite)('hermes resume / watch / fingerprint', () => {
  it('cli sessions resume; gateway sessions are view-only', async () => {
    const cli = await refFor(HERMES_CLEAN_RUN_ID);
    const info = resumeInfo(cli);
    expect(info.argv).toEqual(['hermes', '--resume', cli.sessionId]);
    // /home/dev does not exist here, so no cd prefix and no launch cwd
    expect(info.cwd).toBeNull();
    expect(info.copyCommand).toBe(`hermes --resume ${cli.sessionId}`);
    expect(info.forkArgv).toBeUndefined(); // Hermes has no fork flag
    const gateway = await refFor(HERMES_GATEWAY_RUN_ID);
    expect(resumeInfo(gateway)).toBeNull();
  });

  it('watch targets are the DB dir, the DB and its WAL; fingerprint is activity+count', async () => {
    const ref = await refFor(HERMES_CLEAN_RUN_ID);
    expect(watchTargets(ref)).toEqual([
      // The dir target is what survives SQLite deleting + recreating the -wal
      // across Hermes restarts — see watchTargets' comment.
      { path: dirname(ref.dbPath), recursive: false },
      { path: ref.dbPath, recursive: false },
      { path: `${ref.dbPath}-wal`, recursive: false },
    ]);
    expect(fingerprint(ref)).toBe(`${ref.lastActivityAt}:${ref.messageCount}`);
  });
});

// The structured-degrade contract end to end: `rungraph list --json` carries
// the warnings entry alongside the runs of the healthy adapters, exit 0 —
// exactly what an agent on a machine with a broken (or, on Node 20, an
// unreadable) Hermes install must see.
describe.skipIf(!hasNodeSqlite)('hermes warnings through the CLI', () => {
  it('list --json carries scan warnings without losing the other adapters', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-hermes-cli-'));
    try {
      await writeFile(join(tmp, 'state.db'), 'garbage, not sqlite');
      const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, 'list', '--json'], {
        env: {
          ...process.env,
          RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
          RUNGRAPH_CODEX_SESSIONS: '',
          RUNGRAPH_HERMES_HOME: tmp,
          // The warnings assertions below count degradations. opencode is the
          // OTHER node:sqlite adapter and would add its own on a machine that
          // has it installed, so this suite must not depend on that.
          RUNGRAPH_OPENCODE_HOME: '',
          RUNGRAPH_CURSOR_GLOBAL_STORAGE: '',
          RUNGRAPH_CURSOR_CLI_HOME: '',
        },
      });
      const data = JSON.parse(stdout);
      expect(data.runs.length).toBeGreaterThan(0); // claude fixtures still list
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].adapter).toBe('hermes');
      // The bin entry filters node:sqlite's ExperimentalWarning — agents read
      // stderr as the log channel and this noise is not a log.
      expect(stderr).not.toContain('ExperimentalWarning');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('/api/index carries the same warnings for the dashboard', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rg-hermes-api-'));
    const saved = {
      claude: process.env.RUNGRAPH_CLAUDE_PROJECTS,
      codex: process.env.RUNGRAPH_CODEX_SESSIONS,
      hermes: process.env.RUNGRAPH_HERMES_HOME,
      opencode: process.env.RUNGRAPH_OPENCODE_HOME,
      cursorIde: process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE,
      cursorCli: process.env.RUNGRAPH_CURSOR_CLI_HOME,
    };
    let server;
    try {
      await writeFile(join(tmp, 'state.db'), 'still not sqlite');
      process.env.RUNGRAPH_CLAUDE_PROJECTS = '';
      process.env.RUNGRAPH_CODEX_SESSIONS = '';
      process.env.RUNGRAPH_HERMES_HOME = tmp;
      process.env.RUNGRAPH_OPENCODE_HOME = '';
      process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE = '';
      process.env.RUNGRAPH_CURSOR_CLI_HOME = '';
      const { startServer } = await import('../src/server.js');
      server = await startServer({ preferredPort: 4991 });
      const index = await (await fetch(`${server.url}/api/index`)).json();
      expect(index.warnings).toHaveLength(1);
      expect(index.warnings[0].adapter).toBe('hermes');
    } finally {
      for (const [k, v] of [
        ['RUNGRAPH_CLAUDE_PROJECTS', saved.claude],
        ['RUNGRAPH_CODEX_SESSIONS', saved.codex],
        ['RUNGRAPH_HERMES_HOME', saved.hermes],
        ['RUNGRAPH_OPENCODE_HOME', saved.opencode],
        ['RUNGRAPH_CURSOR_GLOBAL_STORAGE', saved.cursorIde],
        ['RUNGRAPH_CURSOR_CLI_HOME', saved.cursorCli],
      ]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await server?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// Regression coverage for the adversarial-review findings: each case builds
// the exact row shape that produced wrong output, through a real SQLite DB.
describe.skipIf(!hasNodeSqlite)('hermes review regressions', () => {
  /** A throwaway Hermes-shaped DB; returns { dir, dbPath, db } (caller rm's dir). */
  const buildDb = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rg-hermes-reg-'));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state.db'));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
        started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
        message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        title TEXT, cwd TEXT, last_activity_at REAL,
        archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
        rewind_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
        timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
        active INTEGER NOT NULL DEFAULT 1, display_kind TEXT
      );
    `);
    return { dir, dbPath: join(dir, 'state.db'), db };
  };
  const T0 = 1754050000;
  const callJson = (id, name, args) =>
    JSON.stringify([{ id, call_id: id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
  const session = (db, id, over = {}) =>
    db
      .prepare(
        'INSERT INTO sessions (id, source, started_at, ended_at, parent_session_id, title, last_activity_at, message_count) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, over.source ?? 'cli', over.started ?? T0, over.ended ?? null, over.parent ?? null, over.title ?? null, over.lastActivity ?? null, over.messageCount ?? 0);
  const msg = (db, sessionId, role, over = {}) =>
    db
      .prepare(
        'INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)',
      )
      .run(sessionId, role, over.content ?? null, over.callId ?? null, over.calls ?? null, over.toolName ?? null, over.ts ?? T0 + 10);
  const parseOne = async (dir) => {
    const refs = await detect([dir]);
    return { ref: refs[0], ...(await parse(refs[0], { collectDetails: true })) };
  };

  it('a live group whose LATEST call is pending stays running despite an earlier result', async () => {
    const { dir, db } = await buildDb();
    try {
      session(db, '20260801_150000_a11ve1'); // ended_at NULL — live
      msg(db, '20260801_150000_a11ve1', 'user', { content: 'run the tests', ts: T0 + 1 });
      msg(db, '20260801_150000_a11ve1', 'assistant', { calls: callJson('c1', 'terminal', { command: 'ls' }), ts: T0 + 2 });
      msg(db, '20260801_150000_a11ve1', 'tool', { callId: 'c1', toolName: 'terminal', content: '{"output":"ok","exit_code":0,"error":null}', ts: T0 + 3 });
      // Same-name call merges into the group; its result never arrives.
      msg(db, '20260801_150000_a11ve1', 'assistant', { calls: callJson('c2', 'terminal', { command: 'npm test' }), ts: T0 + 4 });
      db.close();
      const { ir } = await parseOne(dir);
      const group = ir.nodes.find((n) => n.kind === 'tool');
      expect(group.callCount).toBe(2);
      expect(group.status).toBe('running');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an unpaired call in an ENDED session is an error, and an orphaned child agent errors too', async () => {
    const { dir, db } = await buildDb();
    try {
      session(db, '20260801_150100_e00e00', { ended: T0 + 100 });
      msg(db, '20260801_150100_e00e00', 'user', { content: 'deploy it', ts: T0 + 1 });
      msg(db, '20260801_150100_e00e00', 'assistant', { calls: callJson('cd1', 'delegate_task', { goal: 'ship the release' }), ts: T0 + 2 });
      msg(db, '20260801_150100_e00e00', 'tool', { callId: 'cd1', toolName: 'delegate_task', content: '{"status":"dispatched","mode":"background","count":1,"delegation_id":"deleg_x1","goals":["ship the release"]}', ts: T0 + 3 });
      msg(db, '20260801_150100_e00e00', 'assistant', { calls: callJson('ct1', 'terminal', { command: 'sleep 600' }), ts: T0 + 4 });
      // no result for ct1, session ENDED → error
      session(db, '20260801_150101_c41d99', { source: 'subagent', parent: '20260801_150100_e00e00', started: T0 + 5, ended: null });
      msg(db, '20260801_150101_c41d99', 'user', { content: 'ship the release', ts: T0 + 6 });
      db.close();
      const { ir } = await parseOne(dir);
      const group = ir.nodes.find((n) => n.kind === 'tool');
      expect(group.status).toBe('error');
      // child never ended, parent is over → the child never will finish
      const agent = ir.nodes.find((n) => n.kind === 'agent');
      expect(agent.status).toBe('error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an untitled session takes its title from the first user message', async () => {
    const { dir, db } = await buildDb();
    try {
      session(db, '20260801_150200_00t171'); // title NULL
      msg(db, '20260801_150200_00t171', 'user', { content: 'Find every subreddit for the launch', ts: T0 + 1 });
      db.close();
      const refs = await detect([dir]);
      expect(refs[0].title).toBe('Find every subreddit for the launch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a FAILED delegate_task dispatch spawns no slot — real children keep their own labels', async () => {
    const { dir, db } = await buildDb();
    try {
      const S = '20260801_150300_de1e99';
      session(db, S, { ended: null });
      msg(db, S, 'user', { content: 'do both things', ts: T0 + 1 });
      msg(db, S, 'assistant', { calls: callJson('cf1', 'delegate_task', { goal: 'audit the SEO' }), ts: T0 + 2 });
      msg(db, S, 'tool', { callId: 'cf1', toolName: 'delegate_task', content: '{"success":false,"error":"max concurrent delegations reached"}', ts: T0 + 3 });
      msg(db, S, 'assistant', { calls: callJson('cf2', 'delegate_task', { goal: 'draft outreach' }), ts: T0 + 4 });
      msg(db, S, 'tool', { callId: 'cf2', toolName: 'delegate_task', content: '{"status":"dispatched","mode":"background","count":1,"delegation_id":"deleg_ok","goals":["draft outreach"]}', ts: T0 + 5 });
      session(db, `${S.slice(0, -6)}c41d77`, { source: 'subagent', parent: S, started: T0 + 6, ended: T0 + 30 });
      db.close();
      const { ir } = await parseOne(dir);
      const agent = ir.nodes.find((n) => n.kind === 'agent');
      // The one real child pairs with the SUCCESSFUL dispatch, not the failed one.
      expect(agent.label).toBe('draft outreach');
      const spawn = ir.edges.find((e) => e.kind === 'spawn');
      expect(spawn.label).toBe('draft outreach');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a denied mixed-name parallel batch never yields an unresolved-error signal', async () => {
    const { dir, db } = await buildDb();
    try {
      const S = '20260801_150400_de2e99';
      session(db, S, { ended: T0 + 60 });
      msg(db, S, 'user', { content: 'set the secret and write the config', ts: T0 + 1 });
      const batch = JSON.stringify([
        { id: 'cb1', call_id: 'cb1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'gh secret set X' }) } },
        { id: 'cb2', call_id: 'cb2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '/home/dev/x.conf', content: 'x' }) } },
      ]);
      msg(db, S, 'assistant', { calls: batch, ts: T0 + 2 });
      for (const id of ['cb1', 'cb2']) {
        msg(db, S, 'tool', { callId: id, toolName: id === 'cb1' ? 'terminal' : 'write_file', content: '{"output":"","exit_code":-1,"error":"BLOCKED: Action denied by user. Do NOT retry."}', ts: T0 + 3 });
      }
      db.close();
      const { ir } = await parseOne(dir);
      const signals = deriveSignals(ir);
      // The intervention chip says the true thing; a "failure" chip would lie.
      expect(signals.filter((s) => s.kind === 'unresolved-error')).toEqual([]);
      expect(signals.filter((s) => s.kind === 'retry-storm')).toEqual([]);
      expect(signals.some((s) => s.kind === 'intervention' && s.severity === 'high')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a clarify question keeps ONE node id from asked to answered (live-tail merge)', async () => {
    const { dir, db } = await buildDb();
    try {
      const S = '20260801_150500_c1a999';
      session(db, S, { ended: null });
      msg(db, S, 'user', { content: 'which env?', ts: T0 + 1 });
      msg(db, S, 'assistant', { calls: callJson('cq1', 'clarify', { question: 'Prod or staging?', choices: ['prod', 'staging'] }), ts: T0 + 2 });
      const askedParse = await parseOne(dir);
      const asked = askedParse.ir.nodes.find((n) => n.kind === 'human');
      expect(asked.status).toBe('running');
      const db2 = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(dir, 'state.db'));
      msg(db2, S, 'tool', { callId: 'cq1', toolName: 'clarify', content: '{"question":"Prod or staging?","choices_offered":["prod","staging"],"user_response":"staging"}', ts: T0 + 9 });
      db2.close();
      const answeredParse = await parseOne(dir);
      const answered = answeredParse.ir.nodes.find((n) => n.kind === 'human');
      expect(answered.id).toBe(asked.id); // update, never remove+add
      expect(answered.status).toBe('completed');
      expect(answered.label).toBe('answered: staging');
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a subagent write moves the parent fingerprint and live badge', async () => {
    const { dir, db } = await buildDb();
    try {
      const S = '20260801_150600_f00f00';
      session(db, S, { ended: null, lastActivity: T0 + 5, messageCount: 2 });
      msg(db, S, 'user', { content: 'fan out', ts: T0 + 1 });
      session(db, `${S.slice(0, -6)}c41d55`, { source: 'subagent', parent: S, started: T0 + 2, ended: null, messageCount: 1 });
      const before = fingerprint((await detect([dir]))[0]);
      // The child works: new rows under ITS session id, parent row untouched.
      msg(db, `${S.slice(0, -6)}c41d55`, 'assistant', { content: 'child progress', ts: T0 + 500 });
      const after = (await detect([dir]))[0];
      expect(fingerprint(after)).not.toBe(before);
      // …and modifiedAt tracks the newest write in the tree, not the stale
      // turn-boundary stamp, so the 45s live badge survives a delegation.
      expect(after.modifiedAt).toBe(new Date((T0 + 500) * 1000).toISOString());
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('live tail survives the -wal being created after the watch starts', async () => {
    const { dir, db } = await buildDb();
    try {
      const S = '20260801_150700_wa1000';
      session(db, S, { ended: null, lastActivity: Date.now() / 1000 });
      msg(db, S, 'user', { content: 'begin', ts: T0 + 1 });
      db.exec('PRAGMA journal_mode=WAL');
      db.close(); // clean close: SQLite removes the -wal — the deaf-watch shape
      const hermes = await import('../src/adapters/hermes/index.js');
      const { watchRun } = await import('../src/watcher.js');
      const refs = await detect([dir]);
      let emits = 0;
      const done = new Promise((resolve) => {
        const w = watchRun(refs[0], hermes, {
          onGraph() {
            emits++;
            if (emits >= 2) {
              w.close();
              resolve();
            }
          },
          onError() {},
          debounceMs: 50,
        });
        setTimeout(() => {
          // A writer reappears: WAL commits only — the recreated -wal is the
          // only thing that changes, and the directory target must hear it.
          const db2 = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(dir, 'state.db'));
          db2.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run(S, 'user', 'a live follow-up', T0 + 20);
          db2.close();
        }, 300);
        setTimeout(() => {
          w.close();
          resolve();
        }, 5000); // fail-safe: the assertion below reports the miss
      });
      await done;
      expect(emits).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});

// The self-disable path (spec decision 1 / acceptance criterion 4), on BOTH
// CI legs: Node 20 lacks node:sqlite natively; on newer Nodes the flag
// simulates it. Deliberately NOT inside a skipIf — this is the one hermes
// behavior that must hold exactly where node:sqlite is missing.
describe('hermes graceful degrade (adapter self-disables)', () => {
  it('list --json: warnings entry, zero hermes runs, exit 0, one stderr line', async () => {
    const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');
    const nodeArgs = hasNodeSqlite ? ['--no-experimental-sqlite'] : [];
    // process.execPath, not 'node': the PATH node may be a different major
    // than the one running this suite, and this test is ABOUT the runtime.
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [...nodeArgs, BIN, 'list', '--json'],
      {
        env: {
          ...process.env,
          RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
          RUNGRAPH_CODEX_SESSIONS: '',
          RUNGRAPH_HERMES_HOME: HERMES_FIXTURE_ROOT,
          // Without this, a machine with opencode installed emits a SECOND
          // node:sqlite warning here and the count assertion fails — the
          // Hermes suite must not depend on which other agents are installed.
          RUNGRAPH_OPENCODE_HOME: '',
          RUNGRAPH_CURSOR_GLOBAL_STORAGE: '',
          RUNGRAPH_CURSOR_CLI_HOME: '',
        },
      },
    );
    const data = JSON.parse(stdout);
    expect(data.runs.some((r) => r.adapter === 'hermes')).toBe(false);
    expect(data.runs.length).toBeGreaterThan(0); // other adapters unaffected
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0].reason).toContain('node:sqlite');
    expect(stderr).toContain('Hermes runs need Node 22.13+');
  });
});
