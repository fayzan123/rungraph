import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Port discovery between two separate processes: `rungraph serve` (which owns
 * the browser tab) and `rungraph mcp` (which the user's Claude Code session
 * spawns over stdio). The MCP process has no other way to learn the port.
 *
 * `serve` writes { port, pid, startedAt } here on startup and removes it on
 * clean shutdown. A crash leaves the file behind, so readers MUST confirm
 * liveness with a real request before trusting it — see liveServerUrl().
 */
export const PORT_FILE =
  // Overridable so tests never read (or clobber) the developer's own running
  // server — the whole point of the file is that any process can find it.
  process.env.RUNGRAPH_PORT_FILE || join(tmpdir(), 'rungraph-server.json');

const HOST = '127.0.0.1';

export function urlForPort(port) {
  return `http://${HOST}:${port}`;
}

export async function writePortFile(port, pid = process.pid) {
  try {
    await writeFile(
      PORT_FILE,
      JSON.stringify({ port, pid, startedAt: new Date().toISOString() }) + '\n',
    );
    return true;
  } catch {
    // A read-only tmpdir costs the MCP handshake, never the server itself.
    return false;
  }
}

export async function removePortFile() {
  try {
    await rm(PORT_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

/** @returns {Promise<{port:number,pid:number,startedAt:string}|null>} */
export async function readPortFile() {
  try {
    const raw = JSON.parse(await readFile(PORT_FILE, 'utf8'));
    return Number.isInteger(raw?.port) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The URL of a server that is actually answering, or null.
 * A stale file from a crashed process fails the liveness probe and is treated
 * as "no server running" — never as an error.
 *
 * @param {{timeoutMs?: number}} [opts]
 */
export async function liveServerUrl(opts = {}) {
  const entry = await readPortFile();
  if (!entry) return null;
  const url = urlForPort(entry.port);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await fetch(`${url}/api/index`, { signal: ac.signal });
    return res.ok ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
