import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, toIndexEntry, ADAPTERS } from './scanner.js';
import { watchRun, diffGraphs } from './watcher.js';

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const HOST = '127.0.0.1'; // privacy: never bind anything else
const MAX_PORT_TRIES = 50;

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
  };

  const server = createServer((req, res) => {
    handle(req, res, state).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });

  const port = await listenWithRetry(server, opts.preferredPort ?? 4321);
  const url = `http://${HOST}:${port}`;

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

  if (path === '/api/index') return apiIndex(res, state);

  let m;
  if ((m = path.match(/^\/api\/graph\/(.+)$/)))
    return apiGraph(res, state, decodeURIComponent(m[1]));
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
    entry = { watcher: null, clients: new Set(), lastIR: null };
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
  if (entry.lastIR) {
    res.write(`data: ${JSON.stringify({ type: 'snapshot', graph: entry.lastIR })}\n\n`);
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
