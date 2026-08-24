/**
 * Landing-page behavior. Everything here reads the SAME baked files the embed
 * serves itself from — the vignettes, the signal demo and the loop demo render
 * real nodes, real derived signals, and a captured, genuinely-produced MCP
 * exchange. No invented content anywhere in this file.
 */

// The run strip orders nodes by the same rule the dashboard and the signal
// ranking use — one import, so the three views cannot drift on "earlier".
import { runOrder } from '../../src/timeline.js';

const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
const REDUCED = () => reducedMq.matches;

const announce = (text) => {
  const el = document.querySelector('[data-announce]');
  if (el) el.textContent = text;
};

/* ------------------------------------------------------------- copy chips */

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.setAttribute('data-copied', '');
      announce(`copied: ${btn.dataset.copy}`);
      setTimeout(() => btn.removeAttribute('data-copied'), 1800);
    } catch {
      /* clipboard unavailable — the command is right there to select */
    }
  });
}

/* ------------------------------------------------------- boot the embed */

const stage = document.querySelector('.stage');

// The embed bridge must exist before app.js evaluates. The page owns boot
// order: index.json names the one baked run, then the real app loads deferred
// so the page's own paint never waits on it.
window.RUNGRAPH_EMBED = { runId: null };

const json = (path) =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

const dataP = {
  index: json('data/index.json'),
  graph: json('data/graph.json'),
  loop: json('data/loop.json').catch(() => null),
  exportTxt: fetch('data/export.txt').then((r) => (r.ok ? r.text() : '')).catch(() => ''),
};

dataP.index
  .then((index) => {
    window.RUNGRAPH_EMBED.runId = index.runs[0]?.runId ?? null;
    return import('./app.js');
  })
  .then(() => {
    // App mounted: the boot glyph fades once the graph itself is drawing —
    // the canvas svg exists only with a loaded graph (the empty state has none).
    const app = document.getElementById('app');
    const ready = () => {
      if (!stage.querySelector('.canvas-wrap > svg')) return false;
      stage.setAttribute('data-live', '');
      return true;
    };
    if (!ready()) {
      const seen = new MutationObserver(() => ready() && seen.disconnect());
      seen.observe(app, { childList: true, subtree: true });
    }
  })
  .catch(() => {
    // Never a blank hero: the boot glyph stays, the page still reads.
  });

// Embed keyboard shortcuts act only while the stage is actually on screen —
// pressing "/" three sections down must not yank the viewport to the hero.
let stageVisible = false;
new IntersectionObserver(
  ([entry]) => {
    stageVisible = entry.isIntersecting;
  },
  { threshold: 0.15 },
).observe(stage);
window.RUNGRAPH_EMBED.keysEnabled = () => stageVisible;

// The wheel belongs to the page until the visitor takes the graph's controls
// (a click on the canvas, or a guided chip). Moving the cursor off the canvas
// hands scroll back. A quiet hint appears when a scroll passes through, so
// nobody wonders why the graph "ignored" their wheel.
const scrollHint = document.querySelector('[data-scroll-hint]');
let hintTimer = null;
window.RUNGRAPH_EMBED.wheelCaptured = false;
window.RUNGRAPH_EMBED.setCaptured = (on) => {
  window.RUNGRAPH_EMBED.wheelCaptured = on;
  stage.toggleAttribute('data-captured', on);
  if (on) {
    clearTimeout(hintTimer);
    scrollHint?.removeAttribute('data-show');
  }
};
window.RUNGRAPH_EMBED.onWheelPassthrough = () => {
  if (!scrollHint) return;
  scrollHint.setAttribute('data-show', '');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => scrollHint.removeAttribute('data-show'), 1700);
};

/* --------------------------------------------------------- guided chips */

for (const chip of document.querySelectorAll('[data-try]')) {
  chip.addEventListener('click', () => {
    const embed = window.RUNGRAPH_EMBED;
    const kind = chip.dataset.try;
    let done = false;
    if (kind === 'signal') done = embed.app?.focusSignalKind('unresolved-error') ?? false;
    else if (kind === 'replay') {
      // Opens the bar and plays the run from the start through the SAME
      // producers the header button uses — never a synthetic keypress or a
      // click on a control the embed may have hidden. False when the app is
      // not up yet, or the run has no timeline (the bridge says so).
      done = embed.app?.replay?.play() ?? false;
    } else if (kind === 'find') {
      embed.app?.openFind();
      done = Boolean(embed.app);
    } else if (kind === 'fit') {
      embed.canvas?.fit();
      done = Boolean(embed.canvas);
    }
    if (done) {
      // Using a chip is taking the controls too — wheeling right after
      // "fit the graph" should zoom the graph, not scroll away from it.
      embed.setCaptured?.(true);
      chip.setAttribute('data-done', '');
      setTimeout(() => chip.removeAttribute('data-done'), 2200);
    }
  });
}

