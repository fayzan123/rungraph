import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statOrNull } from './util.js';

/**
 * The MCP client table — how rungraph installs itself into an agent, and how
 * it reads back whether it is there.
 *
 * A seventh member of CLAUDE.md's "shared code, one implementation" set, and
 * added for the same reason as the other six: `--install`, `--check` and the
 * `serve` nudge each need to answer "how do I install into provider X, and is
 * it there?". Three copies of that answer are three things that can disagree,
 * and they DID disagree — `--install` knew two clients, `--check` knew one,
 * and the README knew a third (a Hermes line that silently no-ops when
 * scripted). rungraph ships five adapters; it should ship five clients, and
 * `tests/clients.test.js` makes that a build break rather than a good
 * intention — the Cursor entry was added under exactly that guard.
 *
 * **This module does not take the no-imports rule** that binds `find.js`,
 * `coverage.js` and `secrets.js`. Those three are pure because the frontend
 * bundle imports them directly from `src/`. Nothing in `frontend/` imports
 * this file — the dashboard's install copy is deliberately provider-neutral
 * so that stays true — so this module is free to use `node:child_process` and
 * `node:fs/promises`. If a future change makes the frontend want this table,
 * it arrives over the API, not by import.
 *
 * Every vendor behaviour encoded below was PROBED against that vendor's real
 * CLI on 2026-08-20/21 (Cursor on 2026-08-23), each time against a throwaway
 * config home, never the developer's own. Versions: claude 2.1.238, codex-cli
 * 0.144.4, Hermes Agent v0.20.1, opencode 1.18.19, cursor-agent 2026.08.11 /
 * Cursor 3.16.29. Nothing here is inferred from documentation, and the
 * per-entry comments record what was seen rather than what was expected —
 * including, for Cursor, the one line that is still unverified.
 */

/** rungraph's own bin, resolved from this module's location. */
export const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');

/**
 * The `clientInfo.name` `--check`'s own handshake sends. Shared with mcp.js
 * so the breadcrumb's self-exclusion and the handshake that must be excluded
 * cannot drift apart into two spellings of the same string.
 */
export const SELF_CLIENT = 'rungraph-check';

/**
 * The imperative line that actually closes the loop from the agent's side.
 *
 * Measured, not decorative: agents skip `focus_nodes` by default because
 * nothing in an ordinary task says to call it. The MCP server's own
 * `instructions` carry one copy; a line in the repo's instruction file is the
 * other, and it is the one that survives a host which lazy-loads tool schemas.
 */
export const AGENTS_SNIPPET = `## rungraph

When the rungraph MCP tools are available, close the loop: after answering any
question about work done in this project, call \`focus_nodes\`
(\`list_runs\` → \`find_nodes\` → \`focus_nodes\`) so an open dashboard shows the
nodes your answer is about. Answer in the terminal first; the highlight
follows, and is a bonus, never the answer.`;

/* --------------------------------------------------------------- launch */

/**
 * The `{ command, args }` every install path and every paste block is built
 * from — chosen by HOW rungraph was invoked, because the answer differs.
 *
 * The bug this exists to fix: `npx rungraph mcp --install` used to write an
 * absolute path into the agent's config, and under npx that path lives in
 * `~/.npm/_npx/<hash>/…`, a cache npm garbage-collects. When it is collected
 * the agent's MCP server simply stops starting, with no error the user will
 * ever see — the tools are absent, which looks identical to never having
 * installed. Verified on this machine on 2026-08-21: a packed tarball run
 * through npx resolved its bin to
 * `/Users/…/.npm/_npx/a84cd0988ba9c7c1/node_modules/rungraph/bin/rungraph.js`.
 *
 * Three cases, in order:
 *
 * 1. `rungraph` is on the user's own PATH (a global or linked install) →
 *    `rungraph mcp`. Stable, and the fastest to start.
 * 2. Running from an npx cache → `npx -y rungraph mcp`. Immune to eviction,
 *    and the same spelling the README already used for Hermes, so the two
 *    stop disagreeing. Measured cost with a warm cache on this machine:
 *    ~470ms per start versus ~45ms for a direct `node bin/rungraph.js`, which
 *    is why `--install` also prints the `npm i -g rungraph` line.
 * 3. Otherwise — a dev checkout, or any layout we do not recognise → the
 *    absolute `process.execPath` + bin path, which is the correct answer for
 *    a checkout and the only safe answer for the unknown case.
 *
 * **Case 1 must reject ephemeral PATH entries, or it is worse than the bug.**
 * npx PREPENDS its cache's `node_modules/.bin` to PATH, so inside
 * `npx rungraph` a naive `command -v rungraph` succeeds and resolves to
 * `~/.npm/_npx/<hash>/node_modules/.bin/rungraph` — measured, not guessed.
 * Writing bare `rungraph` on the strength of that would produce a config that
 * fails immediately outside the npx process, not merely after a cache sweep.
 * Any `node_modules/.bin` directory is rejected for the same reason one step
 * milder: a project-local install is on PATH for that shell and that repo,
 * and the MCP config it would write is machine-wide.
 *
 * The `_npx` path-segment test in case 2 is a HEURISTIC on an npm
 * implementation detail. It is labelled as one, and case 3 is a
 * correct-if-suboptimal fallback when it misses — a wrong guess degrades to
 * today's behaviour rather than to a broken install.
 *
 * @param {{ binPath?: string, execPath?: string, pathEnv?: string }} [opts]
 *   Injected paths, so tests drive this rather than their own install layout.
 * @returns {Promise<{ command: string, args: string[], via: string, resolved?: string }>}
 */
