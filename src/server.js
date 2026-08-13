import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, toIndexEntry, ADAPTERS } from './scanner.js';
import { watchRun, diffGraphs } from './watcher.js';
import { attachSignals } from './signals.js';
import { matchNodes } from './find.js';

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const HOST = '127.0.0.1'; // privacy: never bind anything else
const MAX_PORT_TRIES = 50;
const MAX_BODY_BYTES = 256 * 1024; // focus payloads are ids and two short strings
/**
 * How long an agent's focus waits for a browser to come and collect it.
 * This is what lets the answer land in a tab that did not exist when the
 * question was asked — and it closes the race where the POST beats the page.
 */
const FOCUS_TTL_MS = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Start the local server.
 * API endpoints map 1:1 onto future MCP tools (list_runs, get_graph,
 * get_detail, open_visualization) so `rungraph mcp` in v1.1 is a wrapper.
 *
 * @param {{ preferredPort?: number, project?: string }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const state = {
    project: opts.project,
    // runId → { key, ir, details } — parse cache, invalidated by mtime key.
    parseCache: new Map(),
    // runId → { watcher, clients: Set<res>, lastIR }
    watches: new Map(),
    // runId → { frame, at } — the last agent focus, waiting to be collected.
    pendingFocus: new Map(),
  };

  const server = createServer((req, res) => {
    handle(req, res, state).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });

  const port = await listenWithRetry(server, opts.preferredPort ?? 4321);
  const url = `http://${HOST}:${port}`;
  state.url = url;
  state.port = port;

  return {
    url,
    port,
    close: () =>
      new Promise((resolve) => {
        for (const w of state.watches.values()) {
          w.watcher.close();
          for (const c of w.clients) c.end();
        }
        state.watches.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function listenWithRetry(server, preferred) {
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferred === 0 ? 0 : preferred + i, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server.address().port; // the real port (handles --port 0)
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      if (preferred === 0) throw err;
    }
  }
  throw new Error(`no free port in ${preferred}..${preferred + MAX_PORT_TRIES - 1}`);
}

async function handle(req, res, state) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/focus') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    return apiFocus(req, res, state);
  }
  if (path === '/api/index') return apiIndex(res, state);
  if (path === '/api/view') return apiView(res, state);

  let m;
  if ((m = path.match(/^\/api\/graph\/(.+)$/)))
    return apiGraph(res, state, decodeURIComponent(m[1]));
  if ((m = path.match(/^\/api\/find\/(.+)$/)))
    return apiFind(res, state, decodeURIComponent(m[1]), url.searchParams.get('q'));
  if ((m = path.match(/^\/api\/detail\/(.+)$/)))
    return apiDetail(res, state, decodeURIComponent(m[1]), url.searchParams.get('run'));
  if ((m = path.match(/^\/api\/watch\/(.+)$/)))
    return apiWatch(req, res, state, decodeURIComponent(m[1]));

  // Unknown API paths are JSON 404s, never the SPA fallback.
  if (path === '/api' || path.startsWith('/api/')) {
    return sendJson(res, 404, { error: `unknown endpoint ${path}` });
  }
  return serveStatic(res, path);
}

async function apiIndex(res, state) {
  const { runs } = await scan({ project: state.project });
  sendJson(res, 200, { runs: runs.map((r) => toIndexEntry(r)) });
}

async function resolveRun(state, runId) {
  const { runs } = await scan({ project: state.project });
  return runs.find((r) => r.runId === runId);
}

async function parseCached(state, ref) {
  const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
  // Fingerprint covers the run's WHOLE file set — satellite agent
  // transcripts grow without touching the main file.
  const key = (await adapter.fingerprint?.(ref)) ?? `${ref.modifiedAt}:${ref.sizeBytes}`;
  const hit = state.parseCache.get(ref.runId);
  if (hit && hit.key === key) return hit;
  const { ir, details } = await adapter.parse(ref, { collectDetails: true });
  // Signals are derived once, here, so the graph the browser draws and the
  // graph an agent reads over MCP can never disagree about what is wrong.
  attachSignals(ir);
  const entry = { key, ir, details };
  state.parseCache.set(ref.runId, entry);
  if (state.parseCache.size > 8) {
    const oldest = state.parseCache.keys().next().value;
    if (oldest !== ref.runId) state.parseCache.delete(oldest);
  }
  return entry;
}

