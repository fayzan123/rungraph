/**
 * Landing-page build (site/ → site/dist). Sibling of build-frontend.mjs, which
 * stays untouched: the dashboard the npm package ships and the page GitHub
 * Pages serves are two builds of the same frontend, not two frontends.
 *
 *   node scripts/build-site.mjs                 build site/dist
 *   node scripts/build-site.mjs --bake <file>   regenerate site/data from an
 *                                               exported .rungraph bundle
 *   node scripts/build-site.mjs --check         build, then verify every URL in
 *                                               the output resolves relatively
 *                                               and the transfer budget holds
 *   node scripts/build-site.mjs --serve [port]  build + serve site/dist locally
 *
 * The bake step is a signals CONSUMER: no server runs behind the static embed,
 * so this is the point where deriveSignals executes for the baked run — same
 * one-implementation rule as cli.js / server.js / watcher.js, guarded by
 * tests/site.test.js.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { join, dirname, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundleFile } from '../src/bundle.js';
import { attachSignals } from '../src/signals.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(root, 'site');
const DIST = join(SITE, 'dist');
const DATA = join(SITE, 'data');

/** Transfer budget (gzipped, whole page): the spec's hard ceiling. */
const BUDGET_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------- bake */

/**
 * .rungraph bundle → site/data/{graph,details,index}.json. The bundle comes
 * from `rungraph export` (inventory printed, secret scan enforced there); this
 * step attaches signals, caps oversized detail payloads for transfer weight,
 * and writes the three files the static api fetches. The committed JSON is the
 * reviewable artifact — read every prompt and output before committing.
 */
async function bake(bundlePath) {
  if (!bundlePath) throw new Error('usage: build-site.mjs --bake <file.rungraph>');
  const { envelope } = await loadBundleFile(resolve(bundlePath));
  const sessions = envelope.runs.filter((r) => r.ir?.meta?.kind === 'session');
  if (sessions.length !== 1) {
    throw new Error(`expected exactly one session run in the bundle, found ${sessions.length}`);
  }
  const run = sessions[0];
  if (run.snapshot) {
    throw new Error(
      'the run still looked live when it was exported (snapshot stamp present) — ' +
        'wait for the session to settle (~5 min) and re-export, or the embed shows running nodes forever',
    );
  }
  // The bake is the consumer: signals derive here, into the committed file.
  attachSignals(run.ir);

  const details = capDetails(run.details ?? {});
  const entry = {
    runId: run.runId,
    adapter: run.ir.meta.adapter,
    kind: run.ir.meta.kind,
    title: run.ir.meta.title,
    project: run.project ?? null,
    startedAt: run.ir.meta.startedAt ?? null,
    modifiedAt: run.ir.meta.endedAt ?? run.ir.meta.startedAt ?? envelope.exportedAt,
    sizeBytes: null,
    active: false,
  };

  await mkdir(DATA, { recursive: true });
  const graphJson = JSON.stringify(run.ir, null, 1);
  const detailsJson = JSON.stringify(details, null, 1);
  await writeFile(join(DATA, 'graph.json'), graphJson);
  await writeFile(join(DATA, 'details.json'), detailsJson);
  await writeFile(join(DATA, 'index.json'), JSON.stringify({ runs: [entry] }, null, 1));
  console.error(
    `baked ${run.runId}\n` +
      `  nodes ${run.ir.nodes.length} · edges ${run.ir.edges.length} · signals ${run.ir.signals.length} ` +
      `[${run.ir.signals.map((s) => s.kind).join(', ')}]\n` +
      `  graph.json ${kb(graphJson)} · details.json ${kb(detailsJson)} (gzipped)`,
  );
}

const CAPS = { call: 2000, transcript: 1500, prose: 4000 };
const MARK = (n) => `\n… (${n} more chars truncated for the demo embed)`;

function capText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, max) + MARK(text.length - max);
}

/** Truncation is honest — the caption already says "demo repo". */
function capDetails(details) {
  const out = {};
  for (const [nodeId, d] of Object.entries(details)) {
    const c = { ...d };
    if (c.kind === 'tool' && Array.isArray(c.calls)) {
      c.calls = c.calls.map((call) => ({
        ...call,
        input: capText(call.input, CAPS.call),
        output: capText(call.output, CAPS.call),
      }));
    }
    if (c.kind === 'agent' && Array.isArray(c.transcript)) {
      c.transcript = c.transcript.map((t) => ({ ...t, text: capText(t.text, CAPS.transcript) }));
    }
    for (const k of ['prompt', 'responseText', 'result', 'context', 'answer', 'returnValue']) {
      if (typeof c[k] === 'string') c[k] = capText(c[k], CAPS.prose);
    }
    out[nodeId] = c;
  }
  return out;
}

/* ------------------------------------------------------------------ build */