export async function resolveLaunch(opts = {}) {
  const binPath = opts.binPath ?? BIN_PATH;
  const execPath = opts.execPath ?? process.execPath;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';

  const onPath = await findOnPath('rungraph', pathEnv);
  if (onPath) return { command: 'rungraph', args: ['mcp'], via: 'path', resolved: onPath };
  if (hasNpxSegment(binPath)) return { command: 'npx', args: ['-y', 'rungraph', 'mcp'], via: 'npx-cache' };
  return { command: execPath, args: [binPath, 'mcp'], via: 'absolute' };
}

/** Does this path sit inside an npx cache? See resolveLaunch case 2. */
function hasNpxSegment(path) {
  return segmentsOf(path).includes('_npx');
}

/**
 * PATH entries that are real for this process but not for the agent that will
 * later read the config we write. See resolveLaunch's case-1 note.
 */
function isEphemeralBinDir(dir) {
  const parts = segmentsOf(dir);
  if (parts.includes('_npx')) return true;
  return parts.at(-1) === '.bin' && parts.at(-2) === 'node_modules';
}

function segmentsOf(path) {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** First executable `name` on PATH, skipping ephemeral dirs. Null if none. */
async function findOnPath(name, pathEnv) {
  // Windows resolves a bare name through PATHEXT; POSIX needs the exec bit.
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  for (const dir of pathEnv.split(delimiter)) {
    // A RELATIVE PATH entry (`.`, `tools`, `bin`) is the same class of
    // mistake as the npx one: real for this process because of where it
    // happens to be standing, meaningless in the machine-wide config we would
    // write from it.
    if (!dir || !isAbsolute(dir) || isEphemeralBinDir(dir)) continue;
    for (const ext of exts) {
      const st = await statOrNull(join(dir, name + ext));
      if (!st?.isFile()) continue;
      if (process.platform !== 'win32' && !(st.mode & 0o111)) continue;
      return join(dir, name + ext);
    }
  }
  return null;
}

/* -------------------------------------------------------- vendor runner */

/**
 * Run a vendor CLI, capturing output. A missing binary is a RESULT, not a
 * throw — "the `codex` CLI is not on PATH" is something `--check` reports, not
 * something that ends the process.
 *
 * `stdin` exists for exactly one vendor (see the hermes entry) and is fed as
 * bytes rather than through a pipe, because a pipe's exit status is the
 * pipeline's, not the child's — the mistake that produced one confidently
 * wrong finding while this table was being probed.
 *
 * The timeout is not decoration: `claude mcp list` health-checks every
 * registered server as it runs, and `hermes mcp add` boots the server it is
 * being pointed at. Either can hang on a machine with a wedged MCP server,
 * and `rungraph mcp --check` hanging forever is worse than reporting that it
 * could not tell.
 */
const DRAIN_MS = 250;

export function runVendor(bin, args, { stdin = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // Inherited by whatever the vendor spawns, which is the point. THREE
        // of the five vendor commands rungraph runs boot rungraph's own MCP
        // server as a child: `claude mcp list` and `opencode mcp list`
        // health-check by handshaking with every registered server, and
        // `hermes mcp add` connects to enumerate tools before it writes
        // anything. Without this flag, `rungraph mcp --check` would leave
        // behind a breadcrumb saying an agent had connected — evidence the
        // check itself manufactured, one process removed from the
        // self-handshake the SELF_CLIENT name already excludes. A health probe
        // rungraph asked for is not a user's agent using the loop.
        //
        // This is the CHEAP guard, not the guarantee: an MCP client is not
        // obliged to pass its environment to the server it spawns, and
        // opencode's does not. See withoutBreadcrumbSideEffects.
        env: { ...process.env, RUNGRAPH_NO_BREADCRUMB: '1' },
      });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err?.message ?? err), spawnError: true, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve(result);
    };
    // `close` is the right settle — it means the process exited AND its output
    // is complete — but it can never fire if the vendor leaves a background
    // child holding the inherited stdout. Both vendors here spawn MCP servers,
    // so that is not a theoretical shape. `exit` therefore starts a bounded
    // drain, after which the pipes are dropped and whatever arrived is the
    // answer. Without this a `--check` can hang forever, and rungraph exits
    // via process.exitCode rather than process.exit, so the hang is the whole
    // command.
    const drop = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      drop();
      done({ code: 1, stdout, stderr, spawnError: false, timedOut: true });
    }, timeoutMs);
    let drain;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => done({ code: 1, stdout, stderr: err.message, spawnError: true, timedOut: false }));
    child.on('exit', (code) => {
      drain = setTimeout(() => {
        drop();
        done({ code: code ?? 1, stdout, stderr, spawnError: false, timedOut: false });
      }, DRAIN_MS);
    });
    child.on('close', (code) => {
      clearTimeout(drain);
      done({ code: code ?? 1, stdout, stderr, spawnError: false, timedOut: false });
    });
    if (stdin !== null) {
      child.stdin.on('error', () => {
        /* the vendor closed stdin early — its output is still the verdict */
      });
      child.stdin.end(stdin);
    }
  });
}

