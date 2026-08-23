import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/scanner.js';
import {
  ALL_CLIENTS,
  CLIENTS,
  CLIENT_NAMES,
  breadcrumbPath,
  SELF_CLIENT,
  clientByName,
  detectClients,
  resolveLaunch,
  withoutBreadcrumbSideEffects,
  writeBreadcrumb,
} from '../src/clients.js';
import {
  pinFixtureMtimes,
  CLEAN_RUN_ID,
  CODEX_FIXTURE_ROOT,
  FIXTURE_ROOT,
  OPENCODE_FIXTURE_ROOT,
} from './helpers.js';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'rungraph.js');

let tmp;
/**
 * The isolation contract for this whole file, and it is stricter than the rest
 * of the suite's because these tests drive real vendor CLIs:
 *
 * - RUNGRAPH_STATE_DIR keeps the §4 breadcrumb out of the developer's own
 *   ~/.rungraph, where a stray write would silence their real `serve` nudge.
 * - RUNGRAPH_PORT_DIR keeps the dashboard check from finding their servers.
 * - The four adapter roots pin detection to the fixture corpus, so "detected"
 *   is exactly {claude, codex} no matter what the machine actually runs.
 * - **Every vendor config home is redirected into the sandbox by DEFAULT**,
 *   not only in the integration tests that mean to write. That is fail-safe
 *   rather than belt-and-braces: this file drives real `mcp add` commands, and
 *   one test that reaches a real client without meaning to edits the
 *   developer's own agent config. It happened once while this file was being
 *   written — a `--install --client opencode` case that only meant to read
 *   the JSON report delegated for real and registered rungraph in
 *   ~/.config/opencode/opencode.jsonc.
 *
 *   Note WHICH variable isolates opencode: XDG_CONFIG_HOME, not
 *   OPENCODE_CONFIG. Measured — opencode honours OPENCODE_CONFIG on its READ
 *   path only, and `mcp add` resolves its write target from
 *   $XDG_CONFIG_HOME/opencode independently. Both are set here; only the
 *   first one protects anything.
 *
 * - Every integration test below additionally redirects that vendor's config
 *   home to a FRESH dir, and asserts against the file IT wrote.
 */
const baseEnv = () => ({
  ...process.env,
  RUNGRAPH_CLAUDE_PROJECTS: FIXTURE_ROOT,
  RUNGRAPH_CODEX_SESSIONS: CODEX_FIXTURE_ROOT,
  RUNGRAPH_HERMES_HOME: '',
  RUNGRAPH_OPENCODE_HOME: '',
  RUNGRAPH_CURSOR_GLOBAL_STORAGE: '',
  RUNGRAPH_CURSOR_CLI_HOME: '',
  RUNGRAPH_STATE_DIR: join(tmp, 'state'),
  RUNGRAPH_PORT_DIR: join(tmp, 'ports'),
  ...vendorSandbox(),
});

/** Every vendor's config home, pointed at the sandbox. */
const vendorSandbox = () => ({
  CLAUDE_CONFIG_DIR: join(tmp, 'vendor', 'claude'),
  CODEX_HOME: join(tmp, 'vendor', 'codex'),
  HERMES_HOME: join(tmp, 'vendor', 'hermes'),
  XDG_CONFIG_HOME: join(tmp, 'vendor', 'xdg'),
  OPENCODE_CONFIG: join(tmp, 'vendor', 'xdg', 'opencode', 'opencode.json'),
});

