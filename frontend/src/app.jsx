import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchIndex, fetchGraph, watchGraph, applyDelta } from './api.js';
import { Canvas } from './canvas.jsx';
import { Inspector } from './inspector.jsx';
import { Strip } from './strip.jsx';
import { ExportDialog } from './export.jsx';
import { ResumePopover } from './resume.jsx';
import {
  adapterName,
  focusFromAgent,
  focusFromFile,
  focusFromFind,
  focusFromSignal,
  newHighSignalIds,
  pruneFocus,
  refocus,
  signalKey,
} from './focus.js';
import { adapterChips, groupKeyFor, groupRuns } from './picker-groups.js';
import { buildFocusHash, descriptorFromFocus, parseFocusHash } from '../../src/deeplink.js';
import {
  classifyCoverage,
  coverageLabel,
  strongerCoverage,
  unknownTypeSummary,
} from '../../src/coverage.js';

// Embed mode — the landing page (site/) mounts the real app inside a page that
// owns its own URL. Set by the page before app.js loads; absent everywhere
// else. The bridge exposes the SAME internal producers a click or a deep link
// would use (focusFromSignal + pan, the find opener) — never synthetic DOM
// events — so the page's guided chips cannot drift from real behavior.
const EMBED = typeof window !== 'undefined' ? window.RUNGRAPH_EMBED : undefined;

// Embedded on a phone, the inspector cannot share the width with the canvas —
// it overlays instead (page CSS), so it must start CLOSED and appear only
// while something is selected, or it eats the whole portrait screen.
const embedNarrow = () =>
  Boolean(EMBED) && typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches;

