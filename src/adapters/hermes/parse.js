import { emptyGraph, snippet } from '../../ir.js';
import { mergeFiles } from '../claude-code/files.js';
import { openDb, tableColumns, selectList, schemaVersion, iso } from './db.js';
import { ADAPTER_NAME } from './detect.js';
import { tallyUnknownType } from '../../coverage.js';

/**
 * Hermes parser: rows in, IR out. No server imports; no I/O beyond the run's
 * own database (plus, only in the crash-recovery case, a scratch copy of it
 * in rungraph's own temp dir — see db.js).
 *
 * Grounded in the live probe of ~/.hermes/state.db (2026-08-18, v0.20.1,
 * schema v26):
 * - Tool calls are OpenAI-style entries in the assistant row's `tool_calls`
 *   JSON — one row can carry a parallel batch (up to ×6 observed). Results
 *   are `role='tool'` rows pairing STRICTLY by `tool_call_id`, never by
 *   adjacency.
 * - Terminal results are `{output, exit_code, error}` — authoritative error
 *   detection; other tools use `success: true/false`. A result can carry an
 *   advisory suffix after the JSON (`[Tool loop warning: …]`), which the
 *   salvage in parseResult() tolerates.
 * - Approval denials are written into the tool RESULT by tools/approval.py;
 *   the reason constants ("denied by user", "User denied this …", "timed out
 *   without user response") are Hermes's own strings, which is why matching
 *   them is the one sanctioned string match in this grammar.
 * - `async_delegations` is ephemeral (emptied after delivery). The durable
 *   delegation record is `sessions.parent_session_id` (the exact tree), the
 *   `delegate_task` result (`delegation_id`, `goals[]`), and the
 *   `[ASYNC DELEGATION BATCH COMPLETE — deleg_<id>]` user-role delivery.
 * - Rewinds deactivate rows instead of deleting them: `active = 1` is the
 *   canonical history the agent itself sees; inactive rows are counted into
 *   `ext.hermes.inactiveMessageCount`, never drawn.
 * - Timestamps are REAL epoch seconds. `messages.id` is an AUTOINCREMENT
 *   primary key — DB-wide, never reused, never reordered — which is what
 *   makes `m<id>` / `t<id>` node ids stable across live-tail re-parses and
 *   unique across every lane of a run.
 */

/** Observed 1 level of delegation; the cap is a cycle backstop (codex precedent). */
export const HERMES_MAX_DEPTH = 5;

/**
 * Hermes's own approval-outcome constants (tools/approval.py: the
 * `reason` strings at 3517/3520 plus the "User denied this …" message
 * templates). A result whose error/message field carries one is a human
 * saying no — an intervention, not a tool failure.
 */
const DENIAL_MARKERS = ['denied by user', 'User denied this', 'timed out without user response'];

const DELIVERY_PREFIX_RE = /^\[ASYNC DELEGATION BATCH COMPLETE — (deleg_[A-Za-z0-9]+)\]/;

const SESSION_PARSE_COLS = [
  'id',
  'source',
  'title',
  'model',
  'git_branch',
  'git_repo_root',
  'started_at',
  'ended_at',
  'end_reason',
  'message_count',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'estimated_cost_usd',
  'archived',
  'profile_name',
  'rewind_count',
];

const MSG_COLS = [
  'id',
  'role',
  'content',
  'tool_call_id',
  'tool_calls',
  'tool_name',
  'timestamp',
  'token_count',
  'finish_reason',
  'display_kind',
];

const cap = (text, max) => {
  if (typeof text !== 'string') return text == null ? '' : JSON.stringify(text).slice(0, max);
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
};

const num = (v) => (Number.isFinite(v) ? v : 0);