/* ------------------------------------------------------ section reveals */

const revealer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.setAttribute('data-revealed', '');
        revealer.unobserve(e.target);
      }
    }
  },
  // Permissive on purpose: a fast scroll must never leave a section stuck
  // invisible because it crossed the viewport between observer callbacks.
  { threshold: 0.05, rootMargin: '10% 0px 0px 0px' },
);
for (const el of document.querySelectorAll('.band-inner, .outro')) revealer.observe(el);

/* -------------------------------------------------- mini node rendering
   A deliberate, documented exception to the one-implementation rule: these
   static SVG fragments are PRESENTATION ONLY — every label, status, count,
   reason, and signal membership they show comes from the baked graph.json,
   and every color comes from the dashboard's own CSS tokens. The real
   renderer (canvas.jsx + elkjs) needs a live layout engine; embedding it
   three more times would cost more drift risk than these ~60 lines do.   */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function nodeBox(n, x, y, w = 168, h = 46) {
  const tag = n.kind === 'human' ? n.interventionKind ?? 'human' : n.kind;
  const meta = [
    n.callCount > 1 ? `×${n.callCount}` : '',
    n.errorCount ? `${n.errorCount} err` : '',
    n.tokens ? fmtTokens(n.tokens.input + n.tokens.output) + ' tok' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<g class="mn-node" data-kind="${n.kind}" data-status="${n.status}" transform="translate(${x} ${y})">
    <rect class="body" width="${w}" height="${h}" rx="8"/>
    <rect class="status" x="0" y="6" width="3" height="${h - 12}" rx="1.5"/>
    <text class="tag" x="12" y="13">${esc(tag)}</text>
    <text x="12" y="${meta ? h - 20 : h / 2 + 9}">${esc(trunc(n.label ?? '', 24))}</text>
    ${meta ? `<text class="meta" x="12" y="${h - 7}">${esc(meta)}</text>` : ''}
  </g>`;
}

function fmtTokens(t) {
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return (t / 1e3).toFixed(1) + 'k';
  return String(t);
}

function edgePath(d, kind, reason) {
  return `<path class="mn-edge${reason ? ' has-reason' : ''}" data-kind="${kind}" d="${d}"/>`;
}

/* ----------------------------------------------------------- vignettes */

dataP.graph.then((graph) => {
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seq = graph.edges.filter((e) => e.kind === 'sequence');
  const nextOf = (id) => seq.find((e) => e.from === id)?.to;
  const prevOf = (id) => seq.find((e) => e.to === id)?.from;

  // ① lanes: the run's agent, its spawn source and its return target.
  const agent = nodes.find((n) => n.kind === 'agent');
  const spawn = graph.edges.find((e) => e.kind === 'spawn' && e.to === agent?.id);
  const ret = graph.edges.find((e) => e.kind === 'return' && e.from === agent?.id);
  if (agent && spawn) {
    const from = byId.get(spawn.from);
    const to = ret ? byId.get(ret.to) : null;
    setVignette(
      'lanes',
      `<svg viewBox="0 0 360 210">
        ${edgePath('M110 58 C 110 84, 196 74, 196 96', 'spawn')}
        ${to ? edgePath('M196 142 C 196 168, 110 152, 110 160', 'return') : ''}
        ${nodeBox(from, 26, 14)}
        ${nodeBox(agent, 176, 96, 168)}
        ${to ? nodeBox(to, 26, 158) : ''}
      </svg>`,
    );
  }

  // ② tools: the most-collapsed tool node, in its chain.
  const tool = [...nodes]
    .filter((n) => n.kind === 'tool' && (n.callCount ?? 1) > 1)
    .sort((a, b) => (b.callCount ?? 0) - (a.callCount ?? 0))[0];
  if (tool) {
    const prev = byId.get(prevOf(tool.id));
    const next = byId.get(nextOf(tool.id));
    setVignette(
      'tools',
      `<svg viewBox="0 0 360 210">
        ${prev ? edgePath('M180 54 v 24', 'sequence') : ''}
        ${next ? edgePath('M180 128 v 24', 'sequence') : ''}
        ${prev ? nodeBox(prev, 96, 10) : ''}
        ${nodeBox(tool, 96, 80)}
        ${next ? nodeBox(next, 96, 154) : ''}
      </svg>`,
    );
  }

  // ③ interventions: a human node and the reason on the edge that follows it.
  const human =
    nodes.find((n) => n.kind === 'human' && n.interventionKind === 'denial') ??
    nodes.find((n) => n.kind === 'human');
  if (human) {
    const prev = byId.get(prevOf(human.id));
    const outEdge = seq.find((e) => e.from === human.id);
    const next = outEdge ? byId.get(outEdge.to) : null;
    setVignette(
      'human',
      `<svg viewBox="0 0 360 210">
        ${prev ? edgePath('M180 54 v 24', 'sequence') : ''}
        ${next ? edgePath('M180 128 v 24', 'sequence', outEdge?.reason) : ''}
        ${outEdge?.reason ? `<text class="mn-reason" x="192" y="146">⚑ ${esc(trunc(outEdge.reason, 24))}</text>` : ''}
        ${prev ? nodeBox(prev, 96, 10) : ''}
        ${nodeBox(human, 96, 80)}
        ${next ? nodeBox(next, 96, 154) : ''}
      </svg>`,
    );
  }

  pruneEmptyVignettes();
  buildSignalDemo(graph);
  dataP.loop.then((loop) => loop && buildLoopDemo(graph, loop));
}).catch(() => {
  // No graph data: the demos can't build, but the page must still read —
  // hide the empty frames rather than leaving three blank boxes.
  pruneEmptyVignettes();
});

function setVignette(name, svg) {
  const el = document.querySelector(`[data-vignette="${name}"] .vg-canvas`);
  if (el) el.innerHTML = svg;
}

/** A vignette whose shape the run doesn't contain renders nothing — hide it. */
function pruneEmptyVignettes() {
  for (const fig of document.querySelectorAll('.vignette')) {
    if (!fig.querySelector('.vg-canvas svg')) fig.style.display = 'none';
  }
}

/* -------------------------------------------------- run strip (minimap) */

/**
 * The whole run as a wrapped strip of kind-colored cells, in run order — the
 * same overview idea as the dashboard's minimap. Focus lights members and dims
 * the rest; the container never reflows, so nothing "hides".
 */
function runStrip(graph, mount) {
  // Run order, with the same carry-forward-on-missing-timestamp rule as the
  // canvas's own orderedNodes — the two views must agree on "earlier".
  const ordered = runOrder(graph.nodes);
  const COLS = 14;
  const CELL = 30;
  const GAP = 8;
  const rows = Math.ceil(ordered.length / COLS);
  const w = COLS * (CELL + GAP) + GAP;
  const h = rows * (CELL * 0.72 + GAP) + GAP;
  const cells = ordered
    .map((n, i) => {
      const x = GAP + (i % COLS) * (CELL + GAP);
      const y = GAP + Math.floor(i / COLS) * (CELL * 0.72 + GAP);
      return `<g class="mn-node" data-kind="${n.kind}" data-status="${n.status}" data-id="${esc(n.id)}">
        <rect class="body" x="${x}" y="${y}" width="${CELL}" height="${CELL * 0.72}" rx="4"/>
        <rect class="status" x="${x}" y="${y + 3}" width="2.5" height="${CELL * 0.72 - 6}" rx="1"/>
        <title>${esc(n.label ?? '')}</title>
      </g>`;
    })
    .join('');
  mount.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${cells}</svg>`;
  return {
    focus(nodeIds) {
      const want = new Set(nodeIds ?? []);
      mount.toggleAttribute('data-focused', want.size > 0);
      for (const g of mount.querySelectorAll('.mn-node')) {
        g.toggleAttribute('data-lit', want.has(g.dataset.id));
      }
    },
  };
}

/* --------------------------------------------------------- §3 signals */

function buildSignalDemo(graph) {
  const mount = document.querySelector('[data-mini="signals"]');
  const reasonEl = document.querySelector('[data-mini-reason]');
  if (!mount) return;
  const strip = runStrip(graph, mount);
  const restText = reasonEl.textContent;
  const byKind = new Map();
  for (const s of graph.signals ?? []) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, s);
  }
  for (const chip of document.querySelectorAll('.sig-chip')) {
    const sig = byKind.get(chip.dataset.signal);
    if (!sig) {
      // Absent is a feature: precision over recall means chips only exist
      // when the run earns them, and the demo says so out loud.
      chip.setAttribute('data-absent', '');
      chip.setAttribute('aria-disabled', 'true');
      const explain = () => {
        reasonEl.textContent = 'not derived for this run — a signal only exists when the run earns it.';
      };
      const clear = () => {
        reasonEl.textContent = restText;
      };
      chip.addEventListener('mouseenter', explain);
      chip.addEventListener('mouseleave', clear);
      chip.addEventListener('focus', explain);
      chip.addEventListener('blur', clear);
      continue;
    }
    chip.setAttribute('aria-pressed', 'false');
    const on = () => {
      for (const c of document.querySelectorAll('.sig-chip[data-on]')) {
        c.removeAttribute('data-on');
        c.setAttribute('aria-pressed', 'false');
      }
      chip.setAttribute('data-on', '');
      chip.setAttribute('aria-pressed', 'true');
      strip.focus(sig.nodeIds);
      reasonEl.textContent = sig.reason;
    };
    const off = () => {
      chip.removeAttribute('data-on');
      chip.setAttribute('aria-pressed', 'false');
      strip.focus(null);
      reasonEl.textContent = restText;
    };
    chip.addEventListener('mouseenter', on);
    chip.addEventListener('mouseleave', off);
    chip.addEventListener('focus', on);
    chip.addEventListener('blur', off);
    // Touch has no hover: tapping an already-lit chip clears it.
    chip.addEventListener('click', () => (chip.hasAttribute('data-on') ? off() : on()));
  }
}