export function App() {
  const [index, setIndex] = useState(null);
  // A deep link (#run=…&sel=…&f=…) wins over the plain ?run= param: the hash
  // carries focus state the search param cannot.
  const [runId, setRunId] = useState(
    () =>
      EMBED?.runId ??
      parseFocusHash(location.hash)?.runId ??
      new URLSearchParams(location.search).get('run'),
  );
  const [graph, setGraph] = useState(null);
  const [graphError, setGraphError] = useState(null);
  const [selection, setSelection] = useState(null); // {type:'node'|'edge', id}
  const [follow, setFollow] = useState(true);
  const [connected, setConnected] = useState(true);

  // Exactly one FocusSet, three consumers: canvas, strip, inspector.
  const [focus, setFocus] = useState(null);
  const [focusSeq, setFocusSeq] = useState(0); // bumps only on an agent's answer
  const [findOpen, setFindOpen] = useState(false);
  const [findSeq, setFindSeq] = useState(0); // bumps on every open request, even when already open
  const [query, setQuery] = useState('');
  const [note, setNote] = useState(null); // transient, strip-sized; never a banner
  const [escalated, setEscalated] = useState(false);
  const [panes, setPanes] = useState(loadPanes);
  const [switchedFrom, setSwitchedFrom] = useState(null); // undo for an agent-driven run switch
  const [resumePop, setResumePop] = useState(null); // { entry, anchor } — the resume popover
  const [linkMiss, setLinkMiss] = useState(null); // deep link to a run this server lacks
  const [linkSeq, setLinkSeq] = useState(0); // bumps when a deep link arrives without a reload
  const pendingFocus = useRef(null); // an agent's focus, waiting for its own graph
  const pendingLink = useRef(parseFocusHash(location.hash)); // a deep link, waiting for its graph
  const seenHigh = useRef(new Set()); // `high` signal ids the user has looked at
  const primed = useRef(false); // has this run's baseline been taken yet
  const graphRef = useRef(null); // the SSE closure outlives every graph it sees
  // The coverage verdict, sticky per runId. Lives here rather than in the
  // Canvas because the graph does, and neither this component nor the Canvas
  // is remounted on a run switch — see the caveat computed below.
  const coverageSticky = useRef({ runId: null, verdict: 'none' });

  // Run index, refreshed for live badges.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchIndex().then((d) => alive && setIndex(d)).catch(() => {});
    load();
    // Static embed: the baked index cannot change, so polling it is noise.
    const t = EMBED ? null : setInterval(load, 15000);
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, []);

  // Selected run: initial graph fetch + SSE live tail.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    setGraph(null);
    setGraphError(null);
    setSelection(null);
    // Focus, find and the escalation baseline are all per-run.
    setFocus(null);
    setFindOpen(false);
    setQuery('');
    setNote(null);
    setLinkMiss(null);
    setResumePop(null);
    setEscalated(false);
    seenHigh.current = new Set();
    primed.current = false;
    fetchGraph(runId)
      .then((g) => alive && setGraph((cur) => cur ?? g))
      .catch((e) => alive && setGraphError(String(e.message ?? e)));
    const unwatch = watchGraph(
      runId,
      (msg) => {
        if (!alive) return;
        if (msg.type === 'focus') {
          // The agent answered in the user's terminal and asked the graph to
          // light up. Stash it rather than applying it here: the answer may be
          // about a run this tab has not loaded (or has not even switched to
          // yet), and pruning against the wrong graph would throw it away.
          const f = focusFromAgent(msg);
          if (!f) return;
          const target = msg.runId ?? runId;
          if (target !== runId) {
            // A tab already showing that run will take it; two tabs both
            // lurching onto the same run is worse than one staying put.
            if (msg.alreadyWatching) return;
            // Otherwise follow the answer, and remember where we were so the
            // user can get back with one click.
            pendingFocus.current = { runId: target, focus: f };
            setSwitchedFrom({ runId, title: graphRef.current?.meta?.title ?? null });
            setRunId(target);
            return;
          }
          pendingFocus.current = { runId: target, focus: f };
          applyPendingFocus(graphRef.current);
          return;
        }
        setGraph((cur) => applyDelta(cur, msg));
      },
      (ok) => alive && setConnected(ok),
    );
    // The embedding page owns its URL (its own anchors live in the hash); the
    // run param is the dashboard's concern only.
    if (!EMBED) {
      const url = new URL(location.href);
      url.searchParams.set('run', runId);
      // A consumed or bypassed deep link must not linger in the address bar —
      // copying it there would hand someone a link to a run you already left.
      if (parseFocusHash(url.hash)?.runId !== runId) url.hash = '';
      history.replaceState(null, '', url);
    }
    return () => {
      alive = false;
      unwatch();
    };
  }, [runId]);

  const currentRun = useMemo(
    () => index?.runs?.find((r) => r.runId === runId),
    [index, runId],
  );
  const live = currentRun?.active ?? false;
  // Paths are stored as the adapter observed them; only the display is relative,
  // and the project root comes from the index entry — IR meta does not carry one.
  const project = currentRun?.project;

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  /**
   * Apply an agent's focus once the graph it points into is actually loaded.
   * Called both from the SSE handler (same run, graph already in hand) and from
   * the effect below (after a run switch, or after a tab opened cold and the
   * server replayed a focus it was holding).
   */
  const applyPendingFocus = (g) => {
    const p = pendingFocus.current;
    if (!p || !g || g.meta?.runId !== p.runId) return;
    pendingFocus.current = null;
    // An agent has driven this dashboard at least once, so the inspector can
    // stop showing setup instructions to someone who is clearly set up.
    try {
      localStorage.setItem('rungraph.agentSeen', '1');
    } catch {
      /* storage unavailable — the hint simply keeps showing */
    }
    // Ids can be quoted from a graph read moments ago. If none of them are
    // here, dimming the entire canvas is worse than doing nothing.
    const pruned = pruneFocus(p.focus, g);
    if (!pruned) return setNote('your agent pointed at nodes not in this run');
    setFocus(pruned);
    setFocusSeq((n) => n + 1); // only an agent's answer moves the viewport
  };

  useEffect(() => applyPendingFocus(graph), [graph]);

  /**
   * Deep-link restore: once the linked run's graph is in hand, replay the
   * descriptor through the SAME producers a live click would use — find,
   * signal and file descriptors re-execute (one matcher, one derivation, one
   * attribution source, so a link and a fresh query can never disagree), and
   * only agent-sourced sets are explicit ids. The view pans: the user clicked
   * a link, so the view should have moved.
   */
  // A link pasted into an ALREADY-OPEN tab changes only the hash — no reload,
  // no mount. Catching hashchange makes those links work too.
  useEffect(() => {
    const onHash = () => {
      const link = parseFocusHash(location.hash);
      if (!link) return;
      pendingLink.current = link;
      setSwitchedFrom(null);
      setRunId(link.runId);
      setLinkSeq((n) => n + 1); // same-run links re-apply without a graph change
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const link = pendingLink.current;
    if (!link || !graph || graph.meta?.runId !== link.runId) return;
    pendingLink.current = null;
    if (link.sel && graph.nodes.some((n) => n.id === link.sel)) {
      setSelection({ type: 'node', id: link.sel });
    }
    const d = link.descriptor;
    if (!d) return;
    let f = null;
    if (d.source === 'find') {
      setFindOpen(true);
      setQuery(d.query);
      f = focusFromFind(graph, d.query);
    } else if (d.source === 'signal') {
      const sig = (graph.signals ?? []).find((s) => s.id === d.signalId);
      f = sig ? focusFromSignal(sig) : null;
      if (!sig) setNote('that signal is no longer derived for this run');
    } else if (d.source === 'file') {
      f = focusFromFile(graph, d.path, project);
    } else if (d.source === 'agent') {
      // Filter to known ids; if that empties the set, clear focus and say so
      // (the live-delta rule, reused).
      f = pruneFocus({ nodeIds: d.nodeIds, label: d.label || 'linked nodes', reason: d.reason, source: 'agent' }, graph);
      if (!f) setNote('the linked nodes are gone from this run');
    }
    if (f) {
      setFocus({ ...f, pan: true });
      setFocusSeq((n) => n + 1);
    }
  }, [graph, linkSeq]);

  // A deep link to a run this server does not have: ask our own server, which
  // consults the port registry and probes the other live dashboards. Found →
  // the banner upgrades to a jump offer; otherwise it names the runId and
  // stops. Never a blank screen. Only a 404 means "not here" — a transient
  // load failure must not claim a run is missing, and a run this very server
  // owns (locate answers self:true) is a plain load error, not a miss.
  useEffect(() => {
    if (!graphError || !runId || !/\b404\b/.test(graphError)) return;
    let alive = true;
    fetch(`/api/locate/${encodeURIComponent(runId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.found && d.self) return; // it's here — the graph error stands on its own
        setLinkMiss(d.found ? { runId, url: d.url } : { runId });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [graphError, runId]);

  // The moment a graph loads, any miss banner is stale by definition.
  useEffect(() => {
    if (graph) setLinkMiss(null);
  }, [graph]);

  // Copy-link: the current view — run, selected node, focus — as a URL hash.
  const copyLink = () => {
    const hash = buildFocusHash({
      runId,
      sel: selection?.type === 'node' ? selection.id : undefined,
      descriptor: descriptorFromFocus(focus),
    });
    const link = `${location.origin}/${hash}`;
    navigator.clipboard?.writeText(link).then(
      () => setNote('link copied — it restores this exact view'),
      () => setNote(`could not copy — the link is ${link}`),
    );
  };

  // Reconcile the focus against the graph it points into, once per graph change.
  // A live delta can delete the nodes underneath a focus, and can grow the very
  // signal the user is looking at — so a producer-backed focus is re-derived,
  // not merely pruned, or the chip and the canvas drift apart.
  useEffect(() => {
    if (!graph || !focus) return;
    const next = refocus(focus, graph, project);
    if (next === focus) return;
    setFocus(next);
    if (!next) setNote('those nodes are gone from this run');
  }, [graph]);

  // A delta can also delete the node or edge the inspector is showing (a
  // resumed workflow merges into the original node; a tool group's id moves
  // when a truncated line is re-read). NodeDetail renders nothing for an id
  // that is gone, so without this the pane stays blank until the next click.
  useEffect(() => {
    if (!graph || !selection) return;
    const list = selection.type === 'edge' ? graph.edges : graph.nodes;
    if (list.some((x) => x.id === selection.id)) return;
    setSelection(null);
    setNote(`that ${selection.type} is gone from this run`);
  }, [graph]);

  // Ambient when things are fine, loud when they are not: a `high` signal that
  // appeared since the user last looked. The first signal set a run produces is
  // the baseline — whatever was already wrong when they opened it is context,
  // not news, so only a genuinely new one escalates.
  useEffect(() => {
    if (!graph) return;
    const signals = graph.signals ?? [];
    if (!primed.current) {
      for (const s of signals) if (s.severity === 'high') seenHigh.current.add(signalKey(s));
      primed.current = true;
      return;
    }
    if (newHighSignalIds(signals, seenHigh.current).length > 0) setEscalated(true);
  }, [graph]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  // Clicking a chip or pressing Esc means the user looked: the strip drops back
  // to ambient and the current `high` set becomes the new baseline.
  const acknowledge = () => {
    for (const s of graph?.signals ?? []) {
      if (s.severity === 'high') seenHigh.current.add(signalKey(s));
    }
    setEscalated(false);
  };

  const clearFocus = () => {
    acknowledge();
    setFocus(null);
    setFindOpen(false);
    setQuery('');
  };

  const toggleSignal = (s) => {
    acknowledge();
    setFocus((cur) =>
      cur?.source === 'signal' && cur.signalId === s.id ? null : focusFromSignal(s),
    );
  };

  const runQuery = (q) => {
    setQuery(q);
    setFocus(focusFromFind(graph, q)); // local filter — no round trip per keystroke
  };

  const togglePane = (side) => setPanes((cur) => savePanes({ ...cur, [side]: !cur[side] }));

  // Narrow embed: the inspector rides the selection — tap a node and it
  // slides over, deselect (Esc, close, empty canvas) and the graph is back.
  // Raw setter on purpose: a phone visitor's transient state must not be
  // persisted as a preference.
  useEffect(() => {
    if (!embedNarrow()) return;
    setPanes((cur) =>
      cur.right === Boolean(selection) ? cur : { ...cur, right: Boolean(selection) },
    );
  }, [selection]);

  // Embed bridge (landing page guided chips). Re-registered per render on
  // purpose: the closures must see the current graph and focus, and a plain
  // object assignment costs nothing. Signal focus reuses the deep-link
  // restore behavior (focusFromSignal + pan), find reuses the canvas's own
  // opener — one producer per behavior, here as everywhere.
  useEffect(() => {
    if (!EMBED) return;
    EMBED.app = {
      focusSignalKind(kind) {
        const signals = graph?.signals ?? [];
        const s = signals.find((x) => x.kind === kind) ?? signals[0];
        if (!s) return false;
        acknowledge();
        setSelection(null);
        setFocus({ ...focusFromSignal(s), pan: true });
        setFocusSeq((n) => n + 1);
        return true;
      },
      openFind() {
        acknowledge();
        setFindOpen(true);
        setFindSeq((n) => n + 1);
      },
      // The captured MCP answer, replayed onto the live embed — the same
      // agent-sourced focus shape POST /api/focus would deliver.
      focusNodes(nodeIds, label, reason) {
        const f = pruneFocus(
          { nodeIds: [...(nodeIds ?? [])], label: label || 'from your agent', reason: reason ?? '', source: 'agent' },
          graph,
        );
        if (!f) return false;
        acknowledge();
        setSelection(null);
        setFocus(f);
        setFocusSeq((n) => n + 1);
        return true;
      },
      clearFocus,
    };
  });

  // Any run the user chooses themselves ends the "your agent moved you" offer —
  // there is nothing to undo once they have navigated on their own.
  const selectRun = (id) => {
    setSwitchedFrom(null);
    setRunId(id);
  };

  // Resume popover, anchored to whichever affordance opened it (the header
  // button or a picker-row hover action). One popover, entry snapshot in hand.
  const openResume = (entry, rect) =>
    setResumePop({ entry, anchor: { left: rect.left, bottom: rect.bottom } });

  const undoSwitch = () => {
    const back = switchedFrom;
    setSwitchedFrom(null);
    if (back?.runId) setRunId(back.runId);
  };

  // "[" and "]" collapse the panes either side of the graph. Registered here
  // rather than in the canvas because they must work with no run loaded, and
  // must not fire while the find box has the caret.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // No pane toggles in the embed: the header buttons that would undo a
      // collapse are hidden there, so a stray "]" would trap the visitor
      // with no sidebar and no way back.
      if (EMBED) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === '[') togglePane('left');
      else if (e.key === ']') togglePane('right');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Coverage: how much of this run rungraph could read at all, classified
  // SERVER-SIDE-DERIVED-STYLE by the one shared implementation — the same
  // `classifyCoverage` the MCP note comes from, so the badge on screen and the
  // caveat in the terminal can never disagree about the same run.
  //
  // STICKY ONCE SHOWN, per runId. During live tail a signal can appear on a
  // later tick, flipping `signalCount === 0` false and retracting the caveat at
  // the exact moment the run gets interesting. Coverage did not improve — a
  // different condition changed, and `unrecognized` only ever grows — so a
  // retraction would be misinformation. It escalates (quiet → loud) but never
  // steps back down within a run; navigating away and back recomputes and
  // lands on the same verdict a cold open would give.
  const coverage = (() => {
    const meta = graph?.meta;
    const id = meta?.runId ?? null;
    const fresh = classifyCoverage(meta, graph?.signals?.length ?? 0);
    const prev = coverageSticky.current.runId === id ? coverageSticky.current.verdict : 'none';
    const verdict = strongerCoverage(prev, fresh);
    if (coverageSticky.current.runId !== id || coverageSticky.current.verdict !== verdict) {
      coverageSticky.current = { runId: id, verdict };
    }
    if (verdict === 'none') return null;
    const types = unknownTypeSummary(meta);
    return {
      verdict,
      label: coverageLabel(meta),
      title: `${meta.coverage.unrecognized} of ${meta.coverage.records} records could not be parsed${
        types ? ` (${types})` : ''
      }${meta.coverage.sourcesUnread > 0 ? `; ${meta.coverage.sourcesUnread} referenced transcript(s) could not be opened` : ''}`,
    };
  })();

  return (
    <div class="app">
      <header class="header">
        <button
          class="ghost pane-toggle"
          data-on={String(panes.left)}
          onClick={() => togglePane('left')}
          title="runs list  ( [ )"
          aria-label="toggle the runs list"
          aria-pressed={String(panes.left)}
        >
          ▤
        </button>
        <span class="brand"><b>run</b>graph</span>
        <span class="run-title">
          {graph ? (
            <>
              <strong>{graph.meta.title || '(untitled)'}</strong>
              {'  ·  '}
              {graph.meta.kind}
            </>
          ) : (
            'pick a run'
          )}
        </span>
        {graph && (
          <span class="adapter-tag" data-adapter={graph.meta.adapter} title={`reconstructed by the ${graph.meta.adapter} adapter`}>
            {adapterName(graph.meta.adapter)}
          </span>
        )}
        {currentRun?.provenance && (
          <span
            class="badge-shared"
            title={`from ${currentRun.provenance.bundle}${currentRun.provenance.snapshot ? ' — exported while the run was live' : ''}`}
          >
            shared by {currentRun.provenance.sharedBy}
          </span>
        )}
        {live && connected && <span class="badge-live">live</span>}
        {runId && !connected && <span class="microlabel">reconnecting…</span>}
        {currentRun?.resume && (
          <button
            class="ghost"
            data-on={String(resumePop?.entry.runId === currentRun.runId)}
            onClick={(e) => openResume(currentRun, e.currentTarget.getBoundingClientRect())}
            title="continue this conversation in your terminal"
          >
            resume
          </button>
        )}
        {graph && (
          <button class="ghost" onClick={copyLink} title="copy a link that restores this exact view">
            copy link
          </button>
        )}
        {live && (
          <button
            class="ghost"
            data-on={String(follow)}
            onClick={() => setFollow(!follow)}
            title="Auto-follow new nodes as they appear"
          >
            {follow ? 'following' : 'follow'}
          </button>
        )}
        {graph && (
          <button
            class="ghost pane-toggle"
            data-on={String(panes.right)}
            onClick={() => togglePane('right')}
            title="run details  ( ] )"
            aria-label="toggle the run details pane"
            aria-pressed={String(panes.right)}
          >
            ▥
          </button>
        )}
      </header>
      <div class="main" data-left={String(panes.left)} data-right={String(panes.right)}>
        <Picker index={index} runId={runId} onSelect={selectRun} onResume={openResume} />
        <div class="center">
          {linkMiss && (
            <div class="link-banner">
              {linkMiss.url ? (
                <>
                  this run isn't on this dashboard — it's open on {linkMiss.url}
                  <a
                    class="jump"
                    href={`${linkMiss.url}/${location.hash || `#run=${encodeURIComponent(linkMiss.runId)}`}`}
                  >
                    jump to it →
                  </a>
                </>
              ) : (
                <>no dashboard here serves run {linkMiss.runId} — was its bundle closed?</>
              )}
            </div>
          )}
          <Strip
            signals={graph?.signals}
            focus={focus}
            escalated={escalated}
            coverage={coverage}
            note={note}
            switchedFrom={switchedFrom}
            onUndoSwitch={undoSwitch}
            findOpen={findOpen}
            findSeq={findSeq}
            query={query}
            matchCount={focus?.source === 'find' ? focus.nodeIds.length : null}
            onToggleSignal={toggleSignal}
            onShowAll={() => {
              acknowledge();
              setSelection(null); // the run overview is where the full list lives
            }}
            onQuery={runQuery}
            onCloseFind={clearFocus}
          />
          <Canvas
            graph={graph}
            error={graphError}
            selection={selection}
            onSelect={setSelection}
            follow={follow && live}
            live={live}
            onUserPan={() => setFollow(false)}
            focus={focus}
            focusSeq={focusSeq}
            onClearFocus={clearFocus}
            onOpenFind={() => {
              acknowledge();
              setFindOpen(true);
              // A counter, not the boolean: pressing "/" with find already open
              // must still put the caret back in the box, or the next keystroke
              // walks the graph instead of typing.
              setFindSeq((n) => n + 1);
            }}
            inspectorOpen={Boolean(graph) && panes.right}
            // The banner stands down under a loud badge — one statement of one
            // fact. Passed rather than recomputed: a second classify call here
            // could disagree with the strip's, which is the whole failure the
            // shared classifier exists to prevent.
            coverage={coverage}
          />
        </div>
        <Inspector
          graph={graph}
          open={panes.right}
          runId={runId}
          project={project}
          selection={selection}
          focus={focus}
          onClose={() => setSelection(null)}
          onOpenRun={selectRun}
          onSelectNode={(id) => setSelection({ type: 'node', id })}
          onFocusSignal={toggleSignal}
          onFocusFile={(path) => {
            acknowledge();
            setFocus(focusFromFile(graph, path, project));
          }}
        />
      </div>
      {resumePop && (
        <ResumePopover
          // Keyed by run: the fork pre-check (and busy/copied state) is derived
          // at mount, so swapping entries without a remount would carry one
          // run's state onto another — losing the live-run fork default.
          key={resumePop.entry.runId}
          entry={resumePop.entry}
          anchor={resumePop.anchor}
          onClose={() => setResumePop(null)}
          onNote={setNote}
        />
      )}
    </div>
  );
}

const PANES_KEY = 'rungraph.panes';

/**
 * Both side panes collapse. The right one especially: it is open for the whole
 * life of a loaded run now, so on a laptop it is a permanent tax on the graph
 * rather than an occasional one — and the graph is the thing people came for.
 */
function loadPanes() {
  // The embed never reads (or trusts) persisted pane preferences: they are
  // dashboard chrome, and with the header hidden there is no affordance to
  // undo a stored "collapsed" state. Desktop embed: inspector always open;
  // narrow embed: it rides the selection instead.
  if (EMBED) return { left: true, right: !embedNarrow() };
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) ?? 'null');
    return { left: raw?.left !== false, right: raw?.right !== false };
  } catch {
    return { left: true, right: true };
  }
}

function savePanes(panes) {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(panes));
  } catch {
    /* storage unavailable — collapsing still works for this session */
  }
  return panes;
}

const GROUPS_KEY = 'rungraph.projectGroups';

// Only groups the user has explicitly toggled are stored, as project -> 'open' | 'closed'.
// Untouched groups follow the default rule, so projects that appear later — or drift in
// recency — still land somewhere sensible instead of inheriting a stale choice.
function loadGroupPrefs() {
  try {
    localStorage.removeItem('rungraph.collapsedProjects'); // superseded
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveGroupPrefs(prefs) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — collapsing still works for this session */
  }
  return prefs;
}

function Picker({ index, runId, onSelect, onResume }) {
  const [prefs, setPrefs] = useState(loadGroupPrefs);
  // The agent rail's single-select filter. Component state only — a sticky
  // filter is a "where did my runs go" footgun days later, so a reload
  // starts unfiltered. Group open/closed prefs stay persisted as before.
  const [filter, setFilter] = useState(null);
  // Share mode: check off runs, hit export. Backed by GET /api/export — the
  // same export module the CLI uses, so the consent surface cannot fork.
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState(() => new Set());
  const [exporting, setExporting] = useState(null); // the checked entries, frozen

  const selectedEntry = index?.runs?.find((r) => r.runId === runId);
  // The group key doubles as the pref key, so it must come from the one
  // implementation (bundle > loose bucket > case-merged path).
  const selectedGroupKey = selectedEntry ? groupKeyFor(selectedEntry) : null;
  // A bundle viewer serves someone else's runs: re-export is refused there
  // ("send the original file instead"), so the affordance does not appear.
  const bundleMode = Boolean(index?.runs?.length) && index.runs.every((r) => r.provenance);
  // Adapter tags appear exactly when there is a distinction to draw: a list
  // that is all one vendor stays untagged (the strip's own rule — say
  // nothing when there is nothing to say), a mixed list tags every run.
  // The agent rail rides the same gate: single-adapter machines (and the
  // landing-page embed, whose baked index is single-adapter) see no rail.
  const multiAdapter = new Set((index?.runs ?? []).map((r) => r.adapter)).size > 1;

  const toggleChecked = (id) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Reaching a run in a group you had closed (deep link, inspector jump) reveals it again.
  useEffect(() => {
    if (!selectedGroupKey) return;
    setPrefs((cur) => {
      if (cur[selectedGroupKey] !== 'closed') return cur;
      const next = { ...cur };
      delete next[selectedGroupKey];
      return saveGroupPrefs(next);
    });
  }, [selectedGroupKey]);

  // The rail-side twin of the reveal effect: when the selection stops
  // matching the filter — deep link, inspector jump, a focus_nodes arrival
  // switching the tab to another run — the filter clears. The answer the
  // agent just pointed at must never land on a hidden row. Deliberately NOT
  // keyed on `filter`: clicking a chip while an off-adapter run is selected
  // is the user's own act, and must not be instantly undone.
  useEffect(() => {
    if (!runId) return;
    setFilter((cur) => {
      const entry = index?.runs?.find((r) => r.runId === runId);
      return cur && entry && entry.adapter !== cur ? null : cur;
    });
  }, [runId, index]);

  const setGroup = (key, open) =>
    setPrefs((cur) => saveGroupPrefs({ ...cur, [key]: open ? 'open' : 'closed' }));

  if (!index) return <aside class="picker" />;
  if (!index.runs?.length) {
    return (
      <aside class="picker">
        {index.errors?.map((e) => (
          <div class="bundle-error" key={e.file} title={e.error}>
            <b>{e.file}</b> — {e.error}
          </div>
        ))}
        <div class="empty">
          <p>No runs found.</p>
          <p>
            rungraph reads the transcripts your coding agent already writes to disk.
            Run an agent session, then refresh — no setup needed, past sessions appear
            retroactively.
          </p>
        </div>
      </aside>
    );
  }

  // The grouping opinion lives in picker-groups.js (bundle keying, the loose
  // bucket, case merging, recency order, the filter, the counts); this
  // component only renders its output.
  const groups = groupRuns(index.runs, { filter });
  const chips = adapterChips(index.runs);

  // The first group is the project worked in most recently. It and the
  // selected run's group open by default; the rest start collapsed, which
  // keeps the list one screen tall on machines with many projects. An active
  // filter opens every surviving group (it typically leaves a handful);
  // explicit open/closed prefs still win either way.
  const openFor = (g) => {
    if (prefs[g.key]) return prefs[g.key] === 'open';
    if (filter) return true;
    return g.key === groups[0]?.key || g.key === selectedGroupKey;
  };

  return (
    <aside class="picker">
      {/* A corrupt bundle degrades to a named banner; the others still serve. */}
      {index.errors?.map((e) => (
        <div class="bundle-error" key={e.file} title={e.error}>
          <b>{e.file}</b> — {e.error}
        </div>
      ))}
      {multiAdapter && (
        <div class="agent-rail" role="group" aria-label="filter runs by agent">
          <button
            class="chip"
            data-on={String(filter === null)}
            onClick={() => setFilter(null)}
            title="show every agent's runs"
          >
            all <span class="n">{index.runs.length}</span>
          </button>
          {chips.map((c) => (
            <button
              class="chip"
              key={c.adapter}
              data-adapter={c.adapter}
              data-on={String(filter === c.adapter)}
              onClick={() => setFilter((cur) => (cur === c.adapter ? null : c.adapter))}
              title={`show only ${c.name} runs`}
              aria-pressed={String(filter === c.adapter)}
            >
              {c.live && <span class="live">●</span>}
              {c.name} <span class="n">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {!bundleMode && (
        <div class="picker-tools">
          {selectMode ? (
            <>
              <button
                class="ghost primary"
                disabled={checked.size === 0}
                onClick={() => setExporting(index.runs.filter((r) => checked.has(r.runId)))}
              >
                export {checked.size || ''} run{checked.size === 1 ? '' : 's'}…
              </button>
              <button
                class="ghost"
                onClick={() => {
                  setSelectMode(false);
                  setChecked(new Set());
                }}
              >
                cancel
              </button>
            </>
          ) : (
            <button class="ghost" onClick={() => setSelectMode(true)} title="export runs as a shareable .rungraph bundle">
              share…
            </button>
          )}
        </div>
      )}
      {groups.map((g) => {
        const open = openFor(g);
        const groupId = `project-${encodeURIComponent(g.key)}`;
        return (
          <div
            class="project-group"
            key={g.key}
            data-kind={g.kind}
            data-open={String(open)}
            data-holds-selection={String(g.runs.some((r) => r.runId === runId))}
          >
            <button
              class="section project-toggle"
              onClick={() => setGroup(g.key, !open)}
              aria-expanded={String(open)}
              aria-controls={groupId}
              title={g.label}
            >
              <span class="chev" aria-hidden="true" />
              <ProjectLabel project={g.label} />
              <span class="count">
                {g.live > 0 && <span class="live">●</span>}
                {/* Plain n when everything matches; "k of n" when the filter
                    narrowed a mixed group. */}
                {g.runs.length === g.total ? g.total : `${g.runs.length} of ${g.total}`}
              </span>
            </button>
            {open && (
              <div class="project-runs" id={groupId}>
                {g.runs.map((r) => (
                  // A wrapper, not nesting: the hover-revealed resume action is
                  // a sibling of the row button (a button inside a button is
                  // invalid HTML and breaks activation).
                  <div class="run-row" key={r.runId}>
                    <button
                      class="run-item"
                      data-selected={String(!selectMode && r.runId === runId)}
                      data-checked={String(selectMode && checked.has(r.runId))}
                      onClick={() => (selectMode ? toggleChecked(r.runId) : onSelect(r.runId))}
                      title={r.runId}
                    >
                      <div class="title">
                        {selectMode && (
                          <span class="check" aria-hidden="true">
                            {checked.has(r.runId) ? '☑' : '☐'}
                          </span>
                        )}
                        {r.title}
                      </div>
                      <div class="sub">
                        {multiAdapter && (
                          <span class="adapter" data-adapter={r.adapter}>
                            {adapterName(r.adapter)}
                          </span>
                        )}
                        <span class={`kind-${r.kind}`}>
                          {r.kind === 'workflow' ? 'wf' : 'session'}
                        </span>
                        <span>{timeAgo(r.modifiedAt)}</span>
                        {r.active && <span class="live">● live</span>}
                        {r.provenance && (
                          <span
                            class="provenance"
                            title={`${r.provenance.bundle} · exported ${r.provenance.exportedAt ?? ''}`}
                          >
                            shared by {r.provenance.sharedBy}
                          </span>
                        )}
                        {r.provenance?.snapshot && (
                          <span class="provenance snap" title={`exported while live, at ${r.provenance.snapshot}`}>
                            snapshot
                          </span>
                        )}
                      </div>
                    </button>
                    {!selectMode && r.resume && onResume && (
                      <button
                        class="ghost resume-hint"
                        title="continue this conversation in your terminal"
                        aria-label={`resume ${r.title}`}
                        onClick={(e) => onResume(r, e.currentTarget.getBoundingClientRect())}
                      >
                        resume
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {exporting && (
        <ExportDialog
          runs={exporting}
          onClose={() => {
            setExporting(null);
            setSelectMode(false);
            setChecked(new Set());
          }}
        />
      )}
    </aside>
  );
}

function shortProject(p) {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

// Sibling worktrees and dated directories differ only in a trailing id, which a plain
// end-ellipsis eats — so the label is split and truncated in the middle instead: the head
// shrinks to fit, the tail is pinned and always readable.
const TAIL_CHARS = 14;

function ProjectLabel({ project }) {
  const label = shortProject(project);
  const split = label.length > TAIL_CHARS + 6;
  return (
    <span class="microlabel">
      <span class="head">{split ? label.slice(0, -TAIL_CHARS) : label}</span>
      {split && <span class="tail">{label.slice(-TAIL_CHARS)}</span>}
    </span>
  );
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