export async function parse(ref, opts = {}) {
  const collect = opts.collectDetails ?? false;
  const { db, close } = await openDb(ref.dbPath);
  try {
    const q = makeQueries(db);
    const session = q.session(ref.sessionId);
    if (!session) throw new Error(`session ${ref.sessionId} not found in ${ref.dbPath}`);

    const g = emptyGraph({
      runId: ref.runId,
      adapter: ADAPTER_NAME,
      kind: 'session',
      title: ref.title,
    });
    const details = new Map();
    // Liveness is the session's own marker: `ended_at` is authoritative when
    // set; null means the writer never closed the session — live tail, or the
    // crashed shape this adapter's recovery path exists for.
    const live = session.ended_at == null;

    const ctx = {
      g,
      details,
      collect,
      q,
      seen: new Set([ref.sessionId]),
      // `records` is this adapter's coverage unit: rows WALKED. Adapter-defined
      // and never compared across adapters — a row is not a JSONL line.
      stats: { inactive: 0, modelSwitches: 0, unrecognized: 0, agents: 0, records: 0, unknownTypes: {} },
    };

    const walker = new SessionWalker(ctx, { groupId: undefined, startTip: null, live });
    walker.walk(q.messages(ref.sessionId));
    ctx.stats.inactive += q.inactiveCount(ref.sessionId);
    materializeChildren(ctx, walker, ref.sessionId, live, 1);

    const startedAt = iso(session.started_at);
    if (startedAt) g.meta.startedAt = startedAt;
    const endedAt = iso(session.ended_at);
    if (endedAt) g.meta.endedAt = endedAt;
    g.meta.unrecognizedLineCount = ctx.stats.unrecognized;
    g.meta.coverage = {
      records: ctx.stats.records,
      // One row can raise several complaints (a tool_calls array of six bad
      // entries), so this can exceed `records`; consumers clamp.
      unrecognized: ctx.stats.unrecognized,
      // A Hermes run is one database — there is no second file to fail to open.
      sourcesUnread: 0,
    };
    g.meta.totals = {
      tokens: num(session.input_tokens) + num(session.output_tokens),
      toolCalls: num(session.tool_call_count),
      agents: ctx.stats.agents,
    };
    g.meta.ext = {
      // Nothing Hermes-named leaves this bag — the vendor-neutral IR rule.
      hermes: {
        ...(typeof session.model === 'string' && session.model ? { model: session.model } : {}),
        ...(Number.isFinite(session.estimated_cost_usd)
          ? { estimatedCostUsd: session.estimated_cost_usd }
          : {}),
        ...(typeof session.source === 'string' && session.source ? { source: session.source } : {}),
        ...(typeof session.git_branch === 'string' && session.git_branch
          ? { gitBranch: session.git_branch }
          : {}),
        ...(typeof session.git_repo_root === 'string' && session.git_repo_root
          ? { gitRepoRoot: session.git_repo_root }
          : {}),
        profile:
          typeof session.profile_name === 'string' && session.profile_name
            ? session.profile_name
            : ref.profile ?? 'default',
        archived: session.archived === 1,
        rewindCount: num(session.rewind_count),
        inactiveMessageCount: ctx.stats.inactive,
        ...(ctx.stats.modelSwitches > 0 ? { modelSwitchCount: ctx.stats.modelSwitches } : {}),
        ...(schemaVersion(db) != null ? { schemaVersion: schemaVersion(db) } : {}),
        // Row shapes this grammar could not place. Vendor vocabulary, hence
        // the namespaced bag.
        ...(Object.keys(ctx.stats.unknownTypes).length > 0
          ? { unknownTypes: ctx.stats.unknownTypes }
          : {}),
      },
    };
    return { ir: g, details };
  } finally {
    await close();
  }
}

/**
 * Prepared statements over whatever columns THIS database actually has —
 * missing ones select as NULL under the same name (schema tolerance: older
 * and newer Hermes degrade field-by-field, never blank-screen).
 */
function makeQueries(db) {
  const sHave = tableColumns(db, 'sessions');
  const mHave = tableColumns(db, 'messages');
  if (!sHave.has('id')) throw new Error('no sessions table — not a Hermes state.db');
  const activeFilter = mHave.has('active') ? ' AND active = 1' : '';

  const sessionStmt = db.prepare(
    `SELECT ${selectList(sHave, SESSION_PARSE_COLS)} FROM sessions WHERE id = ?`,
  );
  // `ORDER BY id` (insertion order), not timestamp — autoincrement cannot tie.
  const messagesStmt = db.prepare(
    `SELECT ${selectList(mHave, MSG_COLS)} FROM messages WHERE session_id = ?${activeFilter} ORDER BY id`,
  );
  const childrenStmt = sHave.has('parent_session_id')
    ? db.prepare(
        `SELECT ${selectList(sHave, SESSION_PARSE_COLS)} FROM sessions WHERE parent_session_id = ? ORDER BY started_at, id`,
      )
    : null;
  const inactiveStmt = mHave.has('active')
    ? db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND active = 0')
    : null;

  return {
    session: (id) => sessionStmt.get(id) ?? null,
    messages: (id) => messagesStmt.all(id),
    children: (id) => (childrenStmt ? childrenStmt.all(id) : []),
    inactiveCount: (id) => (inactiveStmt ? num(inactiveStmt.get(id)?.c) : 0),
  };
}

/**
 * Walks one session's active rows into turn/tool/human nodes on a sequence
 * chain. The parent backbone and every delegation lane use the same walker —
 * a lane is just a walk with a `groupId` and the agent node as its chain
 * root.
 */
