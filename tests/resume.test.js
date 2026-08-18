import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { scan, toIndexEntry } from '../src/scanner.js';
import { buildLaunchPlan } from '../src/launch.js';
import { shellQuote } from '../src/util.js';
import {
  detect as claudeDetect,
  resumeInfo as claudeResumeInfo,
} from '../src/adapters/claude-code/index.js';
import {
  detect as codexDetect,
  resumeInfo as codexResumeInfo,
} from '../src/adapters/codex/index.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  CODEX_CLEAN_RUN_ID,
} from './helpers.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_THREAD_ID = 'c1c1c1c1-0000-7000-8000-000000000001';

// ---------------------------------------------------------------------------
// Adapter units — resumeInfo against the real fixture corpus. The fixture
// project ('/home/dev/acme') does not exist on any machine running this suite,
// so these exercise the missing-project-dir road: cwd null, no `cd` prefix.
// ---------------------------------------------------------------------------

describe('resumeInfo (claude-code)', () => {
  let refs;
  beforeAll(async () => {
    await pinFixtureMtimes();
    refs = await claudeDetect([FIXTURE_ROOT]);
  });
  const ref = (runId) => refs.find((r) => r.runId === runId);

  it('builds the exact argv, fork variant, and copy strings for a session', () => {
    const info = claudeResumeInfo(ref(SESSION_RUN_ID));
    expect(info.argv).toEqual(['claude', '--resume', SESSION_ID]);
    expect(info.forkArgv).toEqual(['claude', '--resume', SESSION_ID, '--fork-session']);
    expect(info.copyCommand).toBe(`claude --resume ${SESSION_ID}`);
    expect(info.forkCopyCommand).toBe(`claude --resume ${SESSION_ID} --fork-session`);
  });

  it('cwd is null when the project dir does not exist — resume works from anywhere', () => {
    const info = claudeResumeInfo(ref(SESSION_RUN_ID));
    expect(ref(SESSION_RUN_ID).projectExists).toBe(false);
    expect(info.cwd).toBeNull();
  });

  it('workflow rows get no resume — their parent session is the resumable thing', () => {
    expect(claudeResumeInfo(ref(WORKFLOW_RUN_ID))).toBeNull();
  });
});

describe('resumeInfo (codex)', () => {
  let refs;
  beforeAll(async () => {
    await pinFixtureMtimes();
    refs = await codexDetect([CODEX_FIXTURE_ROOT]);
  });
  const ref = (runId) => refs.find((r) => r.runId === runId);

  it('builds the exact argv and copy string; no fork — codex has no equivalent', () => {
    const info = codexResumeInfo(ref(CODEX_CLEAN_RUN_ID));
    expect(info.argv).toEqual(['codex', 'resume', CODEX_THREAD_ID]);
    expect(info.forkArgv).toBeUndefined();
    expect(info.forkCopyCommand).toBeUndefined();
  });

  it('drops the `cd` prefix when the project dir is gone — a copy string that fails on paste is worse', () => {
    const info = codexResumeInfo(ref(CODEX_CLEAN_RUN_ID));
    expect(info.cwd).toBeNull();
    expect(info.copyCommand).toBe(`codex resume ${CODEX_THREAD_ID}`);
  });
});

// ---------------------------------------------------------------------------
// The existing-project road: synthetic minimal transcripts whose cwd points at
// a real (temp) directory — with a space in it, so the quoting is exercised too.
// ---------------------------------------------------------------------------