beforeAll(async () => {
  await pinFixtureMtimes();
  tmp = await mkdtemp(join(tmpdir(), 'rg-clients-'));
  await mkdir(join(tmp, 'state'), { recursive: true });
  await mkdir(join(tmp, 'ports'), { recursive: true });
  // codex does NOT create its config home and exits 1 on a missing one, so
  // every sandbox home is made up front rather than lazily.
  for (const dir of Object.values(vendorSandbox())) {
    await mkdir(dir.endsWith('.json') ? dirname(dir) : dir, { recursive: true });
  }
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** Is this vendor CLI actually here? The gate for every integration test. */
function onPath(bin) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const st = statSync(join(dir, bin));
      if (st.isFile() && st.mode & 0o111) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the client table', () => {
  // THE test that matters. rungraph ships four adapters and should ship four
  // clients; nothing structural enforced that before, which is why the gap
  // opened silently as adapters three and four landed. Whoever lands a fifth
  // adapter cannot land it without deciding how that provider installs.
  it('every adapter in ADAPTERS has a CLIENTS entry', () => {
    const clients = new Set(CLIENTS.map((c) => c.adapter));
    for (const adapter of ADAPTERS) {
      expect(clients, `no CLIENTS entry for the "${adapter.name}" adapter`).toContain(adapter.name);
    }
  });

  it('every CLIENTS entry names a real adapter, and no name repeats', () => {
    const adapters = new Set(ADAPTERS.map((a) => a.name));
    for (const c of CLIENTS) expect(adapters).toContain(c.adapter);
    expect(new Set(CLIENT_NAMES).size).toBe(CLIENTS.length);
  });

  it('every entry declares the fields --install, --check and the nudge read', async () => {
    const launch = { command: 'npx', args: ['-y', 'rungraph', 'mcp'], via: 'npx-cache' };
    for (const c of CLIENTS) {
      expect(['delegate', 'paste']).toContain(c.tier);
      expect(typeof c.bin).toBe('string');
      expect(typeof c.verdict).toBe('function');
      expect(Array.isArray(c.listArgv)).toBe(true);
      expect(typeof c.isRegistered).toBe('function');

      // Present for EVERY client, not only paste-tier ones, because it is
      // also the fallback a failed delegation prints.
      const block = c.configBlock(launch);
      expect(block.text).toContain('rungraph');
      expect(typeof c.configPath()).toBe('string');

      // installStdin is a table field for exactly one vendor's sake. Its
      // presence here is what keeps that quirk out of a function body.
      expect(c.installStdin === null || typeof c.installStdin === 'string').toBe(true);
      if (c.tier === 'delegate') {
        expect(c.installArgv(launch, { scope: 'user' })).toContain('rungraph');
      }
    }
  });

  it('every client can read "not registered" out of an empty listing', () => {
    for (const c of CLIENTS) {
      const verdict = c.isRegistered('');
      expect(verdict.ok, `${c.name} read an empty listing as registered`).toBe(false);
      expect(verdict.state).toBe('absent');
    }
  });

  // Precision over recall, applied to the read-back: a listing that names
  // rungraph and says it failed must not read as a working install.
  it('claude reads its health-check verdict, glyph and all', () => {
    const claude = clientByName('claude');
    const good = 'rungraph: /x/node /y/rungraph.js mcp - ✔ Connected\n';
    // Verbatim from the probe. U+2718, NOT the U+2717 the old matcher tested
    // for — it only ever passed because it ALSO matched the bare word "failed".
    const bad =
      "rungraph: /nonexistent/binary  - ✘ Failed to connect — ENOENT: ENOENT: no such file or directory, posix_spawn '/nonexistent/binary'\n";
    expect(claude.isRegistered(good)).toMatchObject({ ok: true, state: 'ok' });
    expect(claude.isRegistered(bad)).toMatchObject({ ok: false, state: 'broken' });

    // The two fixtures that make each half of that fix DETECTABLE — without
    // them the old `/✗|failed/i` matcher passes this whole test.
    //
    // Glyph without the word: only accepting U+2718 catches this.
    expect(claude.isRegistered('rungraph: /x/node mcp - ✘ Connection closed\n')).toMatchObject({
      state: 'broken',
    });
    // The word inside a healthy line's own command path: narrowing to the
    // exact phrase "failed to connect" is what stops this false flag, and a
    // false flag is the expensive kind — once the markers are not trusted the
    // user is back to reading everything.
    expect(
      claude.isRegistered('rungraph: /Users/x/failed-experiments/node /y/rungraph.js mcp - ✔ Connected\n'),
    ).toMatchObject({ ok: true, state: 'ok' });
  });

  // Precision, on the other axis: a DIFFERENT server whose name merely starts
  // with ours must not be read as ours, on any of the four.
  it('no client mistakes a "rungraph-dev" server for rungraph', () => {
    expect(clientByName('claude').isRegistered('rungraph-dev: /x/node mcp - ✔ Connected\n').ok).toBe(false);
    expect(clientByName('codex').isRegistered('[{"name":"rungraph-dev","enabled":true}]').ok).toBe(false);
    expect(clientByName('hermes').isRegistered('  rungraph-dev     /x...   all   ✓ enabled\n').ok).toBe(false);
    expect(clientByName('opencode').isRegistered('●  ✓ rungraph-dev connected\n').ok).toBe(false);
  });

  it('codex reads its JSON array, and an empty one is not an error', () => {
    const codex = clientByName('codex');
    expect(codex.isRegistered('[]')).toMatchObject({ ok: false, state: 'absent' });
    expect(codex.isRegistered('[{"name":"rungraph","enabled":true}]')).toMatchObject({ ok: true });
    // A registered-but-disabled server is still in the array; presence alone
    // is not the answer the check is being asked for.
    expect(
      codex.isRegistered('[{"name":"rungraph","enabled":false,"disabled_reason":"nope"}]'),
    ).toMatchObject({ ok: false, state: 'broken' });
    // codex writes diagnostics to stderr alongside a perfectly good listing,
    // and readRegistration hands both streams over as one string. A bracket in
    // the noise on either side must not derail the parse.
    expect(codex.isRegistered('WARNING: something\n[{"name":"rungraph","enabled":true}]\n')).toMatchObject({
      ok: true,
    });
    expect(
      codex.isRegistered('[{"name":"rungraph","enabled":true}]\nwarning: check [this]\n'),
    ).toMatchObject({ ok: true });
    expect(codex.isRegistered('not json at all')).toMatchObject({ ok: false, state: 'absent' });
    // stdout wins when it is present: it is the listing, and the concatenated
    // text is only the fallback for a codex that ever moves it.
    expect(
      codex.isRegistered('noise [ ]\n[]', { stdout: '[{"name":"rungraph","enabled":true}]', stderr: 'noise [ ]' }),
    ).toMatchObject({ ok: true });
  });

  it('opencode reads through the ANSI its status word is wrapped in', () => {
    const oc = clientByName('opencode');
    // Verified with od -c: the escape sits BETWEEN the name and the status, so
    // /✓ rungraph connected/ does NOT match the raw bytes.
    const raw = '┌  MCP Servers\n│\n●  ✓ rungraph \u001b[90mconnected\n│      npx -y rungraph mcp\n';
    expect(oc.isRegistered(raw)).toMatchObject({ ok: true, state: 'ok' });
    expect(oc.isRegistered('●  ✗ rungraph failed\n')).toMatchObject({ ok: false, state: 'broken' });
    expect(oc.isRegistered('▲  No MCP servers configured\n')).toMatchObject({ ok: false, state: 'absent' });
  });

  // Every observed hermes add path exits 0 — cancelled, saved,
  // duplicate-cancelled, and failed-to-connect — so the exit code proves
  // nothing and the verdict has to come out of the text.
  it('hermes reads its verdict out of stdout, not out of an exit code', () => {
    const hermes = clientByName('hermes');
    const base = { code: 0, stderr: '', spawnError: false, timedOut: false, before: null, after: null };
    const v = (stdout) => hermes.verdict({ ...base, stdout });
    expect(v("  ✓ Saved 'rungraph' to /x/config.yaml (7/7 tools enabled)")).toBe('installed');
    // The re-add asks to overwrite FIRST — which is why installStdin is two ys.
    expect(v("  Server 'rungraph' already exists. Overwrite? [y/N]: \n  ✓ Saved 'rungraph' to /x (7/7 tools enabled)")).toBe('already');
    // What the README's published one-liner did every time it was scripted.
    expect(v('  Enable all 7 tools? [Y/n/select]: \n  Cancelled.')).toBe('failed');
    // `✓ Saved` ALONE is a false positive: a failed connect saved anyway also
    // prints it. The discriminator is the (N/N tools enabled) suffix.
    expect(v("  ✗ Failed to connect: Connection closed\n  ✓ Saved 'rungraph' to config (disabled)")).toBe('failed');
    // …and N must be nonzero, because hermes' no-tools prompt defaults to YES
    // on EOF and can be reached by the very stdin rungraph feeds.
    expect(v("  ✓ Saved 'rungraph' to /x (0/0 tools enabled)")).toBe('failed');
  });

  it('hermes reads its truncated table, and its disabled state', () => {
    const hermes = clientByName('hermes');
    expect(hermes.isRegistered('  rungraph         /Users/x/.local...   all          ✓ enabled\n')).toMatchObject({
      ok: true,
    });
    expect(hermes.isRegistered('  rungraph         /Users/x/.local...   all          ✗ disabled\n')).toMatchObject({
      ok: false,
      state: 'broken',
    });
    expect(hermes.isRegistered('  No MCP servers configured.\n')).toMatchObject({ ok: false });
  });

  it('detectClients reads the run index, not the machine', () => {
    expect(detectClients({ runs: [{ adapter: 'codex' }, { adapter: 'codex' }] })).toEqual(['codex']);
    expect(detectClients({ runs: [{ adapter: 'opencode' }, { adapter: 'claude-code' }] })).toEqual([
      'claude',
      'opencode',
    ]);
    expect(detectClients({ runs: [] })).toEqual([]);
    expect(detectClients(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveLaunch — driven by injected paths, never by this checkout's layout
// ---------------------------------------------------------------------------

describe('resolveLaunch', () => {
  let pathDir;
  beforeAll(async () => {
    pathDir = join(tmp, 'fakepath');
    await mkdir(pathDir, { recursive: true });
    await writeFile(join(pathDir, 'rungraph'), '#!/bin/sh\nexit 0\n');
    await chmod(join(pathDir, 'rungraph'), 0o755);
  });

  it.skipIf(!POSIX)('rungraph on the user own PATH wins, and is the fastest to start', async () => {
    const launch = await resolveLaunch({ pathEnv: pathDir, binPath: '/anywhere/bin/rungraph.js' });
    expect(launch).toMatchObject({ command: 'rungraph', args: ['mcp'], via: 'path' });
  });

  it('an npx-cache bin path gets the npx spelling, which survives eviction', async () => {
    const launch = await resolveLaunch({
      pathEnv: '',
      binPath: '/Users/x/.npm/_npx/a84cd0988ba9c7c1/node_modules/rungraph/bin/rungraph.js',
    });
    expect(launch).toMatchObject({ command: 'npx', args: ['-y', 'rungraph', 'mcp'], via: 'npx-cache' });
  });

  // THE trap, measured rather than reasoned: npx PREPENDS its cache's
  // node_modules/.bin to PATH, so inside `npx rungraph` a naive PATH probe
  // finds `rungraph` and case 1 would write a bare `rungraph` that fails
  // IMMEDIATELY outside the npx process — worse than the bug being fixed.
  it.skipIf(!POSIX)('an npx-injected PATH entry does NOT count as being on PATH', async () => {
    const npxBin = join(tmp, '.npm', '_npx', 'deadbeef', 'node_modules', '.bin');
    await mkdir(npxBin, { recursive: true });
    await writeFile(join(npxBin, 'rungraph'), '#!/bin/sh\nexit 0\n');
    await chmod(join(npxBin, 'rungraph'), 0o755);
    const launch = await resolveLaunch({
      pathEnv: npxBin,
      binPath: '/Users/x/.npm/_npx/deadbeef/node_modules/rungraph/bin/rungraph.js',
    });
    expect(launch.via).toBe('npx-cache');
  });

  it.skipIf(!POSIX)('a project-local node_modules/.bin does not count either', async () => {
    const localBin = join(tmp, 'someproject', 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(join(localBin, 'rungraph'), '#!/bin/sh\nexit 0\n');
    await chmod(join(localBin, 'rungraph'), 0o755);
    // On PATH for that shell and that repo; the MCP config it would write is
    // machine-wide, so it degrades to the absolute spelling instead.
    const launch = await resolveLaunch({
      pathEnv: localBin,
      binPath: '/home/dev/rungraph/bin/rungraph.js',
      execPath: '/usr/bin/node',
    });
    expect(launch).toMatchObject({ command: '/usr/bin/node', via: 'absolute' });
  });

  it('a dev checkout falls back to the absolute spelling', async () => {
    const launch = await resolveLaunch({
      pathEnv: '',
      binPath: '/home/dev/rungraph/bin/rungraph.js',
      execPath: '/usr/bin/node',
    });
    expect(launch).toEqual({
      command: '/usr/bin/node',
      args: ['/home/dev/rungraph/bin/rungraph.js', 'mcp'],
      via: 'absolute',
    });
  });
});

// ---------------------------------------------------------------------------
// The breadcrumb, and the nudge
// ---------------------------------------------------------------------------

/** Run `serve` until it is up, give the nudge time to land, then stop it. */
function serveOnce(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const finish = () => {
      child.kill('SIGINT');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve({ stdout, stderr });
      }, 700);
    };
    // The nudge is written right after the URL line, so waiting for the URL
    // plus a settle is enough — and the settle is generous because it costs a
    // fixture scan.
    const poll = setInterval(() => {
      if (stderr.includes('Ctrl-C to stop')) {
        clearInterval(poll);
        setTimeout(finish, 2000);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(poll);
      finish();
    }, 15000);
  });
}

describe('the breadcrumb, and serve’s nudge', () => {
  let state;
  const env = () => ({ ...baseEnv(), RUNGRAPH_STATE_DIR: state });

  beforeAll(async () => {
    state = await mkdtemp(join(tmp, 'crumb-'));
  });

  it('serve prints the nudge when no agent has ever connected', async () => {
    const { stdout, stderr } = await serveOnce(['serve', '--no-open', '--port', '4741'], env());
    // The data contract on stdout is untouched: the nudge is a log, and logs
    // go to stderr.
    expect(JSON.parse(stdout.trim().split('\n')[0]).url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(stdout).not.toContain('not installed');
    expect(stderr).toContain('the other half of rungraph is not installed');
    expect(stderr).toContain('npx rungraph mcp --install');
    // It names what it can prove, from the run index rather than from binaries.
    expect(stderr).toContain('Detected on this machine: claude, codex');
  }, 40000);

  it('RUNGRAPH_NO_NUDGE=1 silences it for good', async () => {
    const { stderr } = await serveOnce(['serve', '--no-open', '--port', '4742'], {
      ...env(),
      RUNGRAPH_NO_NUDGE: '1',
    });
    expect(stderr).toContain('Ctrl-C to stop');
    expect(stderr).not.toContain('not installed');
  }, 40000);

  it('an initialize handshake writes it, and serve then goes quiet', async () => {
    const fresh = await mkdtemp(join(tmp, 'crumb2-'));
    const e = { ...baseEnv(), RUNGRAPH_STATE_DIR: fresh };
    await new Promise((resolve) => {
      const child = spawn('node', [BIN, 'mcp'], { env: e, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.once('data', () => {
        child.stdin.end();
        child.once('close', resolve);
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: '1.18.19' } },
        }) + '\n',
      );
    });

    const saved = JSON.parse(
      await readFile(join(fresh, 'mcp-connected.json'), 'utf8'),
    );
    // Both fields come from clientInfo, which the protocol hands us free.
    expect(saved.client).toBe('opencode');
    expect(saved.clientVersion).toBe('1.18.19');
    expect(Date.parse(saved.at)).toBeGreaterThan(0);

    const { stderr } = await serveOnce(['serve', '--no-open', '--port', '4743'], e);
    expect(stderr).toContain('Ctrl-C to stop');
    expect(stderr).not.toContain('not installed');
  }, 60000);

  it('an initialize with no clientInfo at all still does not throw', async () => {
    const fresh = await mkdtemp(join(tmp, 'crumb3-'));
    const e = { ...baseEnv(), RUNGRAPH_STATE_DIR: fresh };
    const reply = await new Promise((resolve) => {
      const child = spawn('node', [BIN, 'mcp'], { env: e, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) {
          child.kill();
          resolve(JSON.parse(buf.split('\n')[0]));
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    });
    expect(reply.result.serverInfo.name).toBe('rungraph');
    expect(JSON.parse(await readFile(join(fresh, 'mcp-connected.json'), 'utf8')).client).toBe('unknown');
  }, 30000);

  // THE regression guard: the check must not manufacture the evidence it is
  // supposed to be reading. Two ways it could, and both are closed —
  // selfHandshake self-excludes by clientInfo.name, and every vendor CLI
  // rungraph spawns carries RUNGRAPH_NO_BREADCRUMB (three of the four boot
  // rungraph's own server to health-check it).
  it('mcp --check does NOT create the breadcrumb', async () => {
    const fresh = await mkdtemp(join(tmp, 'crumb4-'));
    await exec('node', [BIN, 'mcp', '--check', '--json'], {
      env: { ...baseEnv(), RUNGRAPH_STATE_DIR: fresh },
    }).catch((e) => e);
    await expect(readFile(join(fresh, 'mcp-connected.json'), 'utf8')).rejects.toThrow();
  }, 120000);

  // The ungated case above is necessary but not sufficient: with an empty
  // sandbox config, no provider has rungraph registered, so nothing connects
  // and the guard passes without exercising anything. THIS is the real one —
  // opencode's `mcp list` health-checks by handshaking with every registered
  // server, and its MCP client does not pass rungraph's environment through to
  // the server it spawns, so the env-var guard alone does not hold here.
  it.skipIf(!onPath('opencode'))(
    'mcp --check does NOT create it even when a provider health-checks rungraph',
    async () => {
      const fresh = await mkdtemp(join(tmp, 'crumb6-'));
      const xdg = await mkdtemp(join(tmp, 'crumb6-xdg-'));
      await mkdir(join(xdg, 'opencode'), { recursive: true });
      const cfg = join(xdg, 'opencode', 'opencode.jsonc');
      const env = {
        ...baseEnv(),
        RUNGRAPH_STATE_DIR: fresh,
        XDG_CONFIG_HOME: xdg,
        OPENCODE_CONFIG: cfg,
        // Detect opencode, so --check actually probes it.
        RUNGRAPH_CLAUDE_PROJECTS: '',
        RUNGRAPH_CODEX_SESSIONS: '',
        RUNGRAPH_OPENCODE_HOME: OPENCODE_FIXTURE_ROOT,
        RUNGRAPH_CURSOR_GLOBAL_STORAGE: '',
        RUNGRAPH_CURSOR_CLI_HOME: '',
      };
      await exec('node', [BIN, 'mcp', '--install', '--client', 'opencode'], { env });

      const home = join(process.env.HOME ?? '', '.rungraph', 'mcp-connected.json');
      const homeBefore = await readFile(home, 'utf8').catch(() => null);
      const r = await exec('node', [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);

      // The premise, proven from INSIDE the thing under test: `opencode mcp
      // list` only reports `connected` because it spawned rungraph and
      // completed a handshake with it. If this row is not ok, the guard below
      // is passing because nothing connected, which is no guard at all.
      const row = JSON.parse(r.stdout).checks.find((c) => c.client === 'opencode');
      expect(row).toMatchObject({ state: 'ok' });

      await expect(readFile(join(fresh, 'mcp-connected.json'), 'utf8')).rejects.toThrow();
      // …and not at the default path either, which is where a child that
      // cannot see RUNGRAPH_STATE_DIR would have put it.
      expect(await readFile(home, 'utf8').catch(() => null)).toBe(homeBefore);
    },
    180000,
  );

  it('rungraph open never nudges — a bundle recipient has no runs of their own', async () => {
    const fresh = await mkdtemp(join(tmp, 'crumb5-'));
    const e = { ...baseEnv(), RUNGRAPH_STATE_DIR: fresh };
    const bundle = join(fresh, 'shared.rungraph');
    // Export a KNOWN fixture run by id rather than --last, so this can never
    // quietly become a test that returns early and asserts nothing.
    const written = await exec('node', [BIN, 'export', CLEAN_RUN_ID, '--out', bundle, '--json'], { env: e });
    expect(JSON.parse(written.stdout).written).toBe(bundle);

    const { stdout, stderr } = await serveOnce(['open', bundle, '--no-open', '--port', '4744'], e);
    // Prove `open` really came up — otherwise "no nudge" is trivially true.
    expect(JSON.parse(stdout.trim().split('\n')[0]).runs).toBeGreaterThan(0);
    expect(stderr).not.toContain('not installed');
    // And the breadcrumb is still absent, so it was suppression by RULE and
    // not by a breadcrumb some earlier step left lying around.
    await expect(readFile(join(fresh, 'mcp-connected.json'), 'utf8')).rejects.toThrow();
  }, 60000);

  // The end-to-end guards above are masked by withoutBreadcrumbSideEffects,
  // which restores the breadcrumb whatever happened — deliberately, since that
  // is the guarantee. These two assert the mechanisms UNDERNEATH it directly,
  // so deleting either one is still a failing test rather than a silent
  // reliance on the wrapper.
  it('writeBreadcrumb refuses the check own handshake, by clientInfo.name', async () => {
    const dir = await mkdtemp(join(tmp, 'crumb7-'));
    const prev = process.env.RUNGRAPH_STATE_DIR;
    process.env.RUNGRAPH_STATE_DIR = dir;
    try {
      expect(await writeBreadcrumb({ name: SELF_CLIENT, version: '0' })).toBeNull();
      await expect(readFile(join(dir, 'mcp-connected.json'), 'utf8')).rejects.toThrow();
      // …and does write for anything that is not the check.
      expect(await writeBreadcrumb({ name: 'some-agent' })).toMatchObject({ client: 'some-agent' });
      expect(JSON.parse(await readFile(join(dir, 'mcp-connected.json'), 'utf8')).client).toBe('some-agent');
    } finally {
      if (prev === undefined) delete process.env.RUNGRAPH_STATE_DIR;
      else process.env.RUNGRAPH_STATE_DIR = prev;
    }
  });

  it('RUNGRAPH_NO_BREADCRUMB refuses every write, whoever is connecting', async () => {
    const dir = await mkdtemp(join(tmp, 'crumb8-'));
    const prevDir = process.env.RUNGRAPH_STATE_DIR;
    process.env.RUNGRAPH_STATE_DIR = dir;
    process.env.RUNGRAPH_NO_BREADCRUMB = '1';
    try {
      expect(await writeBreadcrumb({ name: 'some-agent' })).toBeNull();
      await expect(readFile(join(dir, 'mcp-connected.json'), 'utf8')).rejects.toThrow();
    } finally {
      delete process.env.RUNGRAPH_NO_BREADCRUMB;
      if (prevDir === undefined) delete process.env.RUNGRAPH_STATE_DIR;
      else process.env.RUNGRAPH_STATE_DIR = prevDir;
    }
  });

  it('withoutBreadcrumbSideEffects puts back what a probe wrote, and throws through', async () => {
    const dir = await mkdtemp(join(tmp, 'crumb9-'));
    const prev = process.env.RUNGRAPH_STATE_DIR;
    process.env.RUNGRAPH_STATE_DIR = dir;
    try {
      // Absent before → absent after, even though one was written inside.
      await withoutBreadcrumbSideEffects(async () => {
        await writeBreadcrumb({ name: 'a-health-check' });
        expect(JSON.parse(await readFile(join(dir, 'mcp-connected.json'), 'utf8')).client).toBe('a-health-check');
      });
      await expect(readFile(join(dir, 'mcp-connected.json'), 'utf8')).rejects.toThrow();

      // Present before → the SAME one after, not a newer one.
      await writeBreadcrumb({ name: 'the-real-agent' });
      await withoutBreadcrumbSideEffects(() => writeBreadcrumb({ name: 'a-health-check' }));
      expect(JSON.parse(await readFile(join(dir, 'mcp-connected.json'), 'utf8')).client).toBe('the-real-agent');

      // And restoration happens on the failure path too.
      await expect(
        withoutBreadcrumbSideEffects(async () => {
          await writeBreadcrumb({ name: 'a-health-check' });
          throw new Error('vendor blew up');
        }),
      ).rejects.toThrow('vendor blew up');
      expect(JSON.parse(await readFile(join(dir, 'mcp-connected.json'), 'utf8')).client).toBe('the-real-agent');
    } finally {
      if (prev === undefined) delete process.env.RUNGRAPH_STATE_DIR;
      else process.env.RUNGRAPH_STATE_DIR = prev;
    }
  });

  it('breadcrumbPath honours RUNGRAPH_STATE_DIR lazily, like registryDir', () => {
    const before = process.env.RUNGRAPH_STATE_DIR;
    process.env.RUNGRAPH_STATE_DIR = '/tmp/rg-lazy-probe';
    try {
      expect(breadcrumbPath()).toBe('/tmp/rg-lazy-probe/mcp-connected.json');
    } finally {
      if (before === undefined) delete process.env.RUNGRAPH_STATE_DIR;
      else process.env.RUNGRAPH_STATE_DIR = before;
    }
  });
});

// ---------------------------------------------------------------------------
// --check, driven by PATH shims so the shape is asserted with no vendor CLI
// ---------------------------------------------------------------------------

describe.skipIf(!POSIX)('mcp --check with two detected providers', () => {
  let shims;
  beforeAll(async () => {
    shims = await mkdtemp(join(tmp, 'shim-'));
    // Stand-ins for the real CLIs, so this runs on CI where none exist. They
    // print the exact bytes the real ones printed when probed — the ✔ is
    // U+2714 and codex's empty listing is a bare `[]` with exit 0.
    await writeFile(
      join(shims, 'claude'),
      '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then\n' +
        '  printf \'Checking MCP server health\\342\\200\\246\\n\\nrungraph: /x/node /y/rungraph.js mcp - \\342\\234\\224 Connected\\n\'\n' +
        '  exit 0\nfi\nexit 1\n',
    );
    await writeFile(
      join(shims, 'codex'),
      '#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\nexit 1\n',
    );
    await chmod(join(shims, 'claude'), 0o755);
    await chmod(join(shims, 'codex'), 0o755);
  });

  it('ok: true, with the unregistered one present and advisory', async () => {
    const env = { ...baseEnv(), PATH: `${shims}${delimiter}${process.env.PATH}` };
    const r = await exec('node', [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
    const report = JSON.parse(r.stdout);

    expect(report.checks.map((c) => c.name)).toEqual([
      'runs on disk',
      'mcp server',
      'registered · claude',
      'registered · codex',
      'dashboard server',
    ]);
    // The verdict is "at least one detected provider is registered": a
    // Claude-only user must not fail forever because they also have
    // six-month-old Codex transcripts on disk.
    expect(report.ok).toBe(true);

    const claude = report.checks.find((c) => c.client === 'claude');
    expect(claude).toMatchObject({ ok: true, state: 'ok', advisory: true });
    expect(claude.detail).toContain('connected');

    const codex = report.checks.find((c) => c.client === 'codex');
    expect(codex).toMatchObject({ ok: false, state: 'absent', advisory: true });
    expect(codex.fix).toBe('npx rungraph mcp --install --client codex');

    // Every not-ok row that blocks anything hands back its one next step.
    for (const c of report.checks) if (!c.ok && c.fix !== undefined) expect(c.fix.length).toBeGreaterThan(10);
  }, 120000);

  it('a detected provider whose CLI has been removed is advisory, never a failure', async () => {
    // detected ≠ installed: runs on disk prove the provider WAS used; the
    // binary may since have been removed, and there is no fix worth printing.
    const onlyClaude = await mkdtemp(join(tmp, 'shim2-'));
    await writeFile(join(onlyClaude, 'claude'), await readFile(join(shims, 'claude'), 'utf8'));
    await chmod(join(onlyClaude, 'claude'), 0o755);
    // process.execPath, not 'node': PATH here holds the claude shim and
    // nothing else, so a bare `node` would not resolve for the outer spawn.
    const env = { ...baseEnv(), PATH: onlyClaude };
    const r = await exec(process.execPath, [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
    const report = JSON.parse(r.stdout);
    const codex = report.checks.find((c) => c.client === 'codex');
    expect(codex.detail).toBe('the `codex` CLI is not on PATH');
    expect(codex.advisory).toBe(true);
    expect(report.ok).toBe(true); // claude still carries the loop
    // The remedy cannot be "install into it" — that fails the same way — but
    // it must not be nothing either, or a machine where EVERY detected CLI has
    // gone fails the check with no printed way forward.
    expect(codex.fix).not.toMatch(/^npx rungraph mcp --install/);
    expect(codex.fix).toContain('print the block to paste');
  }, 120000);

  it('every detected CLI gone: still fails, but never without a way forward', async () => {
    const empty = await mkdtemp(join(tmp, 'shim3-'));
    const env = { ...baseEnv(), PATH: empty };
    const r = await exec(process.execPath, [BIN, 'mcp', '--check'], { env }).catch((e) => e);
    expect(r.code).toBe(1);
    // The old shape printed exactly one `→` line here, and it belonged to the
    // advisory dashboard row — a failing check whose only advice was about the
    // optional part.
    const arrows = r.stdout.split('\n').filter((l) => l.trim().startsWith('→'));
    expect(arrows.length).toBeGreaterThan(1);
    expect(arrows.join('\n')).toMatch(/claude|codex/);
  }, 120000);

  it('no providers detected at all: the remedy is to run an agent first', async () => {
    const env = {
      ...baseEnv(),
      RUNGRAPH_CLAUDE_PROJECTS: '',
      RUNGRAPH_CODEX_SESSIONS: '',
      PATH: `${shims}${delimiter}${process.env.PATH}`,
    };
    const r = await exec('node', [BIN, 'mcp', '--check', '--json'], { env }).catch((e) => e);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(r.code).toBe(1);
    const row = report.checks.find((c) => c.name === 'registered');
    expect(row.fix).toContain('Run a coding-agent session');
  }, 120000);
});

// ---------------------------------------------------------------------------
// --install: usage, selection, and the tier that never dead-ends
// ---------------------------------------------------------------------------

describe('mcp --install usage', () => {
  it('an unknown --client is exit 1, and the message names every real one', async () => {
    const err = await exec('node', [BIN, 'mcp', '--install', '--client', 'nope'], {
      env: baseEnv(),
    }).catch((e) => e);
    expect(err.code).toBe(1);
    for (const name of CLIENT_NAMES) expect(err.stderr).toContain(name);
    expect(err.stderr).toContain(ALL_CLIENTS);
  });

  // Pre-flight, and it has to stay that way: a bare `--install` now means
  // "install into every detected provider", so a scope check that ran after
  // selection would spawn four vendor CLIs before rejecting the flag.
  it('an invalid --scope is rejected before anything is spawned', async () => {
    const err = await exec('node', [BIN, 'mcp', '--install', '--scope', 'nonsense'], {
      env: baseEnv(),
    }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('invalid --scope');
    expect(err.stdout).toBe('');
  });

  it('nothing detected and no --client: every block printed, exit 0', async () => {
    const env = { ...baseEnv(), RUNGRAPH_CLAUDE_PROJECTS: '', RUNGRAPH_CODEX_SESSIONS: '' };
    const { stdout, stderr } = await exec('node', [BIN, 'mcp', '--install', '--json'], { env });
    const report = JSON.parse(stdout);
    // There is nothing broken here; there is just nothing to delegate to.
    expect(report.detected).toEqual([]);
    expect(report.clients.map((c) => c.client)).toEqual(CLIENT_NAMES);
    for (const c of report.clients) expect(c.status).toBe('pasted');
    expect(stderr).toContain('nothing was detected');
  }, 60000);

  it('--scope alongside a scopeless client is ignored with one line, not an error', async () => {
    const env = { ...baseEnv(), RUNGRAPH_CLAUDE_PROJECTS: '', RUNGRAPH_CODEX_SESSIONS: '' };
    const { stderr } = await exec('node', [BIN, 'mcp', '--install', '--scope', 'user', '--json'], { env });
    expect(stderr).toContain('--scope is Claude-only');
    expect(stderr).toContain('codex');
  }, 60000);

  it('--json wraps the per-client reports in an array, and carries the launch', async () => {
    // Nothing detected, so nothing is delegated to — which is what keeps this
    // case runnable on CI, where none of the four vendor CLIs exist. Naming a
    // client explicitly here would delegate for real and exit 1 on a machine
    // without that binary.
    const env = { ...baseEnv(), RUNGRAPH_CLAUDE_PROJECTS: '', RUNGRAPH_CODEX_SESSIONS: '' };
    const { stdout } = await exec('node', [BIN, 'mcp', '--install', '--json'], { env });
    const report = JSON.parse(stdout);
    expect(Array.isArray(report.clients)).toBe(true);
    expect(report.clients.map((c) => c.client)).toEqual(CLIENT_NAMES);
    expect(['path', 'npx-cache', 'absolute']).toContain(report.launch.via);
    expect(report.launch.args.at(-1)).toBe('mcp');

    const oc = report.clients.find((c) => c.client === 'opencode');
    // The key is `mcp`, NOT `mcpServers`, and `command` is an ARRAY.
    expect(oc.config.mcp.rungraph.type).toBe('local');
    expect(Array.isArray(oc.config.mcp.rungraph.command)).toBe(true);
    expect(oc.instructions).toContain('focus_nodes');
    expect(oc.instructionsFile).toBe('AGENTS.md');

    // Every client carries a block, in its own vendor's format — the fallback
    // a failed delegation prints, and the reason configBlock is not paste-only.
    expect(report.clients.find((c) => c.client === 'codex').configFormat).toBe('toml');
    expect(report.clients.find((c) => c.client === 'hermes').configFormat).toBe('yaml');
    expect(report.clients.find((c) => c.client === 'claude').config.mcpServers.rungraph).toBeTruthy();
  }, 60000);

  it('a delegate that cannot be reached prints its paste block and exits 1', async () => {
    const empty = await mkdtemp(join(tmp, 'nobin-'));
    const env = { ...baseEnv(), PATH: empty };
    const err = await exec(process.execPath, [BIN, 'mcp', '--install', '--client', 'codex'], { env }).catch(
      (e) => e,
    );
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('not on PATH');
    // Never "it didn't work" with no next action.
    expect(err.stdout).toContain('[mcp_servers.rungraph]');
  }, 60000);
});

// ---------------------------------------------------------------------------
// Integration: gated on the vendor binary. GitHub Actions has none of these,
// so they skip there and are the developer's local gate — the same posture as
// the recorded-calibration discipline already used for the SQLite adapters.
// ---------------------------------------------------------------------------

const installJson = async (args, env) => {
  const { stdout } = await exec('node', [BIN, 'mcp', '--install', '--json', ...args], { env });
  return JSON.parse(stdout).clients[0];
};

describe.skipIf(!onPath('claude'))('integration: claude', () => {
  it('writes .claude.json, and a second add reports already rather than a second install', async () => {
    const home = await mkdtemp(join(tmp, 'claude-'));
    const env = { ...baseEnv(), CLAUDE_CONFIG_DIR: home };

    const first = await installJson(['--client', 'claude'], env);
    expect(first).toMatchObject({ status: 'installed', installed: true, scope: 'user' });
    const written = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    expect(written.mcpServers.rungraph.args).toContain('mcp');

    const second = await installJson(['--client', 'claude'], env);
    expect(second).toMatchObject({ status: 'already', installed: false, alreadyInstalled: true });
  }, 120000);
});

describe.skipIf(!onPath('codex'))('integration: codex', () => {
  it('writes [mcp_servers.rungraph], and its idempotent add is read as already', async () => {
    // codex does NOT create its config home; a missing one is exit 1.
    const home = join(await mkdtemp(join(tmp, 'codex-')), 'home');
    await mkdir(home, { recursive: true });
    const env = { ...baseEnv(), CODEX_HOME: home };

    const first = await installJson(['--client', 'codex'], env);
    expect(first).toMatchObject({ status: 'installed', installed: true });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('[mcp_servers.rungraph]');

    // `codex mcp add` exits 0 and prints the same success line on a repeat, so
    // "already" is unobservable from the add and has to be pre-read. Without
    // the pre-read this would report a second install.
    const second = await installJson(['--client', 'codex'], env);
    expect(second).toMatchObject({ status: 'already', installed: false, alreadyInstalled: true });
  }, 120000);
});

describe.skipIf(!onPath('hermes'))('integration: hermes', () => {
  // THE test that would have caught D1. The README published
  //   hermes mcp add rungraph --command npx --args -y rungraph mcp
  // which a human makes work by pressing Enter — and which, run piped or by an
  // agent, printed the tool list, cancelled, wrote NOTHING, and exited 0.
  it('feeds stdin, so the add actually writes config.yaml instead of cancelling', async () => {
    const home = await mkdtemp(join(tmp, 'hermes-'));
    const env = { ...baseEnv(), HERMES_HOME: home };

    const first = await installJson(['--client', 'hermes'], env);
    expect(first).toMatchObject({ status: 'installed', installed: true });
    const yaml = await readFile(join(home, 'config.yaml'), 'utf8');
    expect(yaml).toContain('mcp_servers:');
    expect(yaml).toContain('rungraph:');

    const list = await exec('hermes', ['mcp', 'list'], { env }).catch((e) => e);
    expect(`${list.stdout}`).toMatch(/rungraph/);

    // The re-add asks `Server 'rungraph' already exists. Overwrite? [y/N]:`
    // FIRST, which eats a single `y`; two are fed for exactly this reason.
    const second = await installJson(['--client', 'hermes'], env);
    expect(second.status).toBe('already');
  }, 180000);
});

describe.skipIf(!onPath('opencode'))('integration: opencode', () => {
  // Isolated with XDG_CONFIG_HOME, NOT OPENCODE_CONFIG. Measured: opencode
  // honours OPENCODE_CONFIG on its READ path only — `mcp add` resolves its
  // write target from $XDG_CONFIG_HOME/opencode independently, so an
  // OPENCODE_CONFIG-only test would edit the developer's real config.
  it('delegates non-interactively and leaves JSONC comments intact', async () => {
    const xdg = await mkdtemp(join(tmp, 'oc-'));
    await mkdir(join(xdg, 'opencode'), { recursive: true });
    const cfg = join(xdg, 'opencode', 'opencode.jsonc');
    await writeFile(cfg, '{\n  // a comment rungraph must never destroy\n  "model": "x"\n}\n');
    // OPENCODE_CONFIG must point INTO this sandbox too, not at baseEnv's.
    // opencode reads it and writes elsewhere, so leaving the two pointing at
    // different dirs makes `mcp list` and `mcp add` disagree about the file.
    const env = { ...baseEnv(), XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: cfg };

    const first = await installJson(['--client', 'opencode'], env);
    expect(first).toMatchObject({ status: 'installed', installed: true });

    // The whole reason rungraph refused to write this file itself was that
    // opencode's configs are JSONC and rungraph has no JSONC parser. opencode
    // does, and uses it — which is what makes delegating the better answer.
    const after = await readFile(cfg, 'utf8');
    expect(after).toContain('// a comment rungraph must never destroy');
    expect(after).toContain('"rungraph"');
    expect(after).toContain('"model": "x"');

    const second = await installJson(['--client', 'opencode'], env);
    expect(second.status).toBe('already');
  }, 180000);
});
