import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The port registry — how separate rungraph processes find every live server.
 *
 * One file per server, `<port>.json`, so concurrent servers never race on a
 * shared file: `rungraph serve` (the user's own dashboard) and `rungraph open`
 * (a colleague's bundle) coexist, and `rungraph mcp` aggregates across both —
 * the agent must never silently answer about the wrong one.
 *
 * Entries hold a port, a pid, a start time and display-only source labels —
 * nothing sensitive. A server writes its entry on startup and removes it on
 * clean shutdown; a crash leaves the file behind, so readers MUST confirm
 * liveness with a real request before trusting one, and whoever finds a dead
 * entry deletes it.
 */

/**
 * The directory is per-user: `tmpdir()` already is on macOS and Windows, but
 * on some Linux setups it is a shared /tmp, so the uid suffix keeps two users'
 * registries (and their delete rights) apart.
 *
 * Read from the environment per call, not at module load — RUNGRAPH_PORT_DIR
 * lets tests (and unusual setups) redirect discovery so a test can never find
 * or clobber the developer's own running servers, and reading lazily means it
 * works no matter when the variable is set relative to import order.
 */
export function registryDir() {
  return (
    process.env.RUNGRAPH_PORT_DIR ||
    join(tmpdir(), `rungraph-servers-${process.getuid?.() ?? 'u'}`)
  );
}

const HOST = '127.0.0.1';

export function urlForPort(port) {
  return `http://${HOST}:${port}`;
}

/**
 * Create-or-verify the registry directory, ssh-style. Everything downstream
 * trusts what it reads here — the MCP merges listed servers' runs into the
 * agent's context, and /api/locate offers jumps to them — so on a shared
 * /tmp another user must not be able to pre-create (squat) this directory
 * and plant entries. The dir must be a real directory, owned by us, with no
 * group/world write bits. Returns the path, or null when it cannot be
 * trusted — callers then behave as if no registry exists.
 */
async function ensureRegistryDir() {
  const dir = registryDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    if (!st.isDirectory()) return null;
    // POSIX only — Windows tmpdir is per-user and has no POSIX mode bits.
    if (typeof process.getuid === 'function') {
      if (st.uid !== process.getuid()) return null;
      if ((st.mode & 0o022) !== 0) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * @param {number} port
 * @param {string[]} sources Display labels: 'local', or 'bundle:<filename>'.
 */
export async function writeRegistryEntry(port, sources = ['local'], pid = process.pid) {
  const dir = await ensureRegistryDir();
  if (!dir) return false; // untrusted or read-only dir costs discovery, never the server
  try {
    await writeFile(
      join(dir, `${port}.json`),
      JSON.stringify({ port, pid, startedAt: new Date().toISOString(), sources }) + '\n',
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeRegistryEntry(port) {
  try {
    await rm(join(registryDir(), `${port}.json`), { force: true });
  } catch {
    /* best effort */
  }
}

/** @returns {Promise<Array<{port:number,pid:number,startedAt:string,sources:string[]}>>} */
export async function readRegistry() {
  // The same trust gate as writing: a squatted directory is worse to read
  // from than to write to — its entries end up in the agent's context.
  const dir = await ensureRegistryDir();
  if (!dir) return [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return []; // no directory yet — no server has ever run
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (Number.isInteger(raw?.port)) {
        out.push({ ...raw, sources: Array.isArray(raw.sources) ? raw.sources : [] });
      }
    } catch {
      /* half-written or foreign file — skip */
    }
  }
  return out;
}

/**
 * Probe one server with a real request. Returns its /api/index body (the
 * probe doubles as the run inventory the MCP needs anyway) or null.
 */
export async function probeServer(url, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/api/index`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.runs) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Every registry entry that is actually answering, most recently started
 * first. Stale entries from crashed processes fail the probe and are
 * opportunistically deleted here — whoever finds them cleans up.
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{url:string,port:number,pid:number,startedAt:string,sources:string[],index:{runs:object[]}}>>}
 */
export async function liveServers(opts = {}) {
  const entries = await readRegistry();
  const probed = await Promise.all(
    entries.map(async (e) => {
      const url = urlForPort(e.port);
      const index = await probeServer(url, opts.timeoutMs);
      if (!index) {
        // Entries are written exactly once, at startup — deleting one for a
        // server that is merely slow (a giant parse, a busy machine) makes it
        // permanently undiscoverable. Delete only when the recorded process
        // is actually gone; a live pid that missed the probe is just "not
        // answering right now".
        if (pidDead(e.pid)) await removeRegistryEntry(e.port);
        return null;
      }
      return { ...e, url, index };
    }),
  );
  return probed
    .filter(Boolean)
    .sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? 1 : -1));
}

/** Is the pid certainly gone? Signal 0 probes without sending anything. */
function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // malformed → not worth keeping
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM = alive but not ours — that is "alive" for cleanup purposes.
    return err?.code === 'ESRCH';
  }
}

/**
 * The URL of one live server — the most recently started — or null. The
 * single-server convenience for callers that just need *a* dashboard (boot
 * waits, the `--check` probe); anything answering questions about a specific
 * run must route by runId over `liveServers()` instead.
 *
 * @param {{timeoutMs?: number}} [opts]
 */
export async function liveServerUrl(opts = {}) {
  const servers = await liveServers(opts);
  return servers[0]?.url ?? null;
}