/** stdout and stderr together. Load-bearing: see the claude entry. */
function bothStreams(res) {
  return `${res.stdout}\n${res.stderr}`;
}

/**
 * The first JSON array in `text`, or null. Tolerant of a leading banner and a
 * trailing one, which is what a vendor writing a warning around its own
 * output looks like. Null rather than a throw: "could not read this" is a
 * verdict the check reports, not an exception it dies on.
 */
function parseJsonArray(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('[');
  if (start === -1) return null;
  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      /* try the next closing bracket in */
    }
  }
  return null;
}

/* ---------------------------------------------------------- paste blocks */

function jsonBlock(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * TOML for codex. Hand-emitted because the package has zero runtime
 * dependencies. `JSON.stringify` is used for the scalars deliberately: TOML
 * basic strings and JSON strings share their escape grammar for quotes,
 * backslashes and control characters, which covers every byte a filesystem
 * path or an argv word can hold here.
 */
function tomlBlock(launch) {
  const args = launch.args.map((a) => JSON.stringify(a)).join(', ');
  return `[mcp_servers.rungraph]\ncommand = ${JSON.stringify(launch.command)}\nargs = [${args}]\n`;
}

/**
 * YAML for hermes. Every scalar is double-quoted: a YAML double-quoted scalar
 * shares JSON's escape grammar, so `JSON.stringify` cannot emit something the
 * parser will read as a different type (a path of digits, a bare `y`, a value
 * with a colon in it).
 */
function yamlBlock(launch) {
  const args = launch.args.map((a) => `      - ${JSON.stringify(a)}\n`).join('');
  return (
    'mcp_servers:\n' +
    '  rungraph:\n' +
    `    command: ${JSON.stringify(launch.command)}\n` +
    '    args:\n' +
    args +
    '    enabled: true\n'
  );
}

/* ------------------------------------------------------------- the table */

/**
 * One entry per provider. Keyed to ADAPTERS by `adapter`, because an
 * adapter's runs on disk are the ENTIRE detection mechanism — rungraph knows
 * a provider is on this machine because it has read that provider's
 * transcripts, not because it found a binary. (A binary probe would name an
 * agent the user installed and never used, and miss one they uninstalled but
 * whose runs they still ask about.)
 */
export const CLIENTS = [
  {
    name: 'claude',
    label: 'Claude Code',
    adapter: 'claude-code',
    tier: 'delegate',
    bin: 'claude',
    // The one client with configuration scopes. Default 'user': rungraph is a
    // machine-wide tool, and per-project registration would have to be
    // repeated in every repo forever.
    scopes: ['user', 'project', 'local'],
    defaultScope: 'user',
    installArgv: (launch, { scope = 'user' } = {}) => [
      'mcp',
      'add',
      '--scope',
      scope,
      'rungraph',
      '--',
      launch.command,
      ...launch.args,
    ],
    installStdin: null,
    // `claude mcp add` refuses a duplicate: exit 1, and the message
    // `MCP server rungraph already exists in user config` on STDERR with a
    // COMPLETELY EMPTY stdout. Reading only stdout sees nothing at all, which
    // is why the verdict is computed over both streams.
    //
    // Probed caveat this cannot see, recorded rather than papered over: the
    // duplicate check is PER SCOPE. A pre-existing local-scope `rungraph`
    // (an old checkout path, say) does not make a user-scope add report
    // `already`, and local shadows user at load time.
    verdict({ code, stdout, stderr, spawnError }) {
      const output = `${stdout}\n${stderr}`;
      if (code === 0 && !spawnError) return 'installed';
      return /already exists|already configured/i.test(output) ? 'already' : 'failed';
    },
    listArgv: ['mcp', 'list'],
    // HEALTH-CHECKS as it lists — one of the two that do, with opencode.
    // Against a deliberately broken command it printed
    //   broken: /nonexistent/binary  - ✘ Failed to connect — ENOENT: …
    // and still EXITED 0. So the exit code says only "the listing ran"; the
    // verdict lives in the per-line text.
    //
    // That is what makes `broken` mean something stronger here than it does
    // for codex or hermes: those two can only report an entry the user
    // DISABLED, while this one reports a server that cannot start.
    //
    // The fail glyph is ✘ (U+2718), NOT the ✗ (U+2717) an earlier version of
    // this matcher tested for — that matcher passed only by also matching the
    // word "failed", which would have flagged any command path containing it.
    // Both glyphs are accepted now, and the word test is narrowed to the exact
    // phrase claude prints.
    isRegistered(output) {
      const line = output.split('\n').find((l) => /^\s*rungraph:/.test(l));
      if (!line) return { ok: false, state: 'absent', detail: 'not registered' };
      const failed = /[✘✗]/.test(line) || /failed to connect/i.test(line);
      return failed
        ? { ok: false, state: 'broken', detail: 'registered, but claude cannot connect to it' }
        : { ok: true, state: 'ok', detail: 'registered and connected' };
    },
    // `claude mcp add` REFUSES a duplicate, which means re-running `--install`
    // can never REPAIR a registration that has gone stale — the exact
    // aftermath of the npx-cache path this whole change exists to stop
    // writing. `--check` would print `✖ registered, but claude cannot connect
    // to it`, offer `--install --client claude`, and that command would say
    // "already registered" and change nothing, forever. Removal first is the
    // only route out, so the route is a table field and gets printed.
    reregister: (scope = 'user') => `claude mcp remove rungraph -s ${scope}`,
    // Scope-aware, because claude's three scopes write three DIFFERENT places
    // and a fallback block that names the wrong one is a wrong answer:
    // `user` → $CLAUDE_CONFIG_DIR/.claude.json at the top level, `project` →
    // <cwd>/.mcp.json (a file that belongs in the repo), `local` → the same
    // .claude.json but nested under projects[<cwd>].
    configPath: ({ scope = 'user' } = {}) =>
      scope === 'project'
        ? join(process.cwd(), '.mcp.json')
        : join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'),
    configBlock(launch, { scope = 'user' } = {}) {
      const server = { rungraph: { command: launch.command, args: launch.args } };
      const value =
        scope === 'local'
          ? { projects: { [process.cwd()]: { mcpServers: server } } }
          : { mcpServers: server };
      return { format: 'json', value, text: jsonBlock(value) };
    },
    restartHint: 'restart Claude Code',
    instructionsFile: 'CLAUDE.md',
  },

  {
    name: 'codex',
    label: 'Codex CLI',
    adapter: 'codex',
    tier: 'delegate',
    bin: 'codex',
    installArgv: (launch) => ['mcp', 'add', 'rungraph', '--', launch.command, ...launch.args],
    installStdin: null,
    // `--` is optional in 0.144.4 but always emitted: without it, a
    // flag-looking token in the server command is swallowed by codex's own
    // parser instead of reaching the server.
    //
    // Codex's add is IDEMPOTENT and SILENT about it — three consecutive adds
    // each exited 0 and each printed `Added global MCP server 'rungraph'.`,
    // and re-adding the same NAME with different args replaces the entry
    // wholesale with the identical message and no warning. "Already
    // installed" is therefore unobservable from the add, so it is read from
    // `codex mcp list --json` BEFORE adding (`probeBefore`) — the reason this
    // field exists at all.
    probeBefore: true,
    // The re-add REPLACES the entry rather than refusing it, so an `already`
    // here still means the config was rewritten with the current launch
    // command. Reported, because a rewrite the user is not told about is the
    // silent half of D3 in the other direction.
    addOverwrites: true,
    verdict({ code, spawnError, timedOut, before }) {
      if (spawnError || timedOut || code !== 0) return 'failed';
      return before?.ok ? 'already' : 'installed';
    },
    listArgv: ['mcp', 'list', '--json'],
    // The human table is fixed-width, truncated, and space-joins argv — an
    // argument containing a space is unrecoverable from it. `--json` is a bare
    // ARRAY, and an EMPTY config prints `[]` with exit 0, which must read as
    // "nothing registered" and never as an error.
    //
    // The ONE client that reads a stream rather than both. Every other entry
    // scrapes text, where concatenating stdout and stderr can only help; here
    // it can only hurt, because codex writes diagnostics to stderr alongside a
    // perfectly good listing and a bracket in one of them would derail the
    // parse. `res.stdout` is the listing; the concatenated `output` is the
    // fallback for a codex that ever moves it.
    isRegistered(output, res) {
      const list = parseJsonArray(res?.stdout) ?? parseJsonArray(output);
      if (!list) {
        return { ok: false, state: 'absent', detail: 'could not read `codex mcp list --json`' };
      }
      const entry = list.find((s) => s?.name === 'rungraph');
      if (!entry) return { ok: false, state: 'absent', detail: 'not registered' };
      // A registered-but-disabled server is still in the array. Presence alone
      // is not the answer the check is being asked for.
      if (entry.enabled === false) {
        return { ok: false, state: 'broken', detail: `registered but disabled${entry.disabled_reason ? ` — ${entry.disabled_reason}` : ''}` };
      }
      // codex does not health-check as it lists, so "connected" is a claim
      // this output cannot support and is deliberately not made.
      return { ok: true, state: 'ok', detail: 'registered', transport: entry.transport ?? null };
    },
    configPath: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
    configBlock(launch) {
      return {
        format: 'toml',
        value: { mcp_servers: { rungraph: { command: launch.command, args: launch.args } } },
        text: tomlBlock(launch),
      };
    },
    restartHint: 'start a new codex session',
    instructionsFile: 'AGENTS.md',
  },

  {
    name: 'hermes',
    label: 'Hermes Agent',
    adapter: 'hermes',
    tier: 'delegate',
    bin: 'hermes',
    // `--args` is an argparse REMAINDER and its own help says it "must be the
    // last option", so it goes last and swallows the rest.
    installArgv: (launch) => ['mcp', 'add', 'rungraph', '--command', launch.command, '--args', ...launch.args],
    // THE reason `installStdin` is a table field rather than a special case
    // buried in a function.
    //
    // `hermes mcp add` is discovery-first and interactive: it connects to the
    // server, lists its tools, and asks `Enable all 7 tools? [Y/n/select]:`.
    // With stdin closed it prints `Cancelled.`, writes NOTHING, and EXITS 0 —
    // which is exactly what the README's published one-liner did every time an
    // agent or a script ran it, with no failure signal anywhere.
    //
    // TWO `y`s, not one. On a re-add hermes asks `Server 'rungraph' already
    // exists. Overwrite? [y/N]:` FIRST, which eats the single `y`; the tools
    // prompt then hits EOF and the whole run cancels silently. On a first add
    // the second `y` is simply left unread. `y\ny\n` is therefore the only
    // input that works in both states.
    installStdin: 'y\ny\n',
    probeAfter: true,
    // The overwrite prompt exists precisely because the re-add rewrites the
    // entry. `hermes mcp list` truncates the command out of its table, so
    // rungraph cannot diff what changed — only report that it did.
    addOverwrites: true,
    // EVERY observed path exits 0 — cancelled, saved, duplicate-cancelled, and
    // even failed-to-connect. The exit code proves nothing and is not read.
    //
    // `✓ Saved` alone is a FALSE POSITIVE: a server that fails to connect and
    // is saved anyway also prints `✓ Saved 'x' to config (disabled)`. The
    // discriminator is the `(N/N tools enabled)` suffix, which only the
    // fully-working path emits — corroborated by re-reading `mcp list`.
    verdict({ stdout, stderr, spawnError, timedOut, after }) {
      if (spawnError || timedOut) return 'failed';
      const output = `${stdout}\n${stderr}`;
      // A NONZERO count. `(0/0 tools enabled)` would mean hermes connected to
      // something that offered no tools, which is not an install worth
      // reporting as one — and hermes' own no-tools prompt defaults to YES on
      // EOF, so that path can be reached by the very stdin this feeds.
      const saved = Number(/\((\d+)\/\d+ tools enabled\)/.exec(output)?.[1] ?? 0) > 0;
      const overwrote = /already exists\.\s*Overwrite\?/i.test(output);
      if (saved || after?.ok) return overwrote ? 'already' : 'installed';
      return 'failed';
    },
    listArgv: ['mcp', 'list'],
    // No `--json` exists (`hermes mcp list --help` lists only `-h`). The table
    // truncates the Transport column at ~26 chars, so the registered command
    // is not even visible in it — only the Name column is reliable. Absence
    // prints `No MCP servers configured.` and also exits 0.
    isRegistered(output) {
      const line = output.split('\n').find((l) => /^\s*rungraph\s/.test(l));
      if (!line) return { ok: false, state: 'absent', detail: 'not registered' };
      if (/✗\s*disabled/.test(line)) {
        return { ok: false, state: 'broken', detail: 'registered but disabled — `hermes mcp test rungraph`' };
      }
      return { ok: true, state: 'ok', detail: 'registered' };
    },
    configPath: () => join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml'),
    configBlock(launch) {
      return {
        format: 'yaml',
        value: { mcp_servers: { rungraph: { command: launch.command, args: launch.args, enabled: true } } },
        text: yamlBlock(launch),
      };
    },
    // Hermes DOES print its own, verbatim `Start a new session to use these
    // tools.`, on the line after the save — and the user never sees it, because
    // rungraph captures stdout to read the verdict out of it. Saying nothing
    // here would mean the one client whose hint is best is the only client
    // with no hint at all, so rungraph repeats what hermes said.
    restartHint: 'start a new hermes session',
    instructionsFile: null,
  },

  {
    name: 'opencode',
    label: 'opencode',
    adapter: 'opencode',
    tier: 'delegate',
    bin: 'opencode',
    // **This entry contradicts the spec it was written from, on evidence.**
    //
    // `2026-08-20-mcp-install-loop-design.md` records opencode as the paste
    // tier because "there remains no flag for a local stdio command — that
    // value is prompted for interactively". Half of that is right: `mcp add
    // --help` lists only `--url`, `--env` and `--header`, and there is no
    // flag. But there is an UNDOCUMENTED `--` passthrough, and it is fully
    // non-interactive. Probed on 2026-08-21 against opencode 1.18.19, three
    // times, into a throwaway XDG_CONFIG_HOME:
    //
    //   opencode mcp add rungraph -- npx -y rungraph mcp
    //   → exit 0, reads nothing from stdin, writes
    //     {"type":"local","command":["npx","-y","rungraph","mcp"]}
    //
    // It is invisible in `--help`; the only in-CLI evidence is the error
    // string "Provide either --url <url> or a command after --". So the
    // previous docblock's reason was wrong, and so was its replacement.
    //
    // The second reason for the paste tier is gone too. rungraph refused to
    // WRITE this config because opencode's files are JSONC and rungraph has
    // no JSONC parser — but opencode does, and uses it: adding into a file
    // holding `// a comment rungraph must never destroy` left that comment in
    // place. Delegating means the vendor's own JSONC-aware writer touches the
    // vendor's own file, which was the goal all along.
    //
    // If a future opencode drops `--`, this degrades exactly as designed: the
    // add fails and `installOne` prints the paste block that every client
    // carries. Reverting to the spec's letter is one word — `tier: 'paste'`.
    //
    // `--` is MANDATORY (bare positionals exit 1) and the NAME is what selects
    // the non-interactive path; the nameless form prompts and HANGS even with
    // stdin closed, so it is never used here.
    installArgv: (launch) => ['mcp', 'add', 'rungraph', '--', launch.command, ...launch.args],
    installStdin: null,
    // Idempotent and silent about it, like codex: a repeat add exits 0, prints
    // the same line, and replaces the entry with no warning and no --force.
    // "Already" is unobservable from the add, so it is read before — and
    // `opencode mcp list` shows the command but not in a form worth diffing,
    // so the rewrite is reported rather than compared.
    probeBefore: true,
    addOverwrites: true,
    verdict({ code, spawnError, timedOut, before }) {
      if (spawnError || timedOut || code !== 0) return 'failed';
      return before?.ok ? 'already' : 'installed';
    },
    listArgv: ['mcp', 'list'],
    // The other client that reports a `broken` server rather than merely a
    // disabled one, and it earns it the same way claude does:
    // `opencode mcp list` genuinely spawns each local server and
    // completes an MCP handshake. It exits 0 in all three states — registered,
    // absent, and failed-to-spawn — so the exit code is not read.
    //
    // No `--json` exists (yargs strict: `--json` exits 1). The status word is
    // wrapped in a dim-grey ANSI run that sits BETWEEN the name and the word,
    // so `/✓ rungraph connected/` does NOT match the raw bytes and the escapes
    // must be stripped first. Verified with od -c.
    isRegistered(output) {
      const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
      const m = plain.match(/^\s*●\s+([✓✗○])\s+rungraph\s+(\w+)/m);
      if (!m) return { ok: false, state: 'absent', detail: 'not registered' };
      if (m[1] === '✓') return { ok: true, state: 'ok', detail: 'registered and connected' };
      return {
        ok: false,
        state: 'broken',
        detail: m[2] === 'disabled' ? 'registered but disabled' : 'registered, but opencode cannot connect to it',
      };
    },
    // Where a PASTE would go, which is now only the fallback path. The write
    // target of the delegated add is resolved by opencode itself and is not
    // this: it is $XDG_CONFIG_HOME/opencode/opencode.json or …/opencode.jsonc,
    // whichever already exists, defaulting to .json. `OPENCODE_CONFIG` is
    // honoured on opencode's READ path but does NOT redirect that write —
    // measured, and the reason the integration test isolates with
    // XDG_CONFIG_HOME instead.
    configPath: () => opencodeConfigCandidates()[0],
    configCandidates: opencodeConfigCandidates,
    configBlock(launch) {
      // The MCP key is `mcp`, NOT `mcpServers`, and `command` is an ARRAY —
      // verified against https://opencode.ai/config.json, where McpLocalConfig
      // requires `type` and `command: string[]`. opencode's own add omits
      // `enabled`, and a missing key means enabled; writing it explicitly is
      // accepted and lists identically.
      const value = {
        mcp: {
          rungraph: { type: 'local', command: [launch.command, ...launch.args], enabled: true },
        },
      };
      return { format: 'json', value, text: jsonBlock(value) };
    },
    notes: [
      'opencode reads AGENTS.md first and CLAUDE.md as a compat path (unless OPENCODE_DISABLE_CLAUDE_CODE ' +
        'is set), so an existing CLAUDE.md line already reaches it',
    ],
    restartHint: 'start a new opencode session',
    instructionsFile: 'AGENTS.md',
  },

  {
    name: 'cursor',
    label: 'Cursor',
    adapter: 'cursor',
    // THE FIRST GENUINE PASTE-TIER CLIENT, and a decision rather than a
    // fallback: `cursor-agent mcp` has `login | list | list-tools | enable |
    // disable` and NO `add` (probed 2026-08-23, cursor-agent 2026.08.11), and
    // rungraph never edits an agent's config file itself — a JSON-merge path
    // with backup semantics would exist for one client only, and the README
    // promises it does not. The IDE's own one-click install is the deeplink
    // below; the config file is plain JSON read by BOTH surfaces (the IDE
    // file-watches it), so one paste covers the IDE and the CLI.
    tier: 'paste',
    bin: 'cursor-agent',
    pasteReason: '`cursor-agent mcp` has no `add`; Cursor reads ~/.cursor/mcp.json directly',
    installStdin: null,
    // Never reached: installOne() short-circuits the paste tier before any
    // delegation. Present because the table's shape test requires one on
    // every entry, and a delegate-tier future (if Cursor ships `mcp add`)
    // would replace it rather than add it.
    verdict() {
      return 'failed';
    },
    listArgv: ['mcp', 'list'],
    // VERIFIED VERBATIM for the absent case: with nothing configured,
    // `cursor-agent mcp list` prints
    //   No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)
    // and exits 0. The healthy-line format is UNVERIFIED (nothing was
    // registered on the probe machine — spec §16 item 11), so the match is
    // deliberately loose: a line naming rungraph as a word. Whether listing
    // handshakes with registered servers (and so needs the breadcrumb guard)
    // is unverified too; runVendor's RUNGRAPH_NO_BREADCRUMB covers it either way.
    isRegistered(output) {
      const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
      // The server NAME at the start of a line (after any bullet, glyph or
      // indent), and nothing else: `\brungraph\b` would also match a path
      // in another server's args (`…/GitHub/rungraph`) or a server called
      // `rungraph-other`, and report the loop usable when it is not — a false
      // positive on the one question --check exists to answer.
      const line = plain.split('\n').find((l) => /^[\s●○•*✓✔✗✘-]*rungraph(?![\w.\/-])/.test(l));
      if (!line) return { ok: false, state: 'absent', detail: 'not registered' };
      if (/\bdisabled\b/i.test(line)) {
        return { ok: false, state: 'broken', detail: 'registered but disabled — `cursor-agent mcp enable rungraph`' };
      }
      return { ok: true, state: 'ok', detail: 'registered' };
    },
    // `~/.cursor/mcp.json` — the one file BOTH surfaces are verified to read
    // (the IDE file-watches it; `cursor-agent mcp list` names it). Not the
    // CLI's `$XDG_CONFIG_HOME/cursor` config-dir resolution: with
    // XDG_CONFIG_HOME exported (common on Linux) that path would be one the
    // IDE never looks at, and the "one paste covers both" promise would be
    // false with nothing pointing at the cause. A project-level
    // `<repo>/.cursor/mcp.json` works too and is named in the notes.
    configPath: () => join(homedir(), '.cursor', 'mcp.json'),
    configBlock(launch) {
      const value = { mcpServers: { rungraph: { command: launch.command, args: launch.args } } };
      return { format: 'json', value, text: jsonBlock(value) };
    },
    // `cursor://anysphere.cursor-deeplink/mcp/install?name=<n>&config=<base64 JSON>`
    // — a real route in 3.16.29's deeplink router; it opens Cursor's own
    // install confirmation. rungraph prints it and never invokes it.
    //
    // Percent-encoded, because it is a QUERY value: base64 can contain `+`,
    // which a query parser turns into a space (the absolute-path launch case
    // produces one for any home directory with a non-ASCII character in it),
    // and `=` padding. `encodeURIComponent` keeps both intact through any
    // `URLSearchParams`-style reader. Whether Cursor's handler decodes a
    // payload holding non-ASCII bytes is unverified; the paste block beside
    // the link is the path that needs no handler.
    deeplink: (launch) =>
      'cursor://anysphere.cursor-deeplink/mcp/install?name=rungraph&config=' +
      encodeURIComponent(
        Buffer.from(JSON.stringify({ command: launch.command, args: launch.args }), 'utf8').toString('base64'),
      ),
    notes: [
      'Cursor setup is one paste (or one click on the deeplink) because `cursor-agent mcp` has no `add` — a vendor fact, not a rungraph limitation',
      'a project-level <repo>/.cursor/mcp.json with the same block works too; both the IDE and cursor-agent read it',
    ],
    restartHint: 'reload the Cursor window, or start a new cursor-agent session',
    // Cursor documents AGENTS.md support; unverified on this build (spec §16
    // item 15). If it turns out not to, this becomes `.cursor/rules/` — a
    // one-string change.
    instructionsFile: 'AGENTS.md',
  },
];


/**
 * Where opencode looks for its config, most specific first. `OPENCODE_CONFIG`
 * names the file outright.
 */
function opencodeConfigCandidates() {
  const explicit = process.env.OPENCODE_CONFIG;
  if (explicit) return [explicit];
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
  return [join(dir, 'opencode.jsonc'), join(dir, 'opencode.json'), join(dir, 'config.json')];
}

/** Every `--client` value the CLI accepts, plus the multi-client keyword. */
export const CLIENT_NAMES = CLIENTS.map((c) => c.name);
export const ALL_CLIENTS = 'all';

export function clientByName(name) {
  return CLIENTS.find((c) => c.name === name) ?? null;
}

/**
 * Which providers this machine actually uses, read off the run index.
 *
 * Disk-based on purpose, and its one accepted limitation: a freshly installed
 * agent with no runs yet is not named. `--client all` covers that, and what
 * this returns is what rungraph can prove.
 *
 * @param {{ runs: { adapter: string }[] }} scanResult
 * @returns {string[]} client names, in table order
 */
export function detectClients(scanResult) {
  const seen = new Set((scanResult?.runs ?? []).map((r) => r.adapter));
  return CLIENTS.filter((c) => seen.has(c.adapter)).map((c) => c.name);
}

/* ------------------------------------------------------------ breadcrumb */

/**
 * The persistent state dir. `RUNGRAPH_STATE_DIR` is read LAZILY per call,
 * mirroring `registryDir()` exactly, so tests (and unusual setups) can
 * redirect it no matter when the variable is set relative to import order.
 *
 * It explicitly may NOT reuse the port registry's directory: that one lives
 * under `tmpdir()` and would forget across a reboot, turning the `serve`
 * nudge back on for a user who is already set up.
 */
export function stateDir() {
  return process.env.RUNGRAPH_STATE_DIR || join(homedir(), '.rungraph');
}

export function breadcrumbPath() {
  return join(stateDir(), 'mcp-connected.json');
}

/**
 * Where a breadcrumb lands when RUNGRAPH_STATE_DIR is not visible — which is
 * not hypothetical: see withoutBreadcrumbSideEffects.
 */
function defaultBreadcrumbPath() {
  return join(homedir(), '.rungraph', 'mcp-connected.json');
}

/**
 * Run `fn`, then put the breadcrumb back exactly as it was.
 *
 * `--check` and `--install` both make agents connect to rungraph on purpose:
 * `claude mcp list` and `opencode mcp list` health-check by handshaking with
 * every registered server, and `hermes mcp add` connects to enumerate tools.
 * Each of those handshakes reaches `writeBreadcrumb`, and a check that leaves
 * behind "an agent connected" is a check manufacturing the evidence it exists
 * to read.
 *
 * `runVendor`'s RUNGRAPH_NO_BREADCRUMB stops most of that at the source, and
 * is the cheaper guard. It is NOT sufficient, and the reason is worth
 * recording: an MCP client is not obliged to hand its own environment to the
 * server it spawns, and opencode's does not. Measured — a health check through
 * `opencode mcp list` wrote a breadcrumb naming client "mcp" version "0.1.0"
 * (its SDK's default clientInfo) with both RUNGRAPH_NO_BREADCRUMB and
 * RUNGRAPH_STATE_DIR set on the process that started it. Since the child could
 * not see RUNGRAPH_STATE_DIR either, it wrote to the DEFAULT path rather than
 * the configured one — so both are restored here.
 *
 * Restore rather than prevent, because prevention needs the vendor's
 * cooperation and this does not.
 */
export async function withoutBreadcrumbSideEffects(fn) {
  const paths = [...new Set([breadcrumbPath(), defaultBreadcrumbPath()])];
  const before = await Promise.all(
    paths.map(async (path) => ({ path, text: await readFile(path, 'utf8').catch(() => null) })),
  );
  try {
    return await fn();
  } finally {
    for (const { path, text } of before) {
      try {
        const now = await readFile(path, 'utf8').catch(() => null);
        if (now === text) continue;
        if (text === null) {
          await rm(path, { force: true });
          // The child had to mkdir the state dir to write there. Leaving an
          // empty ~/.rungraph behind is not damage, but "exactly as found" is
          // a cheaper thing to reason about than "almost exactly as found".
          // rmdir, not rm: it must fail (harmlessly) when the directory
          // holds anything else, and never remove a state dir that was there.
          await rmdir(dirname(path)).catch(() => {});
        } else {
          await writeFile(path, text);
        }
      } catch {
        /* best effort: a breadcrumb that cannot be restored is a nudge that
           goes quiet one run early, never a failed command */
      }
    }
  }
}

/** The recorded connection, or null when no agent has ever handshaked. */
export async function readBreadcrumb() {
  try {
    const obj = JSON.parse(await readFile(breadcrumbPath(), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Record that an agent has actually spoken to the MCP server.
 *
 * Written on the `initialize` REQUEST, not at process start, and two things
 * fall out of that choice for free: a spawn that dies before handshaking does
 * not count as a working install, and `--check`'s own handshake self-excludes
 * by the `clientInfo.name` it already sends — so no environment-variable flag
 * is needed to stop the check from manufacturing the evidence it is supposed
 * to be reading.
 *
 * Never throws. A breadcrumb that cannot be written is a nudge that keeps
 * appearing, which is a great deal better than a handshake that fails.
 *
 * @returns {Promise<object|null>} the record written, or null if it was not
 */
export async function writeBreadcrumb(clientInfo, now = new Date()) {
  // Set by runVendor on every vendor CLI rungraph spawns; see the note there.
  if (process.env.RUNGRAPH_NO_BREADCRUMB === '1') return null;
  const client = typeof clientInfo?.name === 'string' && clientInfo.name ? clientInfo.name : 'unknown';
  if (client === SELF_CLIENT) return null;
  const record = {
    client,
    ...(typeof clientInfo?.version === 'string' ? { clientVersion: clientInfo.version } : {}),
    at: now.toISOString(),
  };
  try {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await writeFile(breadcrumbPath(), JSON.stringify(record) + '\n');
    return record;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- read-back helper */

/**
 * Ask one client's CLI whether rungraph is registered with it.
 *
 * A missing binary is its own answer — "detected but the CLI is not on PATH"
 * is the case `--check` could not previously distinguish, and it is advisory:
 * runs on disk prove the provider WAS used, and the binary may since have
 * been removed.
 */
export async function readRegistration(client, opts = {}) {
  const res = await runVendor(client.bin, client.listArgv, { timeoutMs: opts.timeoutMs ?? 60_000 });
  if (res.spawnError) {
    return {
      ok: false,
      state: 'absent',
      detail: `the \`${client.bin}\` CLI is not on PATH`,
      missingBin: true,
      // detected ≠ installed: runs on disk prove the provider WAS used, and
      // the binary may since have gone. The remedy cannot be "install into
      // it", which would fail the same way — but it must not be nothing
      // either, or a machine where EVERY detected CLI has gone fails the
      // check with no printed way forward.
      fix: `Install the \`${client.bin}\` CLI, or run \`npx rungraph mcp --install --client ${client.name}\` to print the block to paste.`,
    };
  }
  if (res.timedOut) {
    return { ok: false, state: 'absent', detail: `\`${client.bin} ${client.listArgv.join(' ')}\` did not answer in time` };
  }
  try {
    return client.isRegistered(bothStreams(res), res);
  } catch (err) {
    // Same discipline as the parsers: a vendor that changes its output shape
    // costs one unreadable row, never the whole command. `--check` reporting
    // "could not read" is a usable answer; a stack trace is not.
    return { ok: false, state: 'absent', detail: `could not read \`${client.bin} ${client.listArgv.join(' ')}\`: ${String(err?.message ?? err)}` };
  }
}