class SessionWalker {
  constructor(ctx, { groupId, startTip, live }) {
    this.ctx = ctx;
    this.g = ctx.g;
    this.details = ctx.details;
    this.collect = ctx.collect;
    this.groupId = groupId;
    this.live = live;
    this.chainTip = startTip;
    this.pendingReason = null;
    this.turn = null; // { id, node, prompt, responseText, tokenSum, startTs, endTs }
    this.turns = []; // [{ id, tsSec }] — for return-edge / spawn fallbacks
    this.pending = new Map(); // call_id → { kind, name, nodeId, args, rowId, tsSec, fromNodeId, turnId }
    this.toolNames = new Map(); // tool node id → plain tool name
    this.toolFiles = new Map(); // tool node id → union of touched paths
    // tool node id → [{ startSec, endSec? }] in CALL order — the same order the
    // detail payload's calls[] takes, so callOffsets[i] and calls[i].startedAt
    // describe the same call. Walker state, not detail state: `rungraph graph
    // --json` collects no details and must still carry the timings.
    this.toolTimes = new Map();
    this.narration = null; // assistant text since the last tool call
    this.lastHumanNodeId = null;
    this.lastCallRowId = null; // finality gate for unpaired running calls
    this.spawnSlots = []; // [{ goal, delegId, fromNodeId, turnId, tsSec }] in dispatch order
    this.deliveries = []; // [{ delegId, turnId, text }]
    this.created = []; // nodes THIS walker made (the finish pass must not touch other lanes')
  }

  node(n) {
    if (this.groupId) n.group = this.groupId;
    this.g.nodes.push(n);
    this.created.push(n);
    return n;
  }

  edge(kind, from, to, extra = {}) {
    if (!from || !to || from === to) return;
    const e = { id: `e:${kind}:${from}→${to}`, kind, from, to, ...extra };
    if (!this.g.edges.some((x) => x.id === e.id)) this.g.edges.push(e);
    return e;
  }

  chain(nodeId) {
    // Decision lineage rides only the BACKBONE edge to the next node — side
    // edges (a denied group pointing at its denial node) must not consume it.
    const e = this.edge('sequence', this.chainTip, nodeId);
    if (e && this.pendingReason && !e.reason) {
      e.reason = this.pendingReason;
      this.pendingReason = null;
    }
    this.chainTip = nodeId;
  }

  walk(rows) {
    for (const row of rows) this.row(row);
    this.finish();
  }

  row(row) {
    // THE choke point: every walked row passes through here exactly once, in
    // the parent backbone and in every delegation lane, so coverage's
    // `records` needs one increment and no per-branch bookkeeping.
    this.ctx.stats.records++;
    const kind = typeof row.display_kind === 'string' ? row.display_kind : '';
    if (kind === 'hidden') return;
    if (kind === 'model_switch') return this.modelSwitch(row);
    if (kind === 'async_delegation_complete') return this.delivery(row);
    if (kind === 'auto_continue') return; // agent-initiated continuation — folded, not a turn
    if (kind) {
      // A display_kind this grammar doesn't know — future Hermes. Skip + count.
      this.unknown(kind);
      return;
    }
    switch (row.role) {
      case 'user':
        return this.userRow(row);
      case 'assistant':
        return this.assistantRow(row);
      case 'tool':
        return this.toolRow(row);
      default:
        this.unknown(typeof row.role === 'string' ? `role:${row.role}` : undefined);
    }
  }

  /** Count one unreadable row shape, and remember what shape it was. */
  unknown(type) {
    this.ctx.stats.unrecognized++;
    tallyUnknownType(this.ctx.stats.unknownTypes, type);
  }

  // ---- user rows ----------------------------------------------------------

  userRow(row) {
    const text = typeof row.content === 'string' ? row.content : '';
    // Pre-display_kind history: the delivery marker is a content prefix.
    if (DELIVERY_PREFIX_RE.test(text)) return this.delivery(row);
    this.startTurn(row, text);
  }

  startTurn(row, text) {
    this.closeTurn();
    this.narration = null;
    const id = `m${row.id}`;
    const node = this.node({
      id,
      kind: 'turn',
      label: snippet(text) || '(empty prompt)',
      status: 'completed',
      startedAt: iso(row.timestamp),
      hasDetail: true,
    });
    this.chain(id);
    this.turn = {
      id,
      node,
      prompt: text,
      responseText: '',
      tokenSum: 0,
      startTs: row.timestamp,
      endTs: row.timestamp,
    };
    this.turns.push({ id, tsSec: row.timestamp });
  }

  closeTurn() {
    if (!this.turn) return;
    this.narration = null;
    const t = this.turn;
    if (t.tokenSum > 0) t.node.tokens = { input: 0, output: t.tokenSum };
    const ms = msBetweenSec(t.startTs, t.endTs);
    if (ms != null) t.node.durationMs = ms;
    const ended = iso(t.endTs);
    if (ended) t.node.endedAt = ended;
    if (this.collect) {
      this.details.set(t.id, {
        kind: 'turn',
        prompt: cap(t.prompt, 8000),
        responseText: cap(t.responseText, 8000),
      });
    }
    this.turn = null;
  }

  delivery(row) {
    const text = typeof row.content === 'string' ? row.content : '';
    const delegId = text.match(DELIVERY_PREFIX_RE)?.[1] ?? null;
    // Not a turn: the delivery decorates the matching return edge and
    // agent-node detail instead (materializeChildren reads this list).
    this.deliveries.push({ delegId, turnId: this.turn?.id ?? null, text });
  }