async function apiGraph(res, state, runId) {
  const ref = await resolveRun(state, runId);
  if (!ref) return sendJson(res, 404, { error: `no run found with id "${runId}"` });
  const { ir } = await parseCached(state, ref);
  sendJson(res, 200, ir);
}

/**
 * Server-side narrowing for the `find_nodes` MCP tool: a 500-node graph is
 * plausibly 40–50k tokens dropped into the user's session to answer one
 * question, so an agent needs a way to filter before it pulls.
 *
 * The frontend does NOT call this — it imports the same matcher and filters
 * locally, avoiding a round trip per keystroke. One matcher, two consumers.
 */
async function apiFind(res, state, runId, q) {
  const ref = await resolveRun(state, runId);
  if (!ref) return sendJson(res, 404, { error: `no run found with id "${runId}"` });
  const { ir } = await parseCached(state, ref);
  const nodeIds = matchNodes(ir, q ?? '');
  const want = new Set(nodeIds);
  sendJson(res, 200, {
    runId,
    query: q ?? '',
    matched: nodeIds.length,
    nodeIds,
    nodes: ir.nodes.filter((n) => want.has(n.id)),
  });
}

/**
 * What the open dashboards are actually showing. Without it "this run" is
 * ambiguous unless the user pastes a runId — and an empty array is how an
 * agent learns not to bother calling POST /api/focus at all.
 */
function apiView(res, state) {
  const runs = [...state.watches.entries()]
    .map(([runId, w]) => ({
      runId,
      clientCount: w.clients.size,
      connectedAt: new Date(w.lastConnectedAt).toISOString(),
    }))
    .filter((r) => r.clientCount > 0)
    // Most recently opened first. With two tabs on two runs, "this run" is
    // otherwise a coin flip — Map order is insertion order, so the default
    // answer was the tab that had been open the LONGEST, which is the opposite
    // of what someone means when they say "this run".
    .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1));
  sendJson(res, 200, { runs });
}

/**
 * The focus channel — and the server's first write endpoint.
 *
 * It accepts node ids and two display strings, and its only effect is which
 * nodes a local browser tab highlights: it reads no new files and mutates
 * nothing on disk. Any local process that could reach it can already read
 * ~/.claude/projects directly, so it grants no capability that did not exist.
 *
 * The Origin check is the one thing that is NOT already true of the filesystem:
 * a random page in the user's browser can POST to localhost, and should not be
 * able to drive their dashboard.
 */
async function apiFocus(req, res, state) {
  const origin = req.headers.origin;
  if (origin && !isLocalOrigin(origin, state.port)) {
    return sendJson(res, 403, { error: 'cross-origin focus rejected' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message ?? err) });
  }
  const runId = typeof body?.runId === 'string' ? body.runId : null;
  const nodeIds = Array.isArray(body?.nodeIds)
    ? body.nodeIds.filter((x) => typeof x === 'string')
    : null;
  if (!runId || !nodeIds) {
    return sendJson(res, 400, { error: 'expected { runId: string, nodeIds: string[] }' });
  }

  const entry = state.watches.get(runId);
  const clientCount = entry?.clients.size ?? 0;
  const frame = {
    type: 'focus',
    runId,
    nodeIds,
    label: str(body.label, 120) || `${nodeIds.length} nodes`,
    reason: str(body.reason, 600),
    source: 'agent',
    // A tab already on this run will handle it, so tabs on OTHER runs should
    // stay where they are. Without this, asking about run B with two tabs open
    // drags both of them onto B.
    alreadyWatching: clientCount > 0,
  };

  // Held ONLY when nobody is on this run yet — for the tab that is about to be
  // opened, or the one about to switch here. If a tab is already showing the
  // run it receives the frame directly below, and holding a copy would just
  // re-fire the same answer at the next tab that happens to open.
  if (clientCount === 0) state.pendingFocus.set(runId, { frame, at: Date.now() });

  // Broadcast to EVERY client, not just this run's. A tab showing another run
  // has to hear about the answer to be able to follow it there — the user just
  // asked the question, so being told "here is a URL, go paste it" is the loop
  // failing at the last inch.
  const payload = `data: ${JSON.stringify(frame)}\n\n`;
  let otherClients = 0;
  for (const [id, w] of state.watches) {
    for (const client of w.clients) client.write(payload);
    if (id !== runId) otherClients += w.clients.size;
  }

  // Zero clients anywhere is not an error: the POST succeeded, nobody was
  // looking. The counts are what let the agent decide whether to open a tab.
  sendJson(res, 200, {
    ok: true,
    runId,
    clientCount,
    otherClients,
    url: `${state.url}/?run=${encodeURIComponent(runId)}`,
  });
}