/* ------------------------------------------------------------ §4 loop */

function buildLoopDemo(graph, loop) {
  const term = document.querySelector('[data-terminal] .term-body');
  const replay = document.querySelector('[data-replay]');
  const heroBtn = document.querySelector('[data-loop-hero]');
  const mount = document.querySelector('[data-mini="loop"]');
  if (!term || !mount) return;
  const strip = runStrip(graph, mount);

  const segs = [
    { cls: 'q', text: loop.question },
    { cls: 'a', text: loop.answer },
    { cls: 'sys', text: `✓ focus_nodes · ${loop.nodeIds.length} nodes lit on the open dashboard — "${loop.label}"` },
  ];

  // The animated terminal is decorative for assistive tech; the full exchange
  // lives in one static, readable element instead.
  const sr = document.querySelector('[data-loop-sr]');
  if (sr) {
    sr.textContent = `Question asked in the terminal: ${loop.question} — The agent answered: ${loop.answer} — It then called focus_nodes and ${loop.nodeIds.length} nodes lit up on the dashboard.`;
  }

  let timer = null;
  const stopped = () => {
    clearTimeout(timer);
    timer = null;
  };

  // The spec's beat is "the embedded graph's nodes light up as the answer
  // streams" — so the hero embed receives the same focus, quietly (no scroll;
  // the button below is the scroll affordance).
  const lightHero = () =>
    window.RUNGRAPH_EMBED.app?.focusNodes?.(loop.nodeIds, loop.label, loop.reason);

  function renderInstant() {
    term.innerHTML = segs
      .map((s) => `<span class="${s.cls}">${esc(s.text)}</span>`)
      .join('\n\n');
    strip.focus(loop.nodeIds);
    lightHero();
    replay.hidden = false;
    heroBtn.hidden = false;
  }

  function play() {
    stopped();
    if (REDUCED()) return renderInstant();
    term.innerHTML = '';
    strip.focus(null);
    replay.hidden = true;
    heroBtn.hidden = true;
    let si = 0;
    let ci = 0;
    const spans = [];
    const tick = () => {
      const seg = segs[si];
      if (!spans[si]) {
        const el = document.createElement('span');
        el.className = seg.cls;
        if (si > 0) term.append('\n\n');
        term.append(el);
        spans[si] = el;
        if (seg.cls === 'a') {
          strip.focus(loop.nodeIds); // the graph answers as the text streams
          lightHero();
        }
      }
      const step = seg.cls === 'q' ? 1 : 4;
      ci = Math.min(seg.text.length, ci + step);
      spans[si].textContent = seg.text.slice(0, ci);
      const caret = term.querySelector('.caret') ?? Object.assign(document.createElement('span'), { className: 'caret' });
      spans[si].after(caret);
      term.scrollTop = term.scrollHeight;
      if (ci >= seg.text.length) {
        si += 1;
        ci = 0;
        if (si >= segs.length) {
          caret.remove();
          replay.hidden = false;
          heroBtn.hidden = false;
          return;
        }
        timer = setTimeout(tick, seg.cls === 'q' ? 650 : 250);
        return;
      }
      timer = setTimeout(tick, seg.cls === 'q' ? 34 : 14);
    };
    tick();
  }

  new IntersectionObserver(
    ([entry], obs) => {
      if (entry.isIntersecting) {
        play();
        obs.disconnect();
      }
    },
    { threshold: 0.4 },
  ).observe(term);

  replay.addEventListener('click', play);
  heroBtn.addEventListener('click', () => {
    if (lightHero()) {
      document.querySelector('.stage').scrollIntoView({ behavior: REDUCED() ? 'auto' : 'smooth' });
    }
  });
}