  modelSwitch(row) {
    this.ctx.stats.modelSwitches++;
    // No dedicated node — noted in the adjacent node's detail.
    if (this.turn && typeof row.content === 'string' && row.content.trim()) {
      this.turn.responseText +=
        (this.turn.responseText ? '\n\n' : '') + `[model switch] ${snippet(row.content, 200)}`;
    }
  }

  // ---- assistant rows -----------------------------------------------------

  assistantRow(row) {
    if (this.turn) {
      this.turn.endTs = row.timestamp ?? this.turn.endTs;
      this.turn.tokenSum += num(row.token_count);
    }
    const text = typeof row.content === 'string' ? row.content.trim() : '';
    if (text) {
      if (this.turn) {
        this.turn.responseText += (this.turn.responseText ? '\n\n' : '') + row.content;
      }
      this.narration = row.content;
    }

    if (row.tool_calls == null) return;
    const calls = safeJson(row.tool_calls);
    if (!Array.isArray(calls)) {
      this.unknown('tool_calls');
      return;
    }
    for (const call of calls) {
      const name = call?.function?.name;
      const callId = typeof call?.call_id === 'string' ? call.call_id : call?.id;
      if (typeof name !== 'string' || typeof callId !== 'string' || !callId) {
        this.unknown('tool_call');
        continue;
      }
      const args = safeJson(call.function.arguments) ?? {};
      this.toolCall(row, callId, name, args, calls.indexOf(call));
    }
    // Narration was "immediately before" only this row's calls.
    this.narration = null;
    this.lastCallRowId = row.id;
  }

  toolCall(row, callId, name, args, callIdx) {
    if (name === 'clarify') {
      // A complete human intervention (context + answer) lives in the result
      // row — never a tool node.
      this.pending.set(callId, { kind: 'clarify', name, args, rowId: row.id, tsSec: row.timestamp });
      return;
    }
    if (name === 'delegate_task') {
      // The agent nodes and their spawn/return edges tell this story; the
      // goals arrive with the result row.
      this.pending.set(callId, {
        kind: 'delegate',
        name,
        args,
        rowId: row.id,
        tsSec: row.timestamp,
        fromNodeId: this.chainTip,
        turnId: this.turn?.id ?? null,
      });
      return;
    }

    // Consecutive same-name calls collapse into one node (anti-hairball) —
    // matched on the recorded plain name, since labels are descriptive.
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    let nodeId;
    if (tip && tip.kind === 'tool' && this.toolNames.get(tip.id) === name) {
      tip.callCount += 1;
      nodeId = tip.id;
    } else {
      // Keyed by the first call row (so a group growing during live tail
      // keeps its id) plus the call's index for same-row mixed-name batches.
      nodeId = callIdx > 0 ? `t${row.id}.${callIdx}` : `t${row.id}`;
      this.node({
        id: nodeId,
        kind: 'tool',
        label: toolLabel(name, args),
        status: 'running',
        callCount: 1,
        errorCount: 0,
        startedAt: iso(row.timestamp),
        hasDetail: true,
      });
      this.toolNames.set(nodeId, name);
      if (this.collect) {
        this.details.set(nodeId, {
          kind: 'tool',
          name,
          ...(this.narration ? { context: cap(this.narration, 2000) } : {}),
          calls: [],
        });
      }
      this.chain(nodeId);
    }
    const paths = filePathsFromArgs(name, args);
    if (paths.length) this.attachFiles(nodeId, paths);
    // The call's start is its ROW's timestamp — Hermes writes one row per
    // assistant message, so every call of a parallel batch shares an instant
    // and a batch's offsets come out `[0, 0, 0]`. That is the truth (they
    // were issued together), never smoothed.
    if (!this.toolTimes.has(nodeId)) this.toolTimes.set(nodeId, []);
    this.toolTimes.get(nodeId).push({ startSec: row.timestamp });
    if (this.collect) {
      this.details.get(nodeId)?.calls.push({
        toolUseId: callId,
        input: cap(JSON.stringify(args, null, 2), 3000),
        output: null,
        isError: false,
        startedAt: iso(row.timestamp),
      });
    }
    this.pending.set(callId, {
      kind: 'tool',
      name,
      nodeId,
      args,
      rowId: row.id,
      tsSec: row.timestamp,
      // Index into toolTimes[nodeId]: results pair by tool_call_id, never by
      // position, so the call's timing slot rides the pending record.
      slot: this.toolTimes.get(nodeId).length - 1,
    });
  }

  /**
   * A call resolved — result, error, or a human's denial — at `endSec`. The
   * group's `endedAt` is derived from these in finish(), and only once every
   * call in the group has one.
   */
  callResolved(rec, endSec) {
    const slot = this.toolTimes.get(rec.nodeId)?.[rec.slot];
    if (slot) slot.endSec = endSec;
  }