describe('resumeInfo when the project dir exists', () => {
  let tmp;
  let projDir;
  const claudeSid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const codexTid = 'bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb';
  let claudeRef;
  let codexRef;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'rg-resume-'));
    projDir = join(tmp, 'proj with space');
    await mkdir(projDir, { recursive: true });

    const claudeRoot = join(tmp, 'projects');
    const providerDir = join(claudeRoot, '-proj-with-space');
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, `${claudeSid}.jsonl`),
      JSON.stringify({
        type: 'user',
        cwd: projDir,
        timestamp: '2026-08-01T13:00:00.000Z',
        message: { content: 'hello resume' },
      }) + '\n',
    );
    claudeRef = (await claudeDetect([claudeRoot])).find((r) => r.sessionId === claudeSid);

    const codexRoot = join(tmp, 'codex');
    const dayDir = join(codexRoot, '2026', '08', '01');
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, `rollout-2026-08-01T13-00-00-${codexTid}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-01T13:00:00.000Z',
        payload: { id: codexTid, cwd: projDir },
      }) + '\n',
    );
    codexRef = (await codexDetect([codexRoot])).find((r) => r.sessionId === codexTid);
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it('claude: cwd is the project, but the copy string still carries no cd', () => {
    expect(claudeRef.projectExists).toBe(true);
    const info = claudeResumeInfo(claudeRef);
    expect(info.cwd).toBe(projDir);
    expect(info.copyCommand).toBe(`claude --resume ${claudeSid}`);
  });

  it('an ordinary run in a directory that exists is not loose', () => {
    // The one real-adapter, real-filesystem road through the loose rule.
    expect(toIndexEntry(claudeRef).loose).toBe(false);
    expect(toIndexEntry(codexRef).loose).toBe(false);
  });

  it('codex: cwd matters for the sandbox, so the copy string carries a quoted cd', () => {
    const info = codexResumeInfo(codexRef);
    expect(info.cwd).toBe(projDir);
    expect(info.copyCommand).toBe(`cd '${projDir}' && codex resume ${codexTid}`);
  });
});

// ---------------------------------------------------------------------------
// The launcher's pure planning half. The real window is a manual test, like
// the rest of the rendered UI; what is unit-testable is the escaping and the
// platform/terminal branching, which is exactly where an exec-convention bug
// would open a window that flashes and dies while the server reports success.
// ---------------------------------------------------------------------------

describe('buildLaunchPlan', () => {
  const argv = ['claude', '--resume', 'abc-123'];

  it('darwin default: Terminal.app do script + activate, cwd cd-prefixed', () => {
    const plan = buildLaunchPlan(argv, '/home/dev/acme', { platform: 'darwin', terminal: '' });
    expect(plan.warnings).toEqual([]);
    expect(plan.command[0]).toBe('osascript');
    expect(plan.command).toContain('tell application "Terminal"');
    expect(plan.command).toContain('do script "cd /home/dev/acme && claude --resume abc-123"');
    expect(plan.command).toContain('activate');
  });

  it('null cwd: no cd — the terminal opens where it opens ($HOME)', () => {
    const plan = buildLaunchPlan(argv, null, { platform: 'darwin', terminal: '' });
    expect(plan.command).toContain('do script "claude --resume abc-123"');
  });

  it('RUNGRAPH_TERMINAL=iTerm: dedicated branch, write text into a new window', () => {
    const plan = buildLaunchPlan(argv, null, { platform: 'darwin', terminal: 'iTerm' });
    expect(plan.warnings).toEqual([]);
    expect(plan.command).toContain('tell application "iTerm"');
    expect(plan.command).toContain('create window with default profile');
    expect(plan.command).toContain('write text "claude --resume abc-123"');
  });

  it('an unknown terminal falls back to Terminal.app with a warning', () => {
    const plan = buildLaunchPlan(argv, null, { platform: 'darwin', terminal: 'kitty' });
    expect(plan.warnings).toEqual([
      'unknown RUNGRAPH_TERMINAL "kitty" — launching Terminal.app instead',
    ]);
    expect(plan.command).toContain('tell application "Terminal"');
  });

  it('non-darwin platforms cannot launch at all', () => {
    expect(buildLaunchPlan(argv, '/x', { platform: 'linux', terminal: '' })).toBeNull();
    expect(buildLaunchPlan(argv, '/x', { platform: 'win32', terminal: '' })).toBeNull();
  });

  it('escapes both layers: shell single-quotes, then AppleScript string rules', () => {
    const plan = buildLaunchPlan(['claude', '--resume', 'id'], `/p'q r`, {
      platform: 'darwin',
      terminal: '',
    });
    // Shell layer: /p'q r → '/p'\''q r'; AppleScript layer: backslashes doubled.
    expect(plan.command).toContain(`do script "cd '/p'\\\\''q r' && claude --resume id"`);
  });

  it('shellQuote leaves safe strings alone and wraps the rest', () => {
    expect(shellQuote('abc-123.js')).toBe('abc-123.js');
    expect(shellQuote('/home/dev/acme')).toBe('/home/dev/acme');
    expect(shellQuote('a b')).toBe(`'a b'`);
    expect(shellQuote('')).toBe(`''`);
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
  });
});

// ---------------------------------------------------------------------------
// The index-entry contract: the resume block rides toIndexEntry, so the
// dashboard, `rungraph list --json`, and MCP list_runs (all the same call
// site) carry the copy strings — and never argv or cwd.
// ---------------------------------------------------------------------------

