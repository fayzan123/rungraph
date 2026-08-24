import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchDetail } from './api.js';
import { fmtTokens, fmtDuration } from './canvas.jsx';
import { SIGNAL_GLYPHS } from './strip.jsx';
import { adapterName, compactPath, filesIndex, rankedFocusNodes, relPath, signalsForNode } from './focus.js';
import { firstFutureCall } from './replay.js';
import { suggestQuestions } from './suggest.js';
import { coverageStats, unknownTypeSummary } from '../../src/coverage.js';

/**
 * The right pane answers "what is in this run" whenever nothing is selected and
 * "what is in this node" when something is — so it is open for the whole life of
 * a loaded graph, and `close` means "back to the run overview", not "collapse".
 *
 * With replay open it answers the same two questions AT A MOMENT. `replay` is
 * App's one playhead, projected: `{ cursor, total, t, timed, state, index,
 * clock }`, where `state` is `stateAt()` over the same cursor the canvas and
 * the strip draw from — so no two panes can describe different moments.
 * `signals` is the revealed-only list the strip shows (whole-run when replay
 * is closed); the pane never re-derives it. `replay === null` renders exactly
 * as today.
 */
export function Inspector({
  graph,
  open: paneOpen = true,
  runId,
  project,
  selection,
  focus,
  replay = null,
  settled = true,
  signals,
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
              replay={replay}
              settled={settled}
              signals={signals}
              onOpenRun={onOpenRun}
              onFocusSignal={onFocusSignal}
              onFocusFile={onFocusFile}
            />
          ) : selection?.type === 'edge' ? (
            <EdgeDetail graph={graph} edgeId={selection.id} replay={replay} />
          ) : (
            <RunOverview
              graph={graph}
              project={project}
              focus={focus}
              replay={replay}
              signals={signals}
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
 *
 * With replay open it is the story SO FAR, and one line says so. The three
 * lists narrow to the moment — revealed signals, files over present nodes,
 * focused nodes that have happened — because otherwise the strip would show
 * one chip while this pane listed four: the class of disagreement the
 * shared-implementation rules exist to prevent. The kv stats stay whole-run:
 * they are facts about the run, and "612 nodes" is not less true at event 143.
 */
function RunOverview({ graph, project, focus, replay, signals: visible, onSelectNode, onFocusSignal, onFocusFile }) {
  const signals = visible ?? graph.signals ?? [];
  const present = replay?.state?.present ?? null;
  const files = useMemo(
    () => filesIndex(present ? { ...graph, nodes: graph.nodes.filter((n) => present.has(n.id)) } : graph),
    [graph, present],
  );
  const focused = useMemo(() => {
    const all = rankedFocusNodes(graph, focus);
    return present ? all.filter((n) => present.has(n.id)) : all;
  }, [graph, focus, present]);
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
      {/* The one line that names the moment. Without it a pane listing one
          signal and three files reads as "this run is quiet" — the same
          silence-means-clean trap the coverage badge exists for, now in time. */}
      {replay && (
        <div class="moment">
          {replay.timed ? `at ${replay.clock} · ` : ''}
          {replay.cursor} of {replay.total} events
        </div>
      )}
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
            <dt>read</dt>
            <dd
              data-partial={String(cov.unrecognized > 0 || cov.sourcesUnread > 0)}
              title="records this adapter could interpret, out of the records it examined"
            >
              {cov.records - cov.unrecognized} of {cov.records} records
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
            {focused.length === 0 && (
              <div class="loading">{present && focus.nodeIds.length > 0 ? 'nothing matched yet' : 'nothing matched'}</div>
            )}
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
                <span class="grow">{compactPath(relPath(f.path, project))}</span>
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
 * A call's input, as the fields it was made of. Adapters hand the inspector
 * `input` as pretty-printed JSON, which for a shell command means a `command`
 * string full of `\"` escapes and `\n` pairs — the least readable form of
 * the one thing the user came to read. When the text parses as a flat object
 * (string / number / boolean values, a handful of keys) it renders as
 * key → value with strings shown raw; anything else falls back to the text.
 */
function CallInput({ text }) {
  const pairs = flatPairs(text);
  if (!pairs) return <pre>{text}</pre>;
  return (
    <div class="call-input">
      {pairs.map(([k, v]) => (
        <div class="pair" key={k}>
          <span class="microlabel k">{k}</span>
          <pre>{v}</pre>
        </div>
      ))}
    </div>
  );
}

function flatPairs(text) {
  if (typeof text !== 'string' || text.length > 20_000 || text[0] !== '{') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null; // capped or truncated by the adapter — show as is
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entries = Object.entries(obj);
  if (entries.length === 0 || entries.length > 12) return null;
  const out = [];
  for (const [k, v] of entries) {
    if (typeof v === 'string') out.push([k, v]);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out.push([k, String(v)]);
    else return null; // nested — the JSON is the honest view of that
  }
  return out;
}

/**
 * In a collapsed group of many calls, the failed ones are what the user
 * opened the node to find, and they can sit forty blobs down. One chip per
 * failure, jumping to it.
 */
function FailedCallJumps({ calls }) {
  const failed = calls.map((c, i) => (c.isError ? i + 1 : null)).filter(Boolean);
  if (failed.length === 0 || calls.length < 4) return null;
  return (
    <div class="call-jumps">
      <span class="microlabel">{failed.length === 1 ? 'failed:' : `${failed.length} failed:`}</span>
      {failed.slice(0, 12).map((n) => (
        <button
          class="ghost err"
          key={n}
          onClick={() => document.getElementById(`call-${n}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
        >
          ✕ #{n}
        </button>
      ))}
      {failed.length > 12 && <span class="microlabel">+{failed.length - 12} more</span>}
    </div>
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
 * The copy is provider-NEUTRAL on purpose. rungraph installs into five agents
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

/**
 * How long the transcript fetch waits when the playhead comes to rest ON THE
 * NODE IT LAST RESTED ON with something to refetch (a live delta re-stamped
 * it mid-play, an earlier fetch failed). A rest on a NEW node fetches at once
 * — see the effect below. Long enough that a rest that is about to move
 * again does not issue a request; short enough that it reads as immediate.
 */
const SETTLE_FETCH_MS = 250;

/**
 * One node. With replay open, SELECTION FOLLOWS EVERY TICK AND THE FETCH WAITS
 * FOR THE PLAYHEAD TO REST: the header, status, files and signals come from
 * the IR and cost nothing, so they follow the playhead; `/api/detail` used to
 * fire on every `nodeId` change, immediately, which at 25 ticks a second is
 * 25 requests a second and a "loading transcript…" flash on each. So the
 * fetch is gated on `settled` (false while playing or mid-drag), and a rest
 * on a node the playhead was not resting on before fetches AT ONCE, whether
 * `settled` flipped in the same render or not: a step out of play and a
 * drag's release both pause and land in one handler, and spec §5 names them
 * discrete acts that fetch as today — a debounce keyed on the flip alone
 * made them wait 250 ms. While unsettled the last settled node's transcript
 * stays on screen, dimmed (`data-stale`), rather than being cleared: a pane
 * that blanks on every tick is a pane the eye stops reading.
 *
 * A GHOST — a node the playhead has not reached — shows a stub instead. The
 * canvas draws it as an outline with no content; the pane must not be the
 * leak: its label, status, files and transcript are the future's content
 * (spec §5), and a request for a transcript the moment has not reached is
 * not made. The stub names the kind (the ghost's shape already does) and the
 * event it starts at, which the bar's markers already give away.
 */
function NodeDetail({
  graph,
  runId,
  project,
  nodeId,
  focus,
  replay,
  settled,
  signals: visible,
  onOpenRun,
  onFocusSignal,
  onFocusFile,
}) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  // The detail remembers WHICH node (and which run — ids repeat across runs)
  // it belongs to, so a transcript can outlive its node's selection as the
  // stale body, and the fresh/stale decision is a comparison, not a flag
  // that has to be kept in step with it.
  const [detail, setDetail] = useState(null); // { key, stamp, data }
  const [failedFor, setFailedFor] = useState(null);
  const key = `${runId}\n${nodeId}`;

  // nodeStamp changes whenever a live-tail delta updates this node, so the
  // detail re-fetches instead of going stale mid-run.
  const nodeStamp = node ? JSON.stringify(node) : '';
  // Present at the playhead? `stateAt` writes status and counts for present
  // nodes only, so a ghost has no entry — and its final status must not fall
  // through to the pane. Replay closed: everything is present.
  const ghost = Boolean(replay?.state) && !replay.state.present.has(nodeId);
  // Read through refs inside the effect so neither is a dependency: `detail`
  // changing must not re-run the fetch that produced it, and "did settled
  // just flip" and "is this the node it last rested on" are questions about
  // the previous rest, not the current render.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const wasSettled = useRef(settled);
  const restedOn = useRef(null); // the key of the last render with the playhead at rest
  useEffect(() => {
    const flipped = settled && !wasSettled.current;
    wasSettled.current = settled;
    if (!settled) return; // the playhead is moving: keep what is on screen
    const sameRest = restedOn.current === key;
    restedOn.current = key;
    setFailedFor((f) => (f === key ? null : f));
    if (!node?.hasDetail || ghost) return;
    const have = detailRef.current;
    // Pause on the node that is already loaded (or a drag that released where
    // it started) — nothing to fetch; the stale dim simply lifts.
    if (have && have.key === key && have.stamp === nodeStamp) return;
    let alive = true;
    const go = () =>
      fetchDetail(runId, nodeId)
        .then((d) => alive && setDetail({ key, stamp: nodeStamp, data: d }))
        .catch(() => alive && setFailedFor(key));
    // A rest back on the node it last rested on waits (see SETTLE_FETCH_MS);
    // a rest on a new node — a step, a marker click, a drag's release, a
    // click on the canvas, the end of a play — goes now.
    let timer = null;
    if (flipped && sameRest) timer = setTimeout(go, SETTLE_FETCH_MS);
    else go();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runId, nodeId, nodeStamp, settled, ghost]);
  // Replay closed: a node change drops the old transcript at once, exactly as
  // today — the stale body is a replay affordance, not a general one.
  useEffect(() => {
    if (!replay) setDetail(null);
  }, [runId, nodeId]);

  // The VISIBLE signals (the strip's list), not `graph.signals`: a node's
  // signal rows appear at their reveal, so the pane and the strip agree.
  const sigs = useMemo(() => signalsForNode({ signals: visible ?? graph.signals }, nodeId), [visible, graph, nodeId]);

  if (!node) return null;

  if (ghost) {
    const startsAt = replay.index?.byNode.get(nodeId)?.startIdx;
    return (
      <>
        <div class="microlabel">{node.kind}</div>
        <div class="loading">
          not yet — at this moment this node has not happened
          {typeof startsAt === 'number' ? ` · it starts at event ${startsAt + 1} of ${replay.total}` : ''}
        </div>
      </>
    );
  }

  // The moment's view of the node: its status at the playhead (running while
  // its end is ahead) and how many of its calls have happened. Both fall back
  // to the IR's own values, which is what `stateAt` at the edge yields anyway.
  const status = replay?.state?.status.get(nodeId) ?? node.status;
  const callsShown = replay?.state?.callsShown.get(nodeId);
  const midGroup = replay != null && typeof callsShown === 'number' && callsShown < node.callCount;

  const fresh = detail && detail.key === key ? detail.data : null;
  const failed = failedFor === key;
  // The stale body is the last settled node's transcript, shown dimmed while
  // the playhead moves. Only while replay is open — closed, a node change
  // clears the detail above and there is nothing stale to show. And only
  // while there is something to wait for: settled on a node that HAS no
  // transcript, or whose fetch has FAILED, nothing will ever replace the
  // stale one, so another node's text dimmed under this node's header would
  // sit there as a lie — beside "transcript unavailable", in the failed case.
  const body = fresh ?? (replay && !failed && (!settled || node.hasDetail) ? detail?.data ?? null : null);
  const stale = Boolean(body) && (!settled || !fresh);
  const loading = node.hasDetail && !body && !failed && settled;

  // Tool detail rows beyond the playhead render as ghosts. `callIdxs[i-1]` is
  // call i's event index (call 0 IS the start, so it is never future while
  // the node is present); with no call events — a single call, an untimed
  // adapter, an old bundle — the list shows whole, as today. Never applied
  // to the stale body: those rows belong to another node.
  const callIdxs = fresh && replay ? replay.index?.byNode.get(nodeId)?.callIdxs : null;
  const futureFrom = callIdxs ? firstFutureCall(callIdxs, replay.cursor) : Infinity;

  return (
    <>
      <div class="microlabel">{node.kind}</div>
      <h2>{node.label}</h2>
      <dl class="kv">
        <dt>status</dt>
        <dd data-status={status}>{status}</dd>
        {node.model && (<><dt>model</dt><dd>{node.model}</dd></>)}
        {node.tokens && (
          <>
            <dt>tokens</dt>
            <dd>{fmtTokens(node.tokens.input)} in · {fmtTokens(node.tokens.output)} out</dd>
          </>
        )}
        {node.durationMs != null && (<><dt>duration</dt><dd>{fmtDuration(node.durationMs)}</dd></>)}
        {node.callCount > 1 && (
          <>
            <dt>calls</dt>
            <dd>{midGroup ? `${callsShown} of ${node.callCount}` : node.callCount}</dd>
          </>
        )}
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
                <span class="grow">{compactPath(relPath(f, project))}</span>
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

      {loading && <div class="loading">loading transcript…</div>}
      {failed && <div class="loading">transcript unavailable</div>}
      {body && (
        <div class="detail-body" data-stale={String(stale)}>
          <DetailBody detail={body} futureFrom={futureFrom} />
        </div>
      )}
    </>
  );
}

/** `futureFrom`: the first call row (0-based) that has not happened yet at the playhead; Infinity when all have. */
function DetailBody({ detail, futureFrom = Infinity }) {
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
          <FailedCallJumps calls={detail.calls} />
          {detail.calls.map((c, i) => (
            <div class="tool-call" key={i} id={`call-${i + 1}`} data-future={String(i >= futureFrom)}>
              <div class="head">
                <span class={c.isError ? 'err' : 'ok'}>{c.isError ? '✕' : '✓'}</span>
                <span>#{i + 1}</span>
                {c.durationMs != null && <span>{fmtDuration(c.durationMs)}</span>}
              </div>
              <CallInput text={c.input} />
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

/**
 * One edge. At a moment, an edge the playhead has not reached is a ghost like
 * a future node — the canvas keeps its line and drops its flag, label and
 * tooltip — and the pane matches: the ends it names read as `…` while they
 * are ghosts themselves, and its reason and label (a spawn's prompt, a
 * return's result) wait for it to happen. Presence is `stateAt`'s kind-aware
 * rule read back (a `return` waits for its child's END), never re-derived.
 */
function EdgeDetail({ graph, edgeId, replay = null }) {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const from = graph.nodes.find((n) => n.id === edge.from);
  const to = graph.nodes.find((n) => n.id === edge.to);
  const present = replay?.state?.present ?? null;
  const future = Boolean(replay?.state) && typeof edge.id === 'string' && !replay.state.edgePresent.has(edge.id);
  const name = (id, n) => (present && !present.has(id) ? '…' : (n?.label ?? id));
  return (
    <>
      <div class="microlabel">{edge.kind} edge</div>
      <h2>
        {name(edge.from, from)} → {name(edge.to, to)}
      </h2>
      {future ? (
        <div class="loading">not yet — at this moment this edge has not happened</div>
      ) : (
        <>
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