  attachFiles(nodeId, paths) {
    if (!nodeId || !paths?.length) return;
    this.toolFiles.set(nodeId, mergeFiles(this.toolFiles.get(nodeId), paths));
  }

  /** De-duplicated union of every path this lane's tool nodes touched. */
  laneFiles() {
    let out = [];
    for (const files of this.toolFiles.values()) out = mergeFiles(out, files);
    return out;
  }

  // ---- tool result rows ---------------------------------------------------

  toolRow(row) {
    const rec = this.pending.get(row.tool_call_id);
    if (!rec) {
      // A result with no matching active call — a shape this grammar can't
      // place (rewind halves, format drift). Skip + count.
      this.unknown('orphan_tool_result');
      return;
    }
    this.pending.delete(row.tool_call_id);
    const { json, malformed } = parseResult(row.content);
    if (malformed) this.unknown('tool_result');

    if (rec.kind === 'clarify') return this.clarifyAnswered(rec, row, json);
    if (rec.kind === 'delegate') return this.delegated(rec, json);

    const denial = denialReason(json);
    if (denial) return this.humanDenial(rec, row, denial);

    // Structured fields only (precision over recall): exit codes and error
    // strings for terminal-shaped results, success flags for the rest. An
    // unparseable or plain-text result is never an error.
    const isError = resultIsError(json);
    const group = this.g.nodes.find((n) => n.id === rec.nodeId);
    if (group) {
      if (isError) group.errorCount = (group.errorCount ?? 0) + 1;
      if (group.status !== 'error') group.status = 'completed';
    }
    this.callResolved(rec, row.timestamp);
    if (this.collect) {
      const call = this.details.get(rec.nodeId)?.calls.find((c) => c.toolUseId === row.tool_call_id);
      if (call) {
        call.isError = isError;
        call.output = cap(resultText(row.content, json), 4000);
        const ms = msBetweenSec(rec.tsSec, row.timestamp);
        if (ms != null) call.durationMs = ms;
      }
    }
    if (rec.name === 'search_files') {
      // File attribution only when the result proves the path named a file —
      // a search ROOT directory is not a file that was touched.
      const p = typeof rec.args?.path === 'string' ? rec.args.path : '';
      if (p && Array.isArray(json?.files) && json.files.includes(p)) this.attachFiles(rec.nodeId, [p]);
    }
    if (isError) this.pendingReason = `after ${rec.name} error`;
  }

  clarifyAnswered(rec, row, json) {
    const question = typeof json?.question === 'string' ? json.question : str(rec.args?.question);
    const answer =
      typeof json?.user_response === 'string'
        ? json.user_response
        : typeof row.content === 'string'
          ? row.content
          : '';
    // Keyed by the CALL row, exactly like the pending-question node finish()
    // makes: during live tail the question node must keep its id when the
    // answer lands, so the delta is an update, never a remove+add.
    const id = `m${rec.rowId}.q`;
    this.node({
      id,
      kind: 'human',
      label: snippet(`answered: ${answer}`, 70),
      status: 'completed',
      interventionKind: 'answer',
      startedAt: iso(row.timestamp),
      hasDetail: true,
    });
    this.details.set(id, {
      kind: 'human',
      interventionKind: 'answer',
      context: cap(clarifyContext(question, json ?? rec.args), 4000),
      answer: cap(answer, 4000),
    });
    this.chain(id);
    this.lastHumanNodeId = id;
    this.pendingReason = `answer: ${snippet(answer, 50)}`;
  }

  humanDenial(rec, row, reason) {
    // The denied call still counts against its group — and the human node
    // right after it is what tells signals.js this "error" was a person
    // saying no, not a retry to flag.
    const group = this.g.nodes.find((n) => n.id === rec.nodeId);
    if (group) {
      group.errorCount = (group.errorCount ?? 0) + 1;
      if (group.status !== 'error') group.status = 'completed';
    }
    // A "no" resolves the call as surely as a result does — the denial row
    // is the moment the group stopped waiting.
    this.callResolved(rec, row.timestamp);
    if (this.collect) {
      const call = this.details.get(rec.nodeId)?.calls.find((c) => c.toolUseId === row.tool_call_id);
      if (call) {
        call.isError = true;
        call.output = cap(reason, 4000);
      }
    }
    // Consecutive denials (a refused parallel batch) collapse into one node.
    if (this.lastHumanNodeId && this.chainTip === this.lastHumanNodeId) {
      const prev = this.g.nodes.find((n) => n.id === this.lastHumanNodeId);
      if (prev?.interventionKind === 'denial') {
        prev.label = snippet(`${prev.label}, ${rec.name}`, 60);
        // A denied call from an EARLIER group of a mixed-name batch still
        // needs its tool→denial edge — that adjacency is how signals.js
        // knows the group's "errors" were a person saying no.
        this.edge('sequence', rec.nodeId, prev.id);
        return;
      }
    }
    const id = `m${row.id}`;
    this.node({
      id,
      kind: 'human',
      label: `denied ${rec.name}`,
      status: 'completed',
      interventionKind: 'denial',
      startedAt: iso(row.timestamp),
      hasDetail: true,
    });
    this.details.set(id, {
      kind: 'human',
      interventionKind: 'denial',
      context: cap(JSON.stringify(rec.args, null, 2), 3000),
      // The full reason string says which kind this was — an explicit "no"
      // or an approval that timed out without a response.
      answer: cap(reason, 4000),
    });
    this.chain(id);
    // Mixed-name batch: the denied call may sit in an earlier group than the
    // chain tip the human node just chained from (see the merge branch above).
    this.edge('sequence', rec.nodeId, id);
    this.lastHumanNodeId = id;
    this.pendingReason = 'after permission denial';
  }

