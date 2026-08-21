import { useEffect, useMemo, useState } from 'preact/hooks';
import { fetchDetail } from './api.js';
import { fmtTokens, fmtDuration } from './canvas.jsx';
import { SIGNAL_GLYPHS } from './strip.jsx';
import { adapterName, filesIndex, rankedFocusNodes, relPath, signalsForNode } from './focus.js';
import { suggestQuestions } from './suggest.js';
import { coverageStats, unknownTypeSummary } from '../../src/coverage.js';

/**
 * The right pane answers "what is in this run" whenever nothing is selected and
 * "what is in this node" when something is — so it is open for the whole life of
 * a loaded graph, and `close` means "back to the run overview", not "collapse".
 */
export function Inspector({
  graph,
  open: paneOpen = true,
  runId,
  project,
  selection,
  focus,
  onClose,
  onOpenRun,
  onSelectNode,
  onFocusSignal,
  onFocusFile,
}) {
  const open = Boolean(graph) && paneOpen;
  return (
    <aside class="inspector" data-open={String(open)}>
      {open && (
        <div class="inspector-inner">
          {selection && <button class="ghost close" onClick={onClose}>close</button>}
          {selection?.type === 'node' ? (
            <NodeDetail
              graph={graph}
              runId={runId}
              project={project}
              nodeId={selection.id}
              focus={focus}
              onOpenRun={onOpenRun}
              onFocusSignal={onFocusSignal}
              onFocusFile={onFocusFile}
            />
          ) : selection?.type === 'edge' ? (
            <EdgeDetail graph={graph} edgeId={selection.id} />
          ) : (
            <RunOverview
              graph={graph}
              project={project}
              focus={focus}
              onSelectNode={onSelectNode}
              onFocusSignal={onFocusSignal}
              onFocusFile={onFocusFile}
            />
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * Nothing selected: the run's whole story, ranked. The focused set first (the
 * list to work down), then every signal — this is where `outlier` lives, since
 * it is deliberately never badged on the canvas — then the files it touched.
 */
function RunOverview({ graph, project, focus, onSelectNode, onFocusSignal, onFocusFile }) {
  const signals = graph.signals ?? [];
  const files = useMemo(() => filesIndex(graph), [graph]);
  const focused = useMemo(() => rankedFocusNodes(graph, focus), [graph, focus]);
  const totals = graph.meta?.totals ?? {};
  // A boring statistic seen a hundred times is legible the day it goes
  // non-trivial. The badge is dormant by design — on a healthy machine it
  // renders on nothing, ever — so without a persistent surface the user would
  // meet coverage for the first time on the day something breaks, and the
  // unknown record types would have nowhere to be read.
  const cov = coverageStats(graph.meta);
  const covTypes = cov && cov.unrecognized > 0 ? unknownTypeSummary(graph.meta) : '';
  const revertedCount = graph.nodes.filter((n) => n.reverted).length;

  return (
    <>
      <div class="microlabel">this run</div>
      <h2>{graph.meta?.title || '(untitled)'}</h2>
      <dl class="kv">
        <dt>agent</dt>
        <dd data-adapter={graph.meta?.adapter}>{adapterName(graph.meta?.adapter) || '(unknown)'}</dd>
        <dt>nodes</dt>
        <dd>{graph.nodes.length}</dd>
        {totals.toolCalls != null && (<><dt>tool calls</dt><dd>{totals.toolCalls}</dd></>)}
        {totals.agents != null && (<><dt>agents</dt><dd>{totals.agents}</dd></>)}
        {totals.tokens != null && (<><dt>tokens</dt><dd>{fmtTokens(totals.tokens)}</dd></>)}
        {cov && (
          <>
            <dt>records</dt>
            <dd
              data-partial={String(cov.unrecognized > 0 || cov.sourcesUnread > 0)}
              title="records this adapter read, out of the records it examined"
            >
              {cov.records - cov.unrecognized} / {cov.records}
              {cov.sourcesUnread > 0 && (
                <span class="microlabel">
                  {' '}+ {cov.sourcesUnread} unread source{cov.sourcesUnread === 1 ? '' : 's'}
                </span>
              )}
            </dd>
          </>
        )}
        {covTypes && (<><dt>unread</dt><dd title="record types this rungraph does not understand">{covTypes}</dd></>)}
        {/* A run-level count, because a reverted region can be off screen. This
            is an ACCURACY caveat, deliberately kept off the coverage badge:
            "how much could I read" and "how much of this still stands" are
            different questions, and collapsing them would corrupt the one
            meaning coverage has. */}
        {revertedCount > 0 && (
          <>
            <dt>reverted</dt>
            <dd title="nodes whose work the user rolled back — still recorded, no longer standing">
              {revertedCount} node{revertedCount === 1 ? '' : 's'} rolled back
            </dd>
          </>
        )}
      </dl>

      {focus && (
        <>
          <div class="microlabel section-label">focused — {focus.label}</div>
          {focus.reason && <p class="focus-reason">{focus.reason}</p>}
          <div class="rows">
            {focused.map((n) => (
              <button
                class="row"
                key={n.id}
                onClick={() => onSelectNode?.(n.id)}
                title={n.label}
              >
                <span class="tag">{n.kind}</span>
                <span class="grow">{n.label}</span>
                {n.errorCount > 0 && <span class="n err">{n.errorCount} err</span>}
              </button>
            ))}
            {focused.length === 0 && <div class="loading">nothing matched</div>}
          </div>
        </>
      )}

      {signals.length > 0 && (
        <>
          <div class="microlabel section-label">signals</div>
          <div class="rows">
            {signals.map((s) => (
              <SignalRow key={s.id} signal={s} focus={focus} onFocusSignal={onFocusSignal} />
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <div class="microlabel section-label">files touched</div>
          <div class="rows">
            {files.map((f) => (
              <button
                class="row"
                key={f.path}
                data-on={String(focus?.source === 'file' && focus.path === f.path)}
                onClick={() => onFocusFile?.(f.path)}
                title={f.path}
              >
                <span class="grow">{relPath(f.path, project)}</span>
                <span class="n">{f.count}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <AskYourAgent graph={graph} project={project} />
    </>
  );
}

/**
 * The other half of the loop, taught by demonstration.
 *
 * A user who only ever opens the dashboard has no way to discover that their
 * own agent can answer questions about what they are looking at — and telling
 * them so in a sentence does not help, because they still would not know what
 * to ask. So the questions are generated from the run on screen: copy one,
 * paste it into your agent, and the graph lights up with the answer.
 *
 * The copy is provider-NEUTRAL on purpose. rungraph installs into four agents
 * and `npx rungraph mcp --install` is correct for all of them, so no client
 * list has to reach the frontend — which is what keeps src/clients.js out of
 * this bundle. Naming Claude Code here would be a false negative for the
 * opencode user reading the same panel.
 *
 * The setup line disappears once an agent has actually driven this dashboard,
 * because at that point it is noise.
 */
function AskYourAgent({ graph, project }) {
  const questions = useMemo(() => suggestQuestions(graph, project), [graph, project]);
  const [copied, setCopied] = useState(null);
  const connected = agentHasConnected();

  const copy = (text, key) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      },
      () => setCopied('failed'),
    );
  };

  return (
    <div class="ask">
      <div class="microlabel section-label">
        ask your agent{connected && <span class="ok" title="an agent has driven this dashboard"> · connected</span>}
      </div>
      {!connected && (
        <button class="row setup" onClick={() => copy(INSTALL_CMD, 'install')} title="copy">
          <span class="grow"><code>{INSTALL_CMD}</code></span>
          <span class="n">{copied === 'install' ? '✓' : '⧉'}</span>
        </button>
      )}
      {questions.map((q) => (
        <button class="row" key={q.text} onClick={() => copy(q.text, q.text)} title="copy this question">
          <span class="grow">{q.text}</span>
          <span class="n">{copied === q.text ? '✓' : '⧉'}</span>
        </button>
      ))}
      <p class="microlabel foot">
        {connected
          ? 'paste one into your agent — the answer lands in your terminal, the graph lights up here'
          : 'run the command once, restart your agent, then paste a question into it'}
      </p>
    </div>
  );
}

const INSTALL_CMD = 'npx rungraph mcp --install';

/**
 * Has an agent ever focused this dashboard? Set by App on the first agent
 * focus. Only used to decide whether the setup line still earns its space.
 */
function agentHasConnected() {
  try {
    return localStorage.getItem('rungraph.agentSeen') === '1';
  } catch {
    return false;
  }
}

function SignalRow({ signal, focus, onFocusSignal }) {
  const on = focus?.source === 'signal' && focus.signalId === signal.id;
  return (
    <button
      class="row"
      data-severity={signal.severity}
      data-on={String(on)}
      aria-pressed={String(on)}
      onClick={() => onFocusSignal?.(signal)}
      title={signal.reason || signal.label}
    >
      <span class="glyph" aria-hidden="true">{SIGNAL_GLYPHS[signal.kind] ?? '•'}</span>
      <span class="grow">{signal.label}</span>
      <span class="n">{signal.nodeIds?.length ?? 0}</span>
    </button>
  );
}

function NodeDetail({
  graph,
  runId,
  project,
  nodeId,
  focus,
  onOpenRun,
  onFocusSignal,
  onFocusFile,
}) {
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

  const sigs = useMemo(() => signalsForNode(graph, nodeId), [graph, nodeId]);

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
        {/* Stated in words, not only as a struck label: this is the one place
            the user can find out what "struck through" meant. */}
        {node.reverted && (
          <>
            <dt>reverted</dt>
            <dd title="the user rolled this work back — it is still recorded, but it no longer stands">
              rolled back by the user
            </dd>
          </>
        )}
      </dl>

      {/* Why the canvas marked this node — and, for `info` signals, why it did
          not. Both are answered here rather than left to guesswork. */}
      {sigs.length > 0 && (
        <>
          <div class="microlabel section-label">signals</div>
          <div class="rows">
            {sigs.map((s) => (
              <SignalRow key={s.id} signal={s} focus={focus} onFocusSignal={onFocusSignal} />
            ))}
          </div>
        </>
      )}

      {node.files?.length > 0 && (
        <>
          <div class="microlabel section-label">
            {node.files.length} file{node.files.length === 1 ? '' : 's'} touched
          </div>
          <div class="rows">
            {node.files.map((f) => (
              <button class="row" key={f} onClick={() => onFocusFile?.(f)} title={f}>
                <span class="grow">{relPath(f, project)}</span>
              </button>
            ))}
          </div>
        </>
      )}

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