async function buildSite() {
  for (const f of ['graph.json', 'details.json', 'index.json']) {
    await stat(join(DATA, f)).catch(() => {
      throw new Error(`site/data/${f} missing — bake the demo run first (--bake)`);
    });
  }
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // The embed: the real frontend, with exactly one module swapped. The plugin
  // filters on the RESOLVED path so a future import spelling can't dodge it —
  // except from api-static itself, which re-exports applyDelta from the original.
  const apiPath = join(root, 'frontend/src/api.js');
  const apiStatic = join(SITE, 'src/api-static.js');
  await build({
    entryPoints: [join(root, 'frontend/src/main.jsx')],
    bundle: true,
    outfile: join(DIST, 'app.js'),
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'api-static',
        setup(b) {
          // Match loosely (extensionless spellings included), decide on the
          // RESOLVED path — an import spelling must not be able to dodge the
          // swap and smuggle the server-backed api.js into the static bundle.
          b.onResolve({ filter: /api(\.js)?$/ }, (a) => {
            if (a.importer === apiStatic) return null;
            const resolved = normalize(join(a.resolveDir, a.path));
            return resolved === apiPath || `${resolved}.js` === apiPath
              ? { path: apiStatic }
              : null;
          });
        },
      },
    ],
  });

  // The page's own JS + CSS.
  await build({
    entryPoints: [join(SITE, 'src/page.js')],
    bundle: true,
    outfile: join(DIST, 'page.js'),
    format: 'esm',
    minify: true,
    logLevel: 'warning',
    // The embed is its own build; the page imports it at runtime, on purpose,
    // so the page paints without waiting for the app bundle.
    external: ['./app.js'],
  });
  await build({
    entryPoints: [join(SITE, 'src/page.css')],
    outfile: join(DIST, 'page.css'),
    minify: true,
    logLevel: 'warning',
    loader: { '.woff2': 'copy' },
  });

  await cp(join(SITE, 'index.html'), join(DIST, 'index.html'));
  await cp(DATA, join(DIST, 'data'), { recursive: true });
  await cp(join(SITE, 'fonts'), join(DIST, 'fonts'), { recursive: true });
  for (const extra of ['og.png']) {
    await cp(join(SITE, extra), join(DIST, extra)).catch(() => {});
  }
  console.error(await weightReport());
}

async function weightReport() {
  const rows = [];
  let total = 0;
  for (const file of await walk(DIST)) {
    const buf = await readFile(file);
    const gz = /\.(png|woff2)$/.test(file) ? buf.length : gzipSync(buf).length;
    total += gz;
    rows.push(`  ${(gz / 1024).toFixed(0).padStart(5)} KB  ${file.slice(DIST.length + 1)}`);
  }
  return `site/dist transfer weight (gzipped):\n${rows.join('\n')}\n  total ${(total / 1024).toFixed(0)} KB of ${(BUDGET_BYTES / 1024).toFixed(0)} KB budget`;
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function kb(text) {
  return `${(gzipSync(Buffer.from(text)).length / 1024).toFixed(0)} KB`;
}

/* ------------------------------------------------------------------ check */

/**
 * Link-and-path check: every URL the page references must resolve inside
 * site/dist RELATIVELY (GitHub Pages serves under /rungraph/, so a leading
 * slash is a broken link by construction) — plus the transfer budget.
 */
async function check() {
  const problems = [];
  const html = await readFile(join(DIST, 'index.html'), 'utf8');

  // Contained resolution: a `../`-style URL escaping dist would resolve
  // against files GitHub Pages never serves — that is a broken link even
  // when the file happens to exist in the source tree.
  const inDist = async (url, from) => {
    const target = resolve(DIST, url.split('#')[0]);
    if (!target.startsWith(DIST + '/')) {
      problems.push(`${from} references a path outside dist: ${url}`);
      return;
    }
    await stat(target).catch(() => {
      problems.push(`${from} references missing file: ${url}`);
    });
  };

  const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const url of urls) {
    if (/^(https?:|mailto:|#|data:)/.test(url)) continue;
    if (url.startsWith('/')) {
      problems.push(`absolute path in index.html: ${url} (breaks under /rungraph/)`);
      continue;
    }
    await inDist(url, 'index.html');
  }
  for (const cssFile of ['page.css', 'app.css']) {
    const css = await readFile(join(DIST, cssFile), 'utf8').catch(() => '');
    for (const m of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const url = m[1];
      if (/^(https?:|data:)/.test(url)) continue;
      if (url.startsWith('/')) {
        problems.push(`absolute path in ${cssFile}: ${url}`);
        continue;
      }
      await inDist(url, cssFile);
    }
  }
  // The page must make zero external requests: no http(s) URL may be fetched
  // as a subresource. Anchors (href) to GitHub/npm are fine; script/img/link
  // src/href to another host are not.
  for (const m of html.matchAll(/<(script|img|link)[^>]*(?:src|href)="(https?:[^"]+)"/g)) {
    problems.push(`external subresource in index.html: <${m[1]}> ${m[2]}`);
  }

  let total = 0;
  for (const file of await walk(DIST)) {
    const buf = await readFile(file);
    total += /\.(png|woff2)$/.test(file) ? buf.length : gzipSync(buf).length;
  }
  if (total > BUDGET_BYTES) {
    problems.push(`transfer weight ${(total / 1024).toFixed(0)} KB exceeds the 2 MB budget`);
  }

  if (problems.length > 0) {
    console.error('site check FAILED:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.error(`site check ok — ${urls.length} URLs resolve, ${(total / 1024).toFixed(0)} KB gzipped`);
}

/* ------------------------------------------------------------------ serve */

/** Local static serve of site/dist, for verifying the relative-path build. */
async function serve(port) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  const server = createServer(async (req, res) => {
    // Serve under a subpath like Pages does, so absolute-path bugs surface.
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith('/rungraph')) {
      res.writeHead(302, { location: '/rungraph/' });
      return res.end();
    }
    path = path.slice('/rungraph'.length) || '/';
    if (path === '/') path = '/index.html';
    const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  console.error(`serving site/dist at http://127.0.0.1:${port}/rungraph/ (Ctrl-C to stop)`);
}

/* --------------------------------------------------------------- dispatch */

const args = process.argv.slice(2);
if (args[0] === '--bake') {
  await bake(args[1]);
} else {
  await buildSite();
  if (args.includes('--check')) await check();
  if (args.includes('--serve')) await serve(Number(args[args.indexOf('--serve') + 1]) || 8899);
}