  delegated(rec, json) {
    // A dispatch that FAILED (or was denied) spawned nothing — a slot for it
    // would shift the dispatch-order pairing for every real child after it.
    if (denialReason(json) || resultIsError(json)) return;
    const delegId = typeof json?.delegation_id === 'string' ? json.delegation_id : null;
    const goals = Array.isArray(json?.goals)
      ? json.goals.filter((x) => typeof x === 'string')
      : typeof rec.args?.goal === 'string'
        ? [rec.args.goal]
        : [];
    (goals.length ? goals : ['']).forEach((goal, batchIndex) => {
      this.spawnSlots.push({
        goal,
        delegId,
        batchIndex,
        fromNodeId: rec.fromNodeId,
        turnId: rec.turnId,
        tsSec: rec.tsSec,
      });
    });
  }

  // ---- finish -------------------------------------------------------------

  /** Which turn was active at a given epoch-seconds instant. */
  turnAt(tsSec) {
    let cur = null;
    for (const t of this.turns) {
      if (Number.isFinite(t.tsSec) && Number.isFinite(tsSec) && t.tsSec <= tsSec) cur = t.id;
      else if (cur) break;
    }
    return cur;
  }

  finish() {
    // Unpaired calls. Truncated mid-write rows cannot occur (SQLite reads are
    // transactional), so an unpaired call is either the live tail's not-yet-
    // written result — final call, session still open — or an error.
    const stillRunning = new Set();
    for (const [callId, rec] of this.pending) {
      const final = rec.rowId === this.lastCallRowId;
      if (rec.kind === 'delegate') continue; // children pair independently
      if (rec.kind === 'clarify') {
        const id = `m${rec.rowId}.q`;
        const question = str(rec.args?.question);
        this.node({
          id,
          kind: 'human',
          label: snippet(`asked: ${question}`, 70) || 'asked a question',
          status: this.live && final ? 'running' : 'error',
          interventionKind: 'answer',
          startedAt: iso(rec.tsSec),
          hasDetail: true,
        });
        this.details.set(id, {
          kind: 'human',
          interventionKind: 'answer',
          context: cap(clarifyContext(question, rec.args), 4000),
          answer:
            this.live && final
              ? '(waiting for the user to answer)'
              : '(the session ended before the user answered)',
        });
        this.chain(id);
        continue;
      }
      // kind === 'tool'
      if (this.live && final) {
        stillRunning.add(rec.nodeId);
        continue;
      }
      const group = this.g.nodes.find((n) => n.id === rec.nodeId);
      if (group) group.errorCount = (group.errorCount ?? 0) + 1;
      if (this.collect) {
        const call = this.details.get(rec.nodeId)?.calls.find((c) => c.toolUseId === callId);
        if (call) {
          call.isError = true;
          call.output = '(no result recorded — the session ended before this call returned)';
        }
      }
    }

    if (this.turn) {
      if (this.live) this.turn.node.status = 'running';
      this.closeTurn();
    }

    for (const n of this.created) {
      if (n.kind !== 'tool') continue;
      if (stillRunning.has(n.id)) {
        // A live group's LATEST call is still executing — an earlier call's
        // result must not leave it stamped "completed".
        n.status = 'running';
      } else {
        if (n.status === 'running') n.status = 'completed';
        if ((n.errorCount ?? 0) > 0 && n.errorCount >= n.callCount) n.status = 'error';
      }
      if (n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
      const files = this.toolFiles.get(n.id);
      if (files?.length) n.files = files;
      const times = this.toolTimes.get(n.id) ?? [];
      const offsets = callOffsetsOf(times, n.callCount);
      if (offsets) n.callOffsets = offsets;
      // Never durationMs: the outlier signal reads it, and giving tool groups
      // one would move a calibrated threshold as a side effect (spec §1).
      const ended = groupEndedAt(times);
      if (ended) n.endedAt = ended;
    }
  }
}

// ---- tool-group timing (spec §1: callOffsets / endedAt) --------------------

/**
 * Epoch-seconds → epoch-milliseconds by the SAME conversion iso() makes, so
 * `Date.parse(iso(sec)) === epochMs(sec)` exactly. The offsets are derived
 * through this rather than by subtracting seconds and rounding, because the
 * invariant the consumer checks is against the ISO strings, not the floats.
 */
function epochMs(sec) {
  if (!Number.isFinite(sec)) return null;
  const ms = new Date(sec * 1000).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The group's callOffsets, or null when the contract says to carry nothing:
 * a single call (call 0 IS the node's start), any untimed call (no partial
 * list), a length that disagrees with callCount, or a list that is not
 * `[0, ≥0, …]` non-decreasing. A row order that goes backwards in time
 * would be a format fact this grammar does not know, and the answer to that
 * is silence, not a smoothed list.
 */
function callOffsetsOf(times, callCount) {
  if (!(callCount >= 2) || times.length !== callCount) return null;
  const t0 = epochMs(times[0].startSec);
  if (t0 == null) return null;
  const out = [];
  for (const { startSec } of times) {
    const ms = epochMs(startSec);
    if (ms == null) return null;
    const off = ms - t0;
    if (off < 0 || (out.length && off < out[out.length - 1])) return null;
    out.push(off);
  }
  return out;
}

/**
 * The group's endedAt: the latest resolution among its calls, and only once
 * EVERY call has one — a live group's pending call, or an ended session's
 * unpaired call, leaves the field absent (never a fabricated instant). Also
 * absent if it would land before the first call's start.
 */
function groupEndedAt(times) {
  if (!times.length) return null;
  let last = null;
  for (const { endSec } of times) {
    const ms = epochMs(endSec);
    if (ms == null) return null;
    if (last == null || ms > last) last = ms;
  }
  const start = epochMs(times[0].startSec);
  if (start == null || last < start) return null;
  return new Date(last).toISOString();
}

// ---- delegation lanes ------------------------------------------------------

/**
 * Materialize this session's delegated children: an agent node per child
 * session, spawn/return edges, and the child's own messages walked
 * recursively into a lane (a group). The tree is exact
 * (`sessions.parent_session_id`); only the pairing of spawn-edge LABELS to
 * children is by dispatch order, which is the accepted limitation.
 */
function materializeChildren(ctx, walker, parentSessionId, parentLive, depth) {
  if (depth > HERMES_MAX_DEPTH) return;
  const children = ctx.q.children(parentSessionId);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (typeof child.id !== 'string' || !child.id || ctx.seen.has(child.id)) continue;
    ctx.seen.add(child.id);
    ctx.stats.agents++;

    const slot = walker.spawnSlots[i] ?? null;
    const delivery = slot?.delegId
      ? (walker.deliveries.find((d) => d.delegId === slot.delegId) ?? null)
      : null;

    const agentId = `a${child.id}`;
    const groupId = `lane:${agentId}`;
    const label =
      snippet(slot?.goal ?? '', 60) ||
      (typeof child.title === 'string' ? snippet(child.title, 60) : '') ||
      child.id;
    ctx.g.groups.push({ id: groupId, label });

    const ended = child.ended_at != null;
    const node = {
      id: agentId,
      kind: 'agent',
      label,
      status: ended ? 'completed' : parentLive ? 'running' : 'error',
      agentId: child.id,
      group: groupId,
      hasDetail: true,
    };
    if (typeof child.model === 'string' && child.model) node.model = child.model;
    const tokens = num(child.input_tokens) + num(child.output_tokens);
    if (tokens > 0) node.tokens = { input: num(child.input_tokens), output: num(child.output_tokens) };
    const startedAt = iso(child.started_at);
    if (startedAt) node.startedAt = startedAt;
    const endedAt = iso(child.ended_at);
    if (endedAt) node.endedAt = endedAt;
    const ms = msBetweenSec(child.started_at, child.ended_at);
    if (ms != null) node.durationMs = ms;
    ctx.g.nodes.push(node);

    const spawnFrom = slot?.fromNodeId ?? walker.turnAt(child.started_at);
    walker.edge('spawn', spawnFrom, agentId, {
      ...(slot?.goal ? { label: snippet(slot.goal, 90) } : {}),
    });

    // The child's own story, walked with the same grammar into its lane.
    const childLive = !ended && parentLive;
    const childWalker = new SessionWalker(ctx, { groupId, startTip: agentId, live: childLive });
    childWalker.walk(ctx.q.messages(child.id));
    ctx.stats.inactive += ctx.q.inactiveCount(child.id);
    const files = childWalker.laneFiles();
    if (files.length) node.files = files;

    if (ended) {
      const labelText = delivery ? deliveryLabel(delivery.text, slot?.batchIndex ?? 0) : undefined;
      walker.edge('return', agentId, delivery?.turnId ?? slot?.turnId ?? spawnFrom, {
        ...(labelText || child.end_reason
          ? { label: snippet(labelText ?? child.end_reason, 90) }
          : {}),
      });
    }

    ctx.details.set(agentId, {
      kind: 'agent',
      prompt: cap(slot?.goal ?? (typeof child.title === 'string' ? child.title : ''), 8000),
      result: delivery
        ? cap(delivery.text, 8000)
        : typeof child.end_reason === 'string' && child.end_reason
          ? child.end_reason
          : null,
      transcript: [],
    });

    // Children of children work the same way.
    materializeChildren(ctx, childWalker, child.id, childLive, depth + 1);
  }
}

/**
 * The k-th task section header of a batch delivery ("✓ TASK k/n: …") — one
 * batch delivery covers every child it dispatched, so each child's return
 * edge takes its own section, by the same dispatch order that paired it.
 */
function deliveryLabel(text, k = 0) {
  if (typeof text !== 'string') return undefined;
  const headers = [...text.matchAll(/^--- (.+)$/gm)];
  return (headers[k] ?? headers[0])?.[1];
}

// ----------------------------------------------------------------- helpers

function safeJson(text) {
  if (typeof text !== 'string') return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A tool result's JSON payload. Hermes appends advisory suffixes after the
 * object ("[Tool loop warning: …]"), so a failed whole-string parse retries
 * on the prefix up to the last brace. `malformed` is true only for content
 * that LOOKS like JSON and still won't parse — plain-text results and
 * `<untrusted_tool_result>` wrappers are recognized shapes, just ones that
 * carry no structured verdict.
 */
export function parseResult(content) {
  if (typeof content !== 'string' || !content.startsWith('{')) return { json: null, malformed: false };
  const whole = safeJson(content);
  if (whole && !Array.isArray(whole)) return { json: whole, malformed: false };
  const cut = safeJson(content.slice(0, content.lastIndexOf('}') + 1));
  if (cut && !Array.isArray(cut)) return { json: cut, malformed: false };
  return { json: null, malformed: true };
}

/**
 * Structured error verdict: terminal-style `exit_code`/`error` fields, or a
 * `success` flag. No free-text matching — an unrecognized payload is not an
 * error (precision over recall).
 */
export function resultIsError(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.success === false) return true;
  if (typeof json.exit_code === 'number' && json.exit_code !== 0) return true;
  if (typeof json.error === 'string' && json.error !== '') return true;
  if (json.error != null && typeof json.error === 'object') return true;
  return false;
}

/** The approval-flow reason carried by a denied result, or null. */
export function denialReason(json) {
  for (const field of [json?.error, json?.message]) {
    if (typeof field !== 'string') continue;
    for (const marker of DENIAL_MARKERS) {
      if (field.includes(marker)) return field;
    }
  }
  return null;
}

/** Display text for a tool result: the output/error fields when structured. */
function resultText(content, json) {
  if (json) {
    const out = typeof json.output === 'string' ? json.output : '';
    const err = typeof json.error === 'string' && json.error ? `[error] ${json.error}` : '';
    if (out || err) return out && err ? `${out}\n${err}` : out || err;
    return JSON.stringify(json);
  }
  return typeof content === 'string' ? content : '';
}

function clarifyContext(question, payload) {
  const choices = Array.isArray(payload?.choices_offered)
    ? payload.choices_offered
    : Array.isArray(payload?.choices)
      ? payload.choices
      : [];
  return [question, ...choices.map((c) => `- ${c}`)].filter(Boolean).join('\n');
}

/**
 * Which tool args name a file the run actually touched. read_file /
 * write_file / patch spell it `path`; everything else is attributed at
 * result time (search_files) or not at all. Terminal `workdir` is a
 * directory, not a file — deliberately absent.
 */
function filePathsFromArgs(name, args) {
  if (name !== 'read_file' && name !== 'write_file' && name !== 'patch') return [];
  const p = args?.path;
  if (typeof p !== 'string' || !p.trim() || p.length > 512 || /[\r\n]/.test(p)) return [];
  return [p];
}

function toolLabel(name, args) {
  const hint = toolHint(name, args);
  return typeof hint === 'string' && hint.trim() ? snippet(`${name} · ${hint}`, 40) : name;
}

function toolHint(name, args) {
  if (!args || typeof args !== 'object') return undefined;
  switch (name) {
    case 'terminal':
      return str(args.command);
    case 'read_file':
    case 'write_file':
    case 'patch':
      return baseName(args.path);
    case 'search_files':
      return str(args.pattern);
    case 'browser_navigate':
      return hostOf(args.url);
    default:
      return undefined;
  }
}

function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function baseName(p) {
  if (typeof p !== 'string' || !p) return undefined;
  return p.split(/[\\/]/).filter(Boolean).pop();
}

function hostOf(url) {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds between two epoch-seconds instants, or null. */
function msBetweenSec(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ms = Math.round((b - a) * 1000);
  return ms >= 0 ? ms : null;
}