/* -------------------------------------------------------------- §7 faq

   <details> already owns open/close, keyboard and the expanded state, so this
   adds exactly one thing the browser doesn't: a #hash opens the question it
   names, which is what makes a single answer linkable from an issue or a doc. */

function openFaqFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const target = document.getElementById(id);
  if (!(target instanceof HTMLDetailsElement)) return;
  for (const other of document.querySelectorAll('.qa[data-linked]')) {
    other.removeAttribute('data-linked');
  }
  target.open = true;
  target.setAttribute('data-linked', '');
  // The band's reveal transition moves the section under us; wait a frame so
  // the browser scrolls to where the question actually lands.
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: REDUCED() ? 'auto' : 'smooth', block: 'center' });
  });
}

addEventListener('hashchange', openFaqFromHash);
openFaqFromHash();

/* Section anchors need the same correction, for the same reason: the embed,
   the vignettes and the mini-graphs are all injected AFTER parse, so the jump
   the browser makes on its own is measured against a page that is about to
   grow underneath it — #agents was landing on §2. Re-scroll once the content
   is actually in, and let scroll-margin-top clear the sticky nav. */
function scrollToBandFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const band = document.getElementById(id);
  if (!band?.classList.contains('band')) return;
  const target = band.querySelector('.band-inner') ?? band;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: REDUCED() ? 'auto' : 'smooth', block: 'start' });
  });
}

