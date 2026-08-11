import { useEffect, useState } from 'preact/hooks';
import { fetchDetail } from './api.js';
import { fmtTokens, fmtDuration } from './canvas.jsx';

export function Inspector({ graph, runId, selection, onClose, onOpenRun }) {
  const open = Boolean(selection && graph);
  return (
    <aside class="inspector" data-open={String(open)}>
      {open && (
        <div class="inspector-inner">
          <button class="ghost close" onClick={onClose}>close</button>
          {selection.type === 'node' ? (
            <NodeDetail graph={graph} runId={runId} nodeId={selection.id} onOpenRun={onOpenRun} />
          ) : (
            <EdgeDetail graph={graph} edgeId={selection.id} />
          )}
        </div>
      )}
    </aside>
  );
}

function NodeDetail({ graph, runId, nodeId, onOpenRun }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);

  // nodeStamp changes whenever a live-tail delta updates this node, so the
  // detail re-fetches instead of going stale mid-run.
  const nodeStamp = node ? JSON.stringify(node) : '';
  useEffect(() => {
    setFailed(false);
    if (!node?.hasDetail) return;
    let alive = true;
    fetchDetail(runId, nodeId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [runId, nodeId, nodeStamp]);
  useEffect(() => setDetail(null), [runId, nodeId]);

  if (!node) return null;

  return (
    <>
      <div class="microlabel">{node.kind}</div>
      <h2>{node.label}</h2>
      <dl class="kv">
        <dt>status</dt>
        <dd data-status={node.status}>{node.status}</dd>
        {node.model && (<><dt>model</dt><dd>{node.model}</dd></>)}
        {node.tokens && (
          <>
            <dt>tokens</dt>
            <dd>{fmtTokens(node.tokens.input)} in · {fmtTokens(node.tokens.output)} out</dd>
          </>
        )}
        {node.durationMs != null && (<><dt>duration</dt><dd>{fmtDuration(node.durationMs)}</dd></>)}
        {node.callCount > 1 && (<><dt>calls</dt><dd>{node.callCount}</dd></>)}
        {node.startedAt && (<><dt>started</dt><dd>{fmtTime(node.startedAt)}</dd></>)}
      </dl>

      {node.kind === 'workflow' && node.runRef && (
        <button class="ghost" onClick={() => onOpenRun(node.runRef)}>
          open workflow graph →
        </button>
      )}

      {node.hasDetail && !detail && !failed && <div class="loading">loading transcript…</div>}
      {failed && <div class="loading">transcript unavailable</div>}
      {detail && <DetailBody detail={detail} />}
    </>
  );
}

function DetailBody({ detail }) {
  switch (detail.kind) {
    case 'turn':
      return (
        <>
          <div class="microlabel section-label">prompt</div>
          <pre>{detail.prompt || '(empty)'}</pre>
          {detail.responseText && (
            <>
              <div class="microlabel section-label">response</div>
              <pre>{detail.responseText}</pre>
            </>
          )}
        </>
      );
    case 'agent':
      return (
        <>
          <div class="microlabel section-label">prompt given</div>
          <pre>{detail.prompt || '(unknown)'}</pre>
          {detail.result != null && (
            <>
              <div class="microlabel section-label">result</div>
              <pre>{detail.result}</pre>
            </>
          )}
          {detail.transcript?.length > 0 && (
            <>
              <div class="microlabel section-label">
                transcript ({detail.transcript.length} entries)
              </div>
              {detail.transcript.map((t, i) => (
                <div class="transcript-entry" key={i}>
                  <div class="who" data-role={t.role}>
                    {t.role}
                    {t.toolName ? ` · ${t.toolName}` : ''}
                  </div>
                  <pre>{t.text}</pre>
                </div>
              ))}
            </>
          )}
        </>
      );
    case 'tool':
      return (
        <>
          {detail.context && (
            <>
              <div class="microlabel section-label">why</div>
              <pre>{detail.context}</pre>
            </>
          )}
          <div class="microlabel section-label">{detail.calls.length} call{detail.calls.length === 1 ? '' : 's'}</div>
          {detail.calls.map((c, i) => (
            <div class="tool-call" key={i}>
              <div class="head">
                <span class={c.isError ? 'err' : 'ok'}>{c.isError ? '✕' : '✓'}</span>
                <span>#{i + 1}</span>
                {c.durationMs != null && <span>{fmtDuration(c.durationMs)}</span>}
              </div>
              <pre>{c.input}</pre>
              {c.output && <pre>{c.output}</pre>}
            </div>
          ))}
        </>
      );
    case 'human':
      return (
        <>
          {detail.context && (
            <>
              <div class="microlabel section-label">context</div>
              <pre>{detail.context}</pre>
            </>
          )}
          {detail.answer && (
            <>
              <div class="microlabel section-label">what the human did</div>
              <pre>{detail.answer}</pre>
            </>
          )}
        </>
      );
    case 'workflow':
      return (
        <>
          {detail.returnValue != null && (
            <>
              <div class="microlabel section-label">return value</div>
              <pre>{detail.returnValue}</pre>
            </>
          )}
        </>
      );
    default:
      return <pre>{JSON.stringify(detail, null, 2)}</pre>;
  }
}

function EdgeDetail({ graph, edgeId }) {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const from = graph.nodes.find((n) => n.id === edge.from);
  const to = graph.nodes.find((n) => n.id === edge.to);
  return (
    <>
      <div class="microlabel">{edge.kind} edge</div>
      <h2>
        {from?.label ?? edge.from} → {to?.label ?? edge.to}
      </h2>
      <dl class="kv">
        {edge.reason && (<><dt>reason</dt><dd>⚑ {edge.reason}</dd></>)}
      </dl>
      {edge.label && (
        <>
          <div class="microlabel section-label">
            {edge.kind === 'spawn' ? 'prompt' : edge.kind === 'return' ? 'result' : 'label'}
          </div>
          <pre>{edge.label}</pre>
        </>
      )}
    </>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