describe('toIndexEntry resume block', () => {
  let runs;
  beforeAll(async () => {
    await pinFixtureMtimes();
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
    process.env.RUNGRAPH_HERMES_HOME = '';
    ({ runs } = await scan());
  });
  afterAll(() => {
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    delete process.env.RUNGRAPH_CODEX_SESSIONS;
    delete process.env.RUNGRAPH_HERMES_HOME;
  });

  it('sessions carry copy strings and the platform launch capability', () => {
    const entry = toIndexEntry(runs.find((r) => r.runId === SESSION_RUN_ID));
    expect(entry.resume).toEqual({
      copyCommand: `claude --resume ${SESSION_ID}`,
      forkCopyCommand: `claude --resume ${SESSION_ID} --fork-session`,
      canLaunch: process.platform === 'darwin',
    });
  });

  it('codex sessions carry no fork variant', () => {
    const entry = toIndexEntry(runs.find((r) => r.runId === CODEX_CLEAN_RUN_ID));
    expect(entry.resume.copyCommand).toBe(`codex resume ${CODEX_THREAD_ID}`);
    expect(entry.resume).not.toHaveProperty('forkCopyCommand');
  });

  it('workflow rows carry no resume block at all', () => {
    const entry = toIndexEntry(runs.find((r) => r.runId === WORKFLOW_RUN_ID));
    expect(entry).not.toHaveProperty('resume');
  });

  it('argv and cwd never leave the server', () => {
    for (const r of runs) {
      const entry = toIndexEntry(r);
      if (!entry.resume) continue;
      expect(entry.resume).not.toHaveProperty('argv');
      expect(entry.resume).not.toHaveProperty('forkArgv');
      expect(entry.resume).not.toHaveProperty('cwd');
    }
  });
});

// ---------------------------------------------------------------------------
// The `loose` flag also rides toIndexEntry — one implementation of "this run's
// project is not a real place to stand", shared by /api/index, `list --json`
// and MCP list_runs. The dashboard groups loose runs under `✦ loose runs`.
// ---------------------------------------------------------------------------