function isLocalOrigin(origin, port) {
  try {
    const u = new URL(origin);
    const localHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    return localHost && (!port || u.port === String(port));
  } catch {
    return false;
  }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Read a bounded JSON body. Past `max` we stop *buffering* but keep draining,
 * so the client's write completes and it reads our 400 — destroying the socket
 * mid-write hands it a connection reset instead of the explanation. Past a hard
 * multiple of the cap it is no longer an honest oversized request and the
 * socket goes.
 */
function readJsonBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    let chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        overflow = true;
        chunks = [];
        if (size > max * 8) {
          reject(new Error('body too large'));
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (overflow) return reject(new Error('body too large'));
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('malformed JSON body'));
      }
    });
  });
}

async function apiDetail(res, state, nodeId, runId) {
  if (!runId) return sendJson(res, 400, { error: 'missing ?run=<runId>' });
  const ref = await resolveRun(state, runId);
  if (!ref) return sendJson(res, 404, { error: `no run found with id "${runId}"` });
  const { details } = await parseCached(state, ref);
  const detail = details.get(nodeId);
  if (!detail) return sendJson(res, 404, { error: `no detail for node "${nodeId}"` });
  sendJson(res, 200, detail);
}

async function apiWatch(req, res, state, runId) {
  const ref = await resolveRun(state, runId);
  if (!ref) return sendJson(res, 404, { error: `no run found with id "${runId}"` });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let entry = state.watches.get(runId);
  if (!entry) {
    entry = { watcher: null, clients: new Set(), lastIR: null, lastConnectedAt: 0 };
    state.watches.set(runId, entry);
    const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
    entry.watcher = watchRun(ref, adapter, {
      onGraph(ir, details) {
        state.parseCache.set(runId, { key: 'live', ir, details });
        const delta = diffGraphs(entry.lastIR, ir);
        entry.lastIR = ir;
        if (!delta) return;
        const payload = `data: ${JSON.stringify(delta)}\n\n`;
        for (const client of entry.clients) client.write(payload);
      },
      onError() {}, // transient mid-write states; next event retries
    });
  }

  entry.clients.add(res);
  entry.lastConnectedAt = Date.now();
  if (entry.lastIR) {
    res.write(`data: ${JSON.stringify({ type: 'snapshot', graph: entry.lastIR })}\n\n`);
  }
  // Replay a focus this run is still holding, so a tab that opened *because*
  // an agent asked for it arrives already pointed at the answer. The client
  // holds it until the matching graph is in hand, so ordering here is free.
  const held = state.pendingFocus.get(runId);
  if (held) {
    // Delivered or expired, it is done either way: the answer has reached the
    // browser it was waiting for.
    state.pendingFocus.delete(runId);
    if (Date.now() - held.at < FOCUS_TTL_MS) {
      res.write(`data: ${JSON.stringify({ ...held.frame, replayed: true })}\n\n`);
    }
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    entry.clients.delete(res);
    if (entry.clients.size === 0) {
      entry.watcher.close();
      state.watches.delete(runId);
    }
  });
}

async function serveStatic(res, path) {
  if (path === '/') path = '/index.html';
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST_DIR, safe);
  if (!file.startsWith(DIST_DIR)) return sendJson(res, 404, { error: 'not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    if (path !== '/index.html') return serveStatic(res, '/'); // SPA fallback
    sendJson(res, 404, {
      error: 'frontend not built — run `npm run build` (published packages ship it prebuilt)',
    });
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
