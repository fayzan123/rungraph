import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchIndex, fetchGraph, watchGraph, applyDelta } from './api.js';
import { Canvas } from './canvas.jsx';
import { Inspector } from './inspector.jsx';

export function App() {
  const [index, setIndex] = useState(null);
  const [runId, setRunId] = useState(() => new URLSearchParams(location.search).get('run'));
  const [graph, setGraph] = useState(null);
  const [graphError, setGraphError] = useState(null);
  const [selection, setSelection] = useState(null); // {type:'node'|'edge', id}
  const [follow, setFollow] = useState(true);
  const [connected, setConnected] = useState(true);

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
    fetchGraph(runId)
      .then((g) => alive && setGraph((cur) => cur ?? g))
      .catch((e) => alive && setGraphError(String(e.message ?? e)));
    const unwatch = watchGraph(
      runId,
      (msg) => {
        if (alive) setGraph((cur) => applyDelta(cur, msg));
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
        <Canvas
          graph={graph}
          error={graphError}
          selection={selection}
          onSelect={setSelection}
          follow={follow && live}
          onUserPan={() => setFollow(false)}
        />
        <Inspector
          graph={graph}
          runId={runId}
          selection={selection}
          onClose={() => setSelection(null)}
          onOpenRun={setRunId}
        />
      </div>
    </div>
  );
}

function Picker({ index, runId, onSelect }) {
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

  return (
    <aside class="picker">
      {[...byProject.entries()].map(([project, runs]) => (
        <div class="project-group" key={project}>
          <div class="section">
            <span class="microlabel" title={project}>
              {shortProject(project)}
            </span>
          </div>
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
                <span class={`kind-${r.kind}`}>{r.kind === 'workflow' ? 'wf' : 'session'}</span>
                <span>{timeAgo(r.modifiedAt)}</span>
                {r.active && <span class="live">● live</span>}
              </div>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

function shortProject(p) {
  if (!p) return '(unknown)';
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