addEventListener('hashchange', scrollToBandFromHash);

/* A cold load is the hard case: the browser jumps at parse time, and THEN the
   embed, the vignettes and the mini-graphs inject and push the target further
   down the page. So re-aim on every height change until the layout settles —
   and stop the moment the visitor scrolls, because after that the page is
   theirs and a correction would be a fight. */
addEventListener('load', () => {
  if (!location.hash) return;
  scrollToBandFromHash();
  const ro = new ResizeObserver(scrollToBandFromHash);
  const stop = () => {
    ro.disconnect();
    removeEventListener('wheel', stop);
    removeEventListener('touchstart', stop);
    removeEventListener('keydown', stop);
  };
  ro.observe(document.body);
  addEventListener('wheel', stop, { passive: true, once: true });
  addEventListener('touchstart', stop, { passive: true, once: true });
  addEventListener('keydown', stop, { once: true });
  setTimeout(stop, 2000);
});

// Closing the question drops the "you were sent here" mark with it — a sage
// summary on a collapsed row reads as state that no longer means anything.
for (const qa of document.querySelectorAll('.qa')) {
  qa.addEventListener('toggle', () => {
    if (!qa.open) qa.removeAttribute('data-linked');
  });
}

/* ---------------------------------------------------------- §5 export */

dataP.exportTxt.then((text) => {
  const pre = document.querySelector('[data-export-terminal] .term-body');
  if (!pre || !text) return;
  pre.innerHTML = text
    .trimEnd()
    .split('\n')
    .map((line) => {
      const cls = /✗|blocked|secret| ! /.test(line)
        ? 'warnline'
        : /wrote |✓/.test(line)
          ? 'okline'
          : /^\$/.test(line)
            ? 'cmd'
            : '';
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    })
    .join('\n');
});