describe('toIndexEntry loose flag', () => {
  // toIndexEntry does no I/O — projectExists was probed at detect — so the
  // rule is exercised with hand-built refs. An unregistered adapter name
  // keeps resumeInfo out of the way.
  const ref = (over = {}) => ({
    runId: 'x-vendor:loose-case',
    adapter: 'x-vendor',
    kind: 'session',
    title: 't',
    project: '/somewhere/real',
    startedAt: null,
    modifiedAt: '2026-08-01T13:00:00.000Z',
    sizeBytes: 1,
    projectExists: true,
    projectFromCwd: true,
    ...over,
  });

  it('an existing absolute project is not loose', () => {
    expect(toIndexEntry(ref()).loose).toBe(false);
  });

  it('a bucket label — a group label, not a path — is loose', () => {
    expect(toIndexEntry(ref({ project: '✦ Hermes tasks', projectExists: false })).loose).toBe(true);
    expect(toIndexEntry(ref({ project: '(unknown project)', projectExists: false })).loose).toBe(true);
  });

  it('the home directory is loose even though it exists — nobody’s project', () => {
    expect(toIndexEntry(ref({ project: homedir(), projectExists: true })).loose).toBe(true);
  });

  it('a directory that no longer exists is loose — deleted worktrees, removed one-offs', () => {
    expect(toIndexEntry(ref({ project: '/gone/spec-implement-review-abc', projectExists: false })).loose).toBe(true);
  });

  it('claude’s decoded-dirname fallback stays home: label-not-path, not projectFromCwd', () => {
    // A transcript that never revealed a cwd still gets an absolute (decoded)
    // project path — projectFromCwd false, but its siblings live there, so it
    // is not loose while the directory stands.
    expect(
      toIndexEntry(ref({ projectFromCwd: false, project: '/somewhere/real', projectExists: true }))
        .loose,
    ).toBe(false);
  });

  it('the whole fixture corpus carries the flag, and /home/dev/acme reads as a dead dir', async () => {
    await pinFixtureMtimes();
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
    process.env.RUNGRAPH_HERMES_HOME = '';
    try {
      const { runs } = await scan();
      for (const r of runs) {
        // The fixture project exists on no machine running this suite, so
        // every entry is loose the honest way: its directory is gone.
        expect(toIndexEntry(r).loose).toBe(true);
      }
    } finally {
      delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
      delete process.env.RUNGRAPH_CODEX_SESSIONS;
      delete process.env.RUNGRAPH_HERMES_HOME;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/resume — spawn injected, so no window ever opens under test.
// ---------------------------------------------------------------------------

describe('POST /api/resume', () => {
  let server;
  const calls = [];
  let launchResult = true;

  beforeAll(async () => {
    await pinFixtureMtimes();
    process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
    process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
    process.env.RUNGRAPH_HERMES_HOME = '';
    server = await startServer({
      preferredPort: 4780,
      launch: async (argv, cwd) => {
        calls.push({ argv, cwd });
        return launchResult;
      },
    });
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
    delete process.env.RUNGRAPH_CODEX_SESSIONS;
    delete process.env.RUNGRAPH_HERMES_HOME;
    await server.close();
  });

  const post = async (body, headers = {}) => {
    const res = await fetch(server.url + '/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it('happy path (claude): adapter argv reaches the launcher, cwd null for a gone project', async () => {
    launchResult = true;
    const { status, body } = await post({ runId: SESSION_RUN_ID });
    expect(status).toBe(200);
    expect(body).toEqual({ launched: true });
    expect(calls.at(-1)).toEqual({
      argv: ['claude', '--resume', SESSION_ID],
      cwd: null,
    });
  });

  it('fork: true uses the fork argv', async () => {
    const { status, body } = await post({ runId: SESSION_RUN_ID, fork: true });
    expect(status).toBe(200);
    expect(body).toEqual({ launched: true });
    expect(calls.at(-1).argv).toEqual(['claude', '--resume', SESSION_ID, '--fork-session']);
  });

  it('happy path (codex)', async () => {
    const { status, body } = await post({ runId: CODEX_CLEAN_RUN_ID });
    expect(status).toBe(200);
    expect(body).toEqual({ launched: true });
    expect(calls.at(-1).argv).toEqual(['codex', 'resume', CODEX_THREAD_ID]);
  });

  it('fork on a fork-less vendor is a named 400, and nothing launches', async () => {
    const before = calls.length;
    const { status, body } = await post({ runId: CODEX_CLEAN_RUN_ID, fork: true });
    expect(status).toBe(400);
    expect(body.error).toContain('cannot fork');
    expect(calls.length).toBe(before);
  });

  it('a workflow runId is a named 400 — resume its parent session instead', async () => {
    const before = calls.length;
    const { status, body } = await post({ runId: WORKFLOW_RUN_ID });
    expect(status).toBe(400);
    expect(body.error).toContain('parent session');
    expect(calls.length).toBe(before);
  });

  it('an unknown runId is the standard 404', async () => {
    const { status, body } = await post({ runId: 'claude-code:nope:nope' });
    expect(status).toBe(404);
    expect(body.error).toContain('no run found');
  });

  it('launcher failure degrades to { launched: false, copyCommand } — never a hard failure', async () => {
    launchResult = false;
    const { status, body } = await post({ runId: SESSION_RUN_ID, fork: true });
    expect(status).toBe(200);
    // The command offered for copying is the variant that would have run.
    expect(body).toEqual({
      launched: false,
      copyCommand: `claude --resume ${SESSION_ID} --fork-session`,
    });
    launchResult = true;
  });

  it('rejects a non-local Origin with 403, before touching anything', async () => {
    const before = calls.length;
    const { status, body } = await post(
      { runId: SESSION_RUN_ID },
      { origin: 'https://evil.example' },
    );
    expect(status).toBe(403);
    expect(body.error).toContain('cross-origin');
    expect(calls.length).toBe(before);
  });

  it('a local Origin (the dashboard itself) is accepted', async () => {
    const { status } = await post(
      { runId: SESSION_RUN_ID },
      { origin: `http://127.0.0.1:${server.port}` },
    );
    expect(status).toBe(200);
  });

  it('GET is a 405 — POST only', async () => {
    const res = await fetch(server.url + '/api/resume');
    expect(res.status).toBe(405);
  });

  it('a missing or non-string runId is a named 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ runId: 42 })).status).toBe(400);
    expect((await post({})).body.error).toContain('expected');
  });

  it('a malformed body is a 400, not a crash', async () => {
    const { status } = await post('{not json');
    expect(status).toBe(400);
  });
});
