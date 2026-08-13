import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchIndex, fetchGraph, watchGraph, applyDelta } from './api.js';
import { Canvas } from './canvas.jsx';
import { Inspector } from './inspector.jsx';
import { Strip } from './strip.jsx';
import {
  focusFromAgent,
  focusFromFile,
  focusFromFind,
  focusFromSignal,
  newHighSignalIds,
  pruneFocus,
  refocus,
  signalKey,
} from './focus.js';

export function App() {
  const [index, setIndex] = useState(null);
  const [runId, setRunId] = useState(() => new URLSearchParams(location.search).get('run'));
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
  const seenHigh = useRef(new Set()); // `high` signal ids the user has looked at
  const primed = useRef(false); // has this run's baseline been taken yet
  const graphRef = useRef(null); // the SSE closure outlives every graph it sees

  // Run index, refreshed for live badges.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchIndex().then((d) => alive && setIndex(d)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
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
          // light up. focusSeq is what tells the canvas this is a *new* answer
          // and therefore worth moving the viewport for.
          const f = focusFromAgent(msg);
          if (!f) return;
          // Ids can be quoted from a graph read moments ago. If none of them
          // are here, dimming the entire canvas is worse than doing nothing.
          const pruned = graphRef.current ? pruneFocus(f, graphRef.current) : f;
          if (!pruned) return setNote('your agent pointed at nodes not in this run');
          setFocus(pruned);
          setFocusSeq((n) => n + 1);
          return;
        }
        setGraph((cur) => applyDelta(cur, msg));
      },
      (ok) => alive && setConnected(ok),
    );
    const url = new URL(location.href);
    url.searchParams.set('run', runId);
    history.replaceState(null, '', url);
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

  return (
    <div class="app">
      <header class="header">
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
        {live && connected && <span class="badge-live">live</span>}
        {runId && !connected && <span class="microlabel">reconnecting…</span>}
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
      </header>
      <div class="main">
        <Picker index={index} runId={runId} onSelect={setRunId} />
        <div class="center">
          <Strip
            signals={graph?.signals}
            focus={focus}
            escalated={escalated}
            note={note}
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
            inspectorOpen={Boolean(graph)}
          />
        </div>
        <Inspector
          graph={graph}
          runId={runId}
          project={project}
          selection={selection}
          focus={focus}
          onClose={() => setSelection(null)}
          onOpenRun={setRunId}
          onSelectNode={(id) => setSelection({ type: 'node', id })}
          onFocusSignal={toggleSignal}
          onFocusFile={(path) => {
            acknowledge();
            setFocus(focusFromFile(graph, path, project));
          }}
        />
      </div>
    </div>
  );
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

function Picker({ index, runId, onSelect }) {
  const [prefs, setPrefs] = useState(loadGroupPrefs);

  const selectedProject = index?.runs?.find((r) => r.runId === runId)?.project;

  // Reaching a run in a group you had closed (deep link, inspector jump) reveals it again.
  useEffect(() => {
    if (!selectedProject) return;
    setPrefs((cur) => {
      if (cur[selectedProject] !== 'closed') return cur;
      const next = { ...cur };
      delete next[selectedProject];
      return saveGroupPrefs(next);
    });
  }, [selectedProject]);

  const setGroup = (project, open) =>
    setPrefs((cur) => saveGroupPrefs({ ...cur, [project]: open ? 'open' : 'closed' }));

  if (!index) return <aside class="picker" />;
  if (!index.runs?.length) {
    return (
      <aside class="picker">
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

  const byProject = new Map();
  for (const r of index.runs) {
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }

  // Runs arrive newest-first, so the first group is the project worked in most recently.
  // It and the selected run's project open by default; the rest start collapsed, which
  // keeps the list one screen tall on machines with many projects.
  const openByDefault = new Set(
    [[...byProject.keys()][0], selectedProject].filter(Boolean),
  );

  return (
    <aside class="picker">
      {[...byProject.entries()].map(([project, runs]) => {
        const open = prefs[project] ? prefs[project] === 'open' : openByDefault.has(project);
        const liveCount = runs.filter((r) => r.active).length;
        const groupId = `project-${encodeURIComponent(project)}`;
        return (
          <div
            class="project-group"
            key={project}
            data-open={String(open)}
            data-holds-selection={String(runs.some((r) => r.runId === runId))}
          >
            <button
              class="section project-toggle"
              onClick={() => setGroup(project, !open)}
              aria-expanded={String(open)}
              aria-controls={groupId}
              title={project}
            >
              <span class="chev" aria-hidden="true" />
              <ProjectLabel project={project} />
              <span class="count">
                {liveCount > 0 && <span class="live">●</span>}
                {runs.length}
              </span>
            </button>
            {open && (
              <div class="project-runs" id={groupId}>
                {runs.map((r) => (
                  <button
                    key={r.runId}
                    class="run-item"
                    data-selected={String(r.runId === runId)}
                    onClick={() => onSelect(r.runId)}
                    title={r.runId}
                  >
                    <div class="title">{r.title}</div>
                    <div class="sub">
                      <span class={`kind-${r.kind}`}>
                        {r.kind === 'workflow' ? 'wf' : 'session'}
                      </span>
                      <span>{timeAgo(r.modifiedAt)}</span>
                      {r.active && <span class="live">● live</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
