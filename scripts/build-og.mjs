#!/usr/bin/env node
/**
 * Render site/og.png — the social card — from site/og.html.
 *
 *   node scripts/build-og.mjs            # writes site/og.png (1200×630)
 *   CHROME=/path/to/chrome node scripts/build-og.mjs
 *
 * The card is not a screenshot of the page (the hero is taller than 630px and
 * a crawler-sized crop of it reads badly); it is its own composition, but it
 * takes its words from the hero and its data from the baked run so it cannot
 * drift from either:
 *
 *   - the headline is parsed out of site/index.html's <h1 class="display">,
 *     accent and all;
 *   - the card's one-sentence lede must be a verbatim cut of the hero lede,
 *     or the build refuses — the first og.png went stale exactly this way
 *     (hero rewritten three times, card still saying "see your agent runs as
 *     a graph", and X served that to everyone for a week);
 *   - the strip and the chips come from site/data/graph.json: one cell per
 *     node in run order, one chip per high-severity signal, no invented
 *     numbers.
 *
 * Rendering goes through headless Chrome, which is the only rasteriser on a
 * dev machine that lays out the self-hosted Newsreader exactly the way the
 * page does. Zero dependencies, dev-time only: this never runs in CI or at
 * `npm run build`; the PNG is committed.
 */
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const OUT = join(SITE, 'og.png');

// The card lede: the hero's first sentence, cut at the clause the card has no
// room for. Edit the hero first; this line must stay a cut of it.
const CARD_LEDE =
  'One command turns every coding-agent session already on your disk into a graph: subagents, tool calls, retries and the moments you said no.';

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const GLYPH = { 'retry-storm': '↻', 'unresolved-error': '⚠', intervention: '✋', 'course-change': '↪', outlier: '◆' };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (await access(c).then(() => true, () => false)) return c;
  }
  throw new Error('no Chrome found; set CHROME=/path/to/chrome');
}

function heroFrom(html) {
  const h1 = html.match(/<h1 class="display">([\s\S]*?)<\/h1>/)?.[1];
  const lede = html.match(/<p class="lede">([\s\S]*?)<\/p>/)?.[1];
  if (!h1 || !lede) throw new Error('could not find the hero h1/lede in site/index.html');
  // Keep <br> and the accent <em>; drop everything else.
  const headline = h1
    .replace(/<br\s*\/?>/g, '<br>')
    .replace(/<em class="accent">/g, '<em>')
    .replace(/<(?!\/?(em|br)\b)[^>]+>/g, '')
    .trim();
  return { headline, lede: norm(lede.replace(/<[^>]+>/g, '')) };
}

// deriveSignals writes them top-level, beside nodes and edges.
const signalsOf = (graph) => graph.signals ?? [];

function cellsFrom(graph) {
  const flagged = new Set(signalsOf(graph).flatMap((s) => s.nodeIds ?? []));
  return graph.nodes
    .map((n) => {
      const cls = [n.kind, n.status === 'error' ? 'error' : '', flagged.has(n.id) ? 'flagged' : ''].filter(Boolean).join(' ');
      return `<i class="${cls}"></i>`;
    })
    .join('');
}

function chipsFrom(graph) {
  return signalsOf(graph)
    .filter((s) => s.severity === 'high')
    .slice(0, 5)
    .map((s) => `<span class="chip ${s.kind}"><b>${GLYPH[s.kind] ?? '·'}</b>${esc(s.label)}</span>`)
    .join('');
}

async function main() {
  const [tpl, html, graphText] = await Promise.all([
    readFile(join(SITE, 'og.html'), 'utf8'),
    readFile(join(SITE, 'index.html'), 'utf8'),
    readFile(join(SITE, 'data', 'graph.json'), 'utf8'),
  ]);
  const graph = JSON.parse(graphText);
  const hero = heroFrom(html);

  const cut = CARD_LEDE.replace(/\.$/, '');
  if (!hero.lede.startsWith(cut)) {
    throw new Error(
      `CARD_LEDE is no longer a cut of the hero lede.\n  card: ${CARD_LEDE}\n  hero: ${hero.lede}\nEdit CARD_LEDE in scripts/build-og.mjs to match the hero, then re-run.`,
    );
  }

  const filled = tpl
    .replaceAll('{{FONTS}}', pathToFileURL(join(SITE, 'fonts')).href)
    .replaceAll('{{HEADLINE}}', hero.headline)
    .replaceAll('{{LEDE}}', esc(CARD_LEDE))
    .replaceAll('{{NODES}}', String(graph.nodes.length))
    .replaceAll('{{SIGNALS}}', String(signalsOf(graph).length))
    .replaceAll('{{CELLS}}', cellsFrom(graph))
    .replaceAll('{{CHIPS}}', chipsFrom(graph));
  if (/{{\w+}}/.test(filled)) throw new Error(`unfilled placeholder: ${filled.match(/{{\w+}}/)[0]}`);

  const dir = await mkdtemp(join(tmpdir(), 'rungraph-og-'));
  try {
    const page = join(dir, 'og.html');
    await writeFile(page, filled);
    const chrome = await findChrome();
    await run(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1200,630',
      '--virtual-time-budget=3000',
      `--screenshot=${OUT}`,
      pathToFileURL(page).href,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const png = await readFile(OUT);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== 1200 || h !== 630) throw new Error(`og.png is ${w}×${h}, expected 1200×630`);
  console.error(`og.png written — ${w}×${h}, ${(png.length / 1024).toFixed(0)} KB, ${graph.nodes.length} nodes, ${signalsOf(graph).length} signals`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
