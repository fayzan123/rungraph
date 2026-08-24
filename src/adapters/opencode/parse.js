import { emptyGraph, snippet } from '../../ir.js';
import { mergeFiles } from '../claude-code/files.js';
import { tallyUnknownType } from '../../coverage.js';
import {
  ADAPTER_NAME,
  DENIAL_ERROR,
  KNOWN_PART_TYPES,
  MESSAGE_COLS,
  PART_COLS,
  SESSION_COLS,
  iso,
  modelName,
  num,
  openDb,
  parseData,
  selectList,
  tableColumns,
} from './db.js';

/**
 * opencode parser: rows in, IR out. Pure — no server imports, no I/O beyond
 * the run's own database (plus, only in the crash-recovery case, a scratch
 * copy of it in rungraph's own temp dir — see src/sqlite.js).
 *
 * Grounded in a live probe of ~/.local/share/opencode/opencode.db
 * (2026-08-20, opencode 1.15.6 → 1.18.19):
 *
 * - **Turns are `role='user'` messages; assistant messages are STEPS.** One
 *   user message parents every assistant message until the next one (31 steps
 *   under a single `parentID` observed), and `step-start`/`step-finish` part
 *   counts match the assistant message count exactly.
 * - **Tokens are cumulative and mostly CACHE.** A step's true context is
 *   `tokens.input + tokens.cache.read + tokens.cache.write`; raw `input`
 *   alone is the uncached delta (corpus-wide: 23.0M cache read against 1.2M
 *   raw input). A turn's `tokens.input` is therefore the MAX of its steps'
 *   context — a high-water mark, because each step re-sends the whole
 *   conversation — never a sum. `MAX(raw input)` would take a turn's "peak"
 *   from its COLD FIRST STEP, which is how this was got wrong first.
 * - **`task` parts carry the child session id explicitly**
 *   (`state.metadata.sessionId`), so subagent lanes need no dispatch-order
 *   guessing. `session.parent_id` is the reconciliation check.
 * - **Denials are verbatim**: `state.error === DENIAL_ERROR`.
 * - **Interrupts are recorded** as `message.data.error.name ===
 *   "MessageAbortedError"` — the only message in a 462-message corpus
 *   carrying an `error` key at all. A missing `finish` and an unmatched
 *   `step-start` corroborate it; neither TRIGGERS anything, because a missing
 *   `finish` also means "still running" on a live tail.
 * - **Compaction is non-destructive** and fabricates a `role=user` message
 *   holding exactly one `compaction` part and no `text` part. It is a fact,
 *   not a signal, and it must never read as a prompt a human typed.
 * - **Revert is non-destructive too**: the undone turns are still rows. They
 *   render, MARKED, because deleting them would hide work that happened and
 *   rendering them unqualified would assert work that was thrown away.
 * - **opencode's per-session UI-state table is transient** (18 rows → 0
 *   across one opencode launch) and is read NOWHERE in this adapter. Its name
 *   appears only in the test that greps this directory for it.
 */

/** Observed 1 level of subagent nesting; the cap is a cycle backstop. */
export const OPENCODE_MAX_DEPTH = 5;

/**
 * How long a run must be silent before it counts as over. Deliberately the
 * same 5 minutes as claude-code's `SESSION_QUIET_MS`, and deliberately a
 * separate constant rather than an import: a cross-adapter import is exactly
 * what the vendor-neutrality rule forbids, and this number is a judgement
 * about opencode's own rhythm even where it happens to agree. Generous on
 * purpose — transcripts go quiet for minutes during long thinking blocks and
 * long-running tools, and a false "ended" is worse than a late one.
 */
const OPENCODE_QUIET_MS = 5 * 60 * 1000;

/**
 * `JSON.stringify` that cannot take the process down. The input is a payload
 * another program wrote: V8 parses deeply-nested JSON iteratively but
 * SERIALIZES it recursively, so a blob that `parseData` accepted can still
 * blow the stack on the way back out (RangeError), and a cyclic value throws
 * TypeError. Either one would turn a detail-collecting parse into a 500 and a
 * run that cannot be opened — the never-blank-screen rule, reaching one layer
 * further than the parse guard does.
 */
const safeStringify = (value, indent = 2) => {
  try {
    return JSON.stringify(value, null, indent) ?? '';
  } catch (err) {
    return `(could not render this payload: ${err?.name ?? 'error'})`;
  }
};

const cap = (text, max) => {
  if (typeof text !== 'string') return text == null ? '' : JSON.stringify(text).slice(0, max);
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
};

const TRUNCATION_NOTE =
  '\n\n[output truncated by opencode — this preview is all that was recorded. ' +
  'opencode discards the spill file, so the full payload is not recoverable.]';

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
    const ctx = {
      g,
      details: new Map(),
      collect,
      q,
      seen: new Set([ref.sessionId]),
      stats: {
        // `records` is this adapter's coverage unit: DB ROWS walked (messages
        // + parts, root session and every child). Adapter-defined, never
        // compared across adapters — a row is not a JSONL line.
        records: 0,
        unrecognized: 0,
        sourcesUnread: 0,
        agents: 0,
        toolCalls: 0,
        truncated: 0,
        compactions: 0,
        orphanLanes: 0,
        unresolvedTasks: 0,
        assistantSteps: 0,
        sawInputTokens: false,
        missingChildren: [],
        unknownTypes: {},
        lastMessageAt: 0,
      },
    };

    const walker = new SessionWalker(ctx, {
      groupId: undefined,
      startTip: null,
      revertAt: revertBoundary(q, session),
    });
    walker.walk(ref.sessionId);
    materializeChildren(ctx, walker, ref.sessionId, 1);

    const startedAt = iso(session.time_created);
    if (startedAt) g.meta.startedAt = startedAt;
    // opencode records no session end, so `endedAt` is the last thing that
    // happened — but ONLY once the run has gone quiet. SCHEMA.md's contract is
    // "`endedAt` is absent while the run looks live", and `bundle.js` reads
    // exactly that sentence to stamp an exported live run `[live — exported as
    // a snapshot]`. Setting it unconditionally would strip that warning off
    // every opencode export.
    //
    // The `> 0` guard is not decoration either: `lastMessageAt` starts at 0
    // and `isoMillis(0)` is the TRUTHY string '1970-01-01T00:00:00.000Z', so a
    // session with no messages at all would report having ended in 1970.
    const lastAt = ctx.stats.lastMessageAt;
    if (lastAt > 0 && Date.now() - lastAt >= OPENCODE_QUIET_MS) {
      const endedAt = iso(lastAt);
      if (endedAt) g.meta.endedAt = endedAt;
    }

    g.meta.unrecognizedLineCount = ctx.stats.unrecognized;
    g.meta.coverage = {
      records: ctx.stats.records,
      unrecognized: ctx.stats.unrecognized,
      // Truncation is deliberately NOT counted here: coverage measures
      // rungraph's reading, not opencode's recording. If opencode never wrote
      // the payload down there is nothing rungraph failed to read, and
      // denting a healthy run's badge for it is the false alarm the whole
      // layer exists to prevent.
      sourcesUnread: ctx.stats.sourcesUnread,
    };
    g.meta.totals = {
      tokens: g.nodes.reduce(
        (t, n) => (n.kind === 'turn' && n.tokens ? t + n.tokens.input + n.tokens.output : t),
        0,
      ),
      toolCalls: ctx.stats.toolCalls,
      agents: ctx.stats.agents,
    };
    g.meta.ext = { [ADAPTER_NAME]: runExt(ctx, ref, session, q) };
    return { ir: g, details: ctx.details };
  } finally {
    await close();
  }
}

/** The namespaced bag. Nothing opencode-named leaves it. */
function runExt(ctx, ref, session, q) {
  const s = ctx.stats;
  const revert = parseData(session.revert);
  const firstMessageAt = q.firstMessageAt(ref.sessionId);
  // detect() already resolved this (session.agent, or the modal message agent
  // where the column is NULL). The session-column fallback keeps parse()
  // self-sufficient for a ref built by anything else — and re-applies the one
  // rule that matters: `compaction` is a pseudo-agent stamped on the messages a
  // compaction writes, not an agent anybody chose.
  const refAgent = typeof ref.agent === 'string' && ref.agent ? ref.agent : '';
  const own = typeof session.agent === 'string' ? session.agent.trim() : '';
  const agent = (refAgent || own) !== 'compaction' ? refAgent || own || undefined : undefined;
  const model = modelName(session.model);
  const billed = {
    input: num(session.tokens_input),
    output: num(session.tokens_output),
    cacheRead: num(session.tokens_cache_read),
    cacheWrite: num(session.tokens_cache_write),
  };
  return {
    ...(typeof session.version === 'string' && session.version ? { version: session.version } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(typeof session.directory === 'string' && session.directory
      ? { directory: session.directory }
      : {}),
    ...(Number.isFinite(session.time_archived) && session.time_archived > 0
      ? { archived: true, archivedAt: iso(session.time_archived), archivedAtMs: session.time_archived }
      : {}),
    ...(Number.isFinite(session.cost) && session.cost > 0 ? { cost: session.cost } : {}),
    // opencode's OWN figures, which are SUMS — what `opencode stats` prints
    // and what the provider billed. They are expected to disagree with the
    // IR's `tokens`, which answers a different question (peak context). Both
    // are right; SCHEMA.md says so in words.
    ...(billed.input + billed.output + billed.cacheRead + billed.cacheWrite > 0
      ? { billed }
      : {}),
    // Belt and braces beside the per-node `reverted` flag: an agent that
    // fetches only `meta` is still told this run has rolled-back work in it.
    ...(revert && typeof revert.messageID === 'string'
      ? {
          revert: {
            messageID: revert.messageID,
            ...(typeof revert.snapshot === 'string' ? { snapshot: revert.snapshot } : {}),
          },
        }
      : {}),
    // A fork is a root session that COPIED another session's whole history
    // and records no link back. The rows predating the session row is a
    // causal impossibility unless they were copied — which is why the SIGN of
    // the delta is the rule, not its size. No origin is named: nothing in the
    // schema records one, and guessing from a title would be a guess wearing
    // a fact's clothing.
    ...(Number.isFinite(firstMessageAt) &&
    Number.isFinite(session.time_created) &&
    session.time_created > firstMessageAt
      ? { copiedHistory: true }
      : {}),
    ...(s.compactions > 0 ? { compaction: s.compactions } : {}),
    ...(s.truncated > 0 ? { truncated: s.truncated } : {}),
    ...(s.orphanLanes > 0 ? { orphanLanes: s.orphanLanes } : {}),
    ...(s.unresolvedTasks > 0 ? { unresolvedTasks: s.unresolvedTasks } : {}),
    ...(s.missingChildren.length > 0 ? { missingChildSessions: s.missingChildren } : {}),
    ...(Object.keys(s.unknownTypes).length > 0 ? { unknownTypes: s.unknownTypes } : {}),
    // THE ONE SHAPE ASSERTION. `selectList` protects SQL columns; opencode's
    // payload lives in JSON blobs where it gives no protection at all, and a
    // renamed token key would yield a smaller-but-plausible number with
    // `unrecognized` still at 0. Coverage cannot catch this by construction:
    // it measures unreadable records, not MISREAD ones.
    //
    // Deliberately singular and deliberately narrow. `tokens.input`, because
    // every provider reports input tokens — near-zero false positives. NOT
    // `tokens.cache`, because a provider without prompt caching would
    // legitimately omit it, and that is the false alarm the precision rule
    // exists to prevent. This is not general drift coverage and README says so.
    ...(s.assistantSteps > 0 && !s.sawInputTokens
      ? {
          shapeWarnings: [
            'no assistant step in this run reported a numeric tokens.input — opencode may have renamed the token fields, so this run\'s token figures are not trustworthy',
          ],
        }
      : {}),
  };
}

/**
 * Prepared statements over whatever columns THIS database actually has.
 * Missing ones select as NULL under the same name: the corpus already spans
 * 1.15.6 → 1.18.19, across which `session` gained ten columns, so schema
 * tolerance is a measured requirement rather than tidiness.
 */
function makeQueries(db) {
  const sHave = tableColumns(db, 'session');
  const mHave = tableColumns(db, 'message');
  const pHave = tableColumns(db, 'part');
  if (!sHave.has('id')) throw new Error('no session table — not an opencode.db');

  const sessionStmt = db.prepare(`SELECT ${selectList(sHave, SESSION_COLS)} FROM session WHERE id = ?`);
  // ORDER BY time_created, id — NEVER by id alone: opencode session ids sort
  // DESCENDING with time, and while message ids happen to sort ascending,
  // relying on that would make the ordering rule differ per table.
  const messagesStmt = mHave.has('session_id')
    ? db.prepare(
        `SELECT ${selectList(mHave, MESSAGE_COLS)} FROM message WHERE session_id = ? ORDER BY time_created, id`,
      )
    : null;
  const partsStmt = pHave.has('session_id')
    ? db.prepare(
        `SELECT ${selectList(pHave, PART_COLS)} FROM part WHERE session_id = ? ORDER BY time_created, id`,
      )
    : null;
  const childrenStmt = sHave.has('parent_id')
    ? db.prepare(
        `SELECT ${selectList(sHave, SESSION_COLS)} FROM session WHERE parent_id = ? ORDER BY time_created, id`,
      )
    : null;
  const firstMsgStmt = mHave.has('session_id')
    ? db.prepare('SELECT MIN(time_created) AS t FROM message WHERE session_id = ?')
    : null;
  const messageAtStmt = mHave.has('id')
    ? db.prepare('SELECT time_created FROM message WHERE id = ? AND session_id = ?')
    : null;

  return {
    session: (id) => sessionStmt.get(id) ?? null,
    messages: (id) => messagesStmt?.all(id) ?? [],
    parts: (id) => partsStmt?.all(id) ?? [],
    children: (id) => childrenStmt?.all(id) ?? [],
    firstMessageAt: (id) => {
      const t = firstMsgStmt?.get(id)?.t;
      return Number.isFinite(t) ? t : null;
    },
    messageTime: (messageId, sessionId) => {
      const t = messageAtStmt?.get(messageId, sessionId)?.time_created;
      return Number.isFinite(t) ? t : null;
    },
  };
}

/**
 * The instant a revert rolled this session back to, or null.
 *
 * `revert.messageID` names a TURN, not a step: opencode resolves an assistant
 * id to the user message that began that turn (verified against a live
 * `POST /session/:id/revert`, which stored the user message 5.5s earlier than
 * the assistant id posted). Everything from that instant onward was undone.
 */
function revertBoundary(q, session) {
  const revert = parseData(session.revert);
  const id = typeof revert?.messageID === 'string' ? revert.messageID : null;
  if (!id) return null;
  return q.messageTime(id, session.id);
}

/**
 * Walks one session's messages and parts into turn/tool/human nodes on a
 * sequence chain. The root backbone and every subagent lane use the same
 * walker — a lane is a walk with a `groupId` and the agent node as its root.
 */
class SessionWalker {
  constructor(ctx, { groupId, startTip, revertAt }) {
    this.ctx = ctx;
    this.g = ctx.g;
    this.details = ctx.details;
    this.collect = ctx.collect;
    this.groupId = groupId;
    this.revertAt = Number.isFinite(revertAt) ? revertAt : null;
    this.chainTip = startTip;
    this.pendingReason = null;
    this.turn = null;
    this.turns = []; // [{ id, at }] — spawn/return fallbacks
    this.turnsByMsgId = new Map();
    this.toolTool = new Map(); // tool node id → plain opencode tool name
    this.toolFiles = new Map(); // tool node id → union of touched paths
    this.toolPrev = new Map(); // tool node id → the node it chained off
    this.lastToolNodeId = null; // for patch-part attribution
    this.lastHumanId = null; // for collapsing a refused parallel batch
    this.lastText = ''; // last ASSISTANT text — the return-edge fallback
    this.narration = null; // text since the last tool call, in this message
    this.spawnSlots = []; // task parts, in dispatch order
    this.live = new Set(); // tool nodes with a call still in flight
    // tool node id → { starts: (ms|null)[], ends: (ms|null)[] }, one entry per
    // collapsed call, in call order. Tracked HERE rather than read back out of
    // details.calls because `rungraph graph --json` is the IR path and
    // collects no details — `callOffsets` and the group's `endedAt` have to
    // come out identical whether or not anybody asked for payloads.
    this.toolTimes = new Map();
    this.created = [];
    this.peakContext = 0; // for the agent node this lane hangs from
    this.totalOutput = 0;
  }

  // ---- graph plumbing -----------------------------------------------------

  node(n, at) {
    if (this.groupId) n.group = this.groupId;
    // MARKED, never hidden and never dimmed. Hiding collapses the layout and
    // destroys the spatial memory a graph view is uniquely good for; dimming
    // would collide with the FocusSet, which owns opacity exclusively. Revert
    // renders on its own channel — a struck label and a ↩ badge — so all four
    // focus × revert combinations stay readable.
    if (this.isReverted(at)) n.reverted = true;
    this.g.nodes.push(n);
    this.created.push(n);
    return n;
  }

  isReverted(at) {
    return this.revertAt != null && Number.isFinite(at) && at >= this.revertAt;
  }

  edge(kind, from, to, extra = {}) {
    if (!from || !to || from === to) return undefined;
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

  unknown(type) {
    this.ctx.stats.unrecognized++;
    tallyUnknownType(this.ctx.stats.unknownTypes, type);
  }

  // ---- the walk -----------------------------------------------------------

  walk(sessionId) {
    const messages = this.ctx.q.messages(sessionId);
    const byMessage = new Map();
    const orphanParts = [];
    const known = new Set(messages.map((m) => m.id));
    for (const p of this.ctx.q.parts(sessionId)) {
      if (!known.has(p.message_id)) {
        orphanParts.push(p);
        continue;
      }
      if (!byMessage.has(p.message_id)) byMessage.set(p.message_id, []);
      byMessage.get(p.message_id).push(p);
    }

    for (const row of messages) {
      this.message(row, byMessage.get(row.id) ?? []);
    }
    // Parts whose message row is gone: examined, readable, unplaceable.
    for (const _ of orphanParts) {
      this.ctx.stats.records++;
      this.unknown('orphan_part');
    }
    this.finish();
  }

  message(row, parts) {
    this.ctx.stats.records++;
    if (Number.isFinite(row.time_created) && row.time_created > this.ctx.stats.lastMessageAt) {
      this.ctx.stats.lastMessageAt = row.time_created;
    }
    const data = parseData(row.data);
    if (!data) {
      // A message whose payload will not parse still has parts worth drawing:
      // count the message unrecognized and walk its parts as a step, rather
      // than dropping a whole turn's tool calls to keep a tally tidy.
      this.unknown('message');
      this.parts(row, parts, this.turn, true);
      return;
    }
    if (data.role === 'user') return this.userMessage(row, data, parts);
    if (data.role === 'assistant') return this.assistantMessage(row, data, parts);
    this.unknown(typeof data.role === 'string' ? `role:${data.role}` : 'message');
    this.parts(row, parts, this.turn, true);
  }

  // ---- user messages = turns ---------------------------------------------

  userMessage(row, data, parts) {
    this.closeTurn();
    this.narration = null;
    // Compaction fabricates a user message: exactly one `compaction` part and
    // no `text` part, on every one of the five in the reference corpus. The
    // discriminator is STRUCTURAL, not textual — and it matters, because a
    // naive reading opens a turn node for a prompt no human typed, and that
    // synthetic turn carried the largest single-step context measured.
    const types = parts.map((p) => parseData(p.data)?.type);
    const compaction = types.includes('compaction') && !types.includes('text');
    const prompt = compaction ? '' : firstText(parts);

    const id = `t:${row.id}`;
    const node = this.node(
      {
        id,
        kind: 'turn',
        label: compaction ? '⟳ Context compacted' : snippet(prompt) || '(empty prompt)',
        status: 'completed',
        startedAt: iso(row.time_created),
        hasDetail: true,
      },
      row.time_created,
    );
    this.chain(id);
    // The cross-adapter seam rule: a compaction ALSO rides the next spine
    // edge as lineage, in the one vocabulary Codex and Claude Code use — the
    // turn node is opencode's extra detail on top, not a substitute marker.
    if (compaction) this.pendingReason = 'after context compaction';
    const turn = {
      id,
      node,
      compaction,
      prompt,
      responseText: '',
      contexts: [],
      output: 0,
      startMs: row.time_created,
      endMs: row.time_created,
      running: false,
    };
    this.turn = turn;
    this.turns.push({ id, at: row.time_created });
    this.turnsByMsgId.set(row.id, turn);
    this.parts(row, parts, turn, false);
  }

  closeTurn() {
    const t = this.turn;
    this.turn = null;
    if (!t) return;
    // THE token rule. `input` is the MAX of the steps' true context, never a
    // sum: each opencode step re-sends the whole conversation, so context is
    // a high-water mark and summing it would multiply one conversation by its
    // step count (measured 4.9× on a six-step turn). `output` IS additive.
    const peak = t.contexts.length ? Math.max(...t.contexts) : 0;
    if (peak > 0 || t.output > 0) t.node.tokens = { input: peak, output: t.output };
    if (peak > this.peakContext) this.peakContext = peak;
    this.totalOutput += t.output;
    const ms = t.endMs - t.startMs;
    if (Number.isFinite(ms) && ms > 0) t.node.durationMs = ms;
    const ended = iso(t.endMs);
    if (ended) t.node.endedAt = ended;
    if (t.running) t.node.status = 'running';
    if (this.collect) {
      this.details.set(t.id, {
        kind: 'turn',
        prompt: t.compaction
          ? '(no prompt — opencode compacted the context and continued on its own)'
          : cap(t.prompt, 8000),
        responseText: cap(t.responseText, 8000),
      });
    }
  }

  // ---- assistant messages = steps ----------------------------------------

  assistantMessage(row, data, parts) {
    this.ctx.stats.assistantSteps++;
    // `parentID` names the turn; a dangling or absent one falls back to the
    // most recent user message, which is what the walk position already is.
    const target = this.turnsByMsgId.get(data.parentID) ?? this.turn;
    const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
    if (Number.isFinite(tokens?.input)) this.ctx.stats.sawInputTokens = true;
    if (target) {
      const cache = tokens?.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
      // Cache read + write are part of the context this step actually carried
      // — and are the BULK of it (23.0M vs 1.2M raw, corpus-wide). Folding
      // them in is also what claude-code/helpers.js already does, so all four
      // adapters mean the same thing by `tokens`.
      const context = num(tokens?.input) + num(cache.read) + num(cache.write);
      if (context > 0) target.contexts.push(context);
      target.output += num(tokens?.output);
      const end = Number.isFinite(data.time?.completed) ? data.time.completed : row.time_created;
      if (Number.isFinite(end) && end > target.endMs) target.endMs = end;
    }
    this.narration = null;
    this.parts(row, parts, target, true);
    // AFTER the parts, so the tool node the abort cut off is the chain tip and
    // the tool→human sequence edge lands where signals.js looks for it.
    if (data.error?.name === 'MessageAbortedError') this.interrupted(row, data);
  }

  /**
   * The one unambiguous interrupt marker. A missing `finish` and an unmatched
   * `step-start` corroborate it and are deliberately NOT triggers: a missing
   * `finish` also means "still generating" on a live tail, and firing an
   * interrupt chip at a run in progress is exactly the false flag the
   * precision rule forbids.
   */
  interrupted(row, data) {
    const id = `h:${row.id}:interrupt`;
    if (this.g.nodes.some((n) => n.id === id)) return;
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    this.node(
      {
        id,
        kind: 'human',
        label: 'interrupted the run',
        status: 'completed',
        interventionKind: 'interrupt',
        startedAt: iso(row.time_created),
        hasDetail: true,
      },
      row.time_created,
    );
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'interrupt',
        context: 'The user stopped opencode mid-generation.',
        answer: cap(
          typeof data.error?.data?.message === 'string' ? data.error.data.message : 'Aborted',
          2000,
        ),
      });
    }
    this.chain(id);
    // The tool→human edge is not decoration: humanRefused() in signals.js
    // walks exactly these edges to excuse a refused call from retry-storm and
    // unresolved-error. chain() already made it when the tool node was the
    // tip; this covers the case where it was not.
    if (tip?.kind === 'tool') this.edge('sequence', tip.id, id);
    this.pendingReason = 'after the user interrupted';
  }

  // ---- parts --------------------------------------------------------------

  parts(row, parts, turn, isAssistant) {
    for (const p of parts) {
      this.ctx.stats.records++;
      const d = parseData(p.data);
      if (!d || typeof d.type !== 'string') {
        this.unknown('part');
        continue;
      }
      if (!KNOWN_PART_TYPES.has(d.type)) {
        this.unknown(d.type);
        continue;
      }
      switch (d.type) {
        case 'text':
          if (typeof d.text === 'string' && d.text.trim()) {
            if (turn && isAssistant) turn.responseText += (turn.responseText ? '\n\n' : '') + d.text;
            if (isAssistant) this.lastText = d.text;
            this.narration = d.text;
          }
          break;
        case 'tool':
          this.toolPart(p, d, row, turn);
          break;
        case 'patch':
          this.patchPart(d);
          break;
        case 'compaction':
          this.ctx.stats.compactions++;
          break;
        // step-start / step-finish / reasoning are recognized structure with
        // no node of their own. Recognized is the point: skipping them
        // silently would count 1,117 of the corpus's parts as unread.
        default:
          break;
      }
    }
  }

  /**
   * `patch.files` is an ABSOLUTE path list opencode wrote itself — exact file
   * attribution, the one axis where this adapter beats the Claude Code one
   * outright. A patch part follows the edit/write that produced it, so it
   * attributes to that tool node.
   */
  patchPart(d) {
    const files = Array.isArray(d.files) ? d.files.filter(isPath) : [];
    if (files.length && this.lastToolNodeId) this.attachFiles(this.lastToolNodeId, files);
  }

  toolPart(p, d, row, turn) {
    const tool = typeof d.tool === 'string' && d.tool ? d.tool : 'tool';
    const state = d.state && typeof d.state === 'object' ? d.state : {};
    const input = state.input && typeof state.input === 'object' ? state.input : {};

    const status = typeof state.status === 'string' ? state.status : '';
    const isError = status === 'error';
    const denied = isError && state.error === DENIAL_ERROR;

    // A dispatch that SUCCEEDED becomes a lane, not a tool node. A dispatch
    // that FAILED spawned nothing, so there is no lane to draw — and it must
    // still be drawn as the failed call it was. opencode permission-gates
    // `task` BEFORE it creates the child session row, so a refused subagent
    // lands here with the exact rejection string and no `metadata.sessionId`:
    // routing every `task` to taskPart() would swallow the whole intervention
    // and render "the user refused a subagent" as "nothing happened". The same
    // pre-dispatch drop covers depth-limit and unknown-agent-type failures.
    if (tool === 'task' && !isError) return this.taskPart(p, d, state, input, turn);
    if (tool === 'question' && state.metadata?.answers) return this.questionPart(p, state, input, row);
    // Anything that is neither completed nor error is still in flight — the
    // live-tail shape. It must not read as a failure.
    const running = status !== 'completed' && status !== 'error';
    const truncated = state.metadata?.truncated === true;
    const startMs = Number.isFinite(state.time?.start) ? state.time.start : p.time_created;

    // Consecutive same-tool calls collapse into one node, matching the canvas
    // convention (`read · package.json ×2`). Keyed on the recorded tool name,
    // never the label, which is descriptive.
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    let nodeId;
    if (tip && tip.kind === 'tool' && this.toolTool.get(tip.id) === tool) {
      tip.callCount += 1;
      nodeId = tip.id;
    } else {
      // `prt_…` — the DATABASE's own key. `callID` is provider-generated text
      // whose format is unstable (three different shapes across two opencode
      // versions, one of them hyphen-separated), so node id stability comes
      // from the part id instead.
      nodeId = `g:${p.id}`;
      this.node(
        {
          id: nodeId,
          kind: 'tool',
          label: toolLabel(tool, input, state.title),
          // Settled by finish(), which is the only place that can see the
          // whole collapsed group. Liveness is tracked in `this.live` rather
          // than in this field: a placeholder 'running' here would be
          // indistinguishable from a call that really is still in flight, and
          // the promotion to 'error' would silently never happen.
          status: 'completed',
          callCount: 1,
          errorCount: 0,
          startedAt: iso(startMs),
          hasDetail: true,
        },
        row.time_created,
      );
      this.toolTool.set(nodeId, tool);
      this.toolPrev.set(nodeId, this.chainTip);
      if (this.collect) {
        this.details.set(nodeId, {
          kind: 'tool',
          name: tool,
          ...(this.narration ? { context: cap(this.narration, 2000) } : {}),
          calls: [],
        });
      }
      this.chain(nodeId);
    }
    this.lastToolNodeId = nodeId;
    this.narration = null;
    this.ctx.stats.toolCalls++;

    // `state.time.end` is written when the call resolves — a result, an error
    // or a denial alike (a denial IS an `error` part here, so it lands its
    // own end). A part with no end is a call still in flight; a `running`
    // part carrying one is a contradiction the adapter does not adjudicate,
    // so it counts as unresolved. Recorded whether or not details are being
    // collected — see `toolTimes`.
    const endMs = Number.isFinite(state.time?.end) ? state.time.end : null;
    const times = this.toolTimes.get(nodeId) ?? { starts: [], ends: [] };
    times.starts.push(Number.isFinite(startMs) ? startMs : null);
    times.ends.push(!running && endMs != null ? endMs : null);
    this.toolTimes.set(nodeId, times);

    const group = this.g.nodes.find((n) => n.id === nodeId);
    if (group) {
      if (isError) group.errorCount += 1;
      if (running) {
        this.live.add(nodeId);
        if (turn) turn.running = true;
      }
      if (truncated) {
        this.ctx.stats.truncated++;
        const bag = (group.ext ??= {});
        const own = (bag[ADAPTER_NAME] ??= {});
        own.truncated = (own.truncated ?? 0) + 1;
      }
    }
    const paths = filePathsFromInput(tool, input);
    if (paths.length) this.attachFiles(nodeId, paths);

    if (this.collect) {
      this.details.get(nodeId)?.calls.push({
        toolUseId: typeof d.callID === 'string' ? d.callID : p.id,
        input: cap(safeStringify(input), 3000),
        output: cap(toolOutputText(state, truncated), 4000),
        isError,
        ...(truncated ? { truncated: true } : {}),
        startedAt: iso(startMs),
        ...(endMs != null && endMs >= startMs ? { durationMs: endMs - startMs } : {}),
      });
    }

    if (denied) return this.denial(p, row, tool, input, nodeId);
    if (isError) this.pendingReason = `after ${tool} error`;
  }

  /**
   * A refused call. The denied call still counts against its group — and the
   * human node right after it, with its tool→human `sequence` edge, is what
   * tells signals.js this "error" was a person saying no rather than a retry
   * to flag. Emit the node without the edge and the exclusion silently never
   * happens.
   */
  denial(p, row, tool, input, toolNodeId) {
    // Consecutive denials (a refused parallel batch) collapse into one node.
    //
    // The test is "the tool node just denied chained DIRECTLY off the previous
    // denial", not "the chain tip is that denial": by the time denial() runs,
    // toolPart() has already chained the tool node, so the tip is the tool
    // node and never the human one. Getting that wrong makes the branch
    // unsatisfiable and a refused batch of five renders as five human nodes.
    const prev = this.g.nodes.find((n) => n.id === this.lastHumanId);
    if (prev?.interventionKind === 'denial' && this.toolPrev.get(toolNodeId) === prev.id) {
      prev.label = snippet(`${prev.label}, ${tool}`, 60);
      this.edge('sequence', toolNodeId, prev.id);
      return;
    }
    const id = `h:${p.id}`;
    this.node(
      {
        id,
        kind: 'human',
        label: `denied ${tool}`,
        status: 'completed',
        interventionKind: 'denial',
        startedAt: iso(p.time_created),
        hasDetail: true,
      },
      row.time_created,
    );
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'denial',
        context: cap(safeStringify(input), 3000),
        answer: DENIAL_ERROR,
      });
    }
    this.chain(id);
    this.edge('sequence', toolNodeId, id);
    this.lastHumanId = id;
    this.pendingReason = 'after permission denial';
  }

  /** A `question` tool whose metadata carries answers: a human answered. */
  questionPart(p, state, input, row) {
    const answers = state.metadata.answers;
    const text = answerText(answers);
    const id = `h:${p.id}`;
    this.node(
      {
        id,
        kind: 'human',
        label: snippet(`answered: ${text}`, 70) || 'answered a question',
        status: 'completed',
        interventionKind: 'answer',
        startedAt: iso(p.time_created),
        hasDetail: true,
      },
      row.time_created,
    );
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'answer',
        context: cap(questionContext(input), 4000),
        answer: cap(typeof answers === 'string' ? answers : safeStringify(answers), 4000),
      });
    }
    this.chain(id);
    this.lastHumanId = id;
    this.narration = null;
    this.pendingReason = `answer: ${snippet(text, 50)}`;
  }

  /**
   * A dispatch. The task part is AUTHORITATIVE for the spawn edge — it
   * carries the child session id outright, plus the description, the prompt
   * and the timing — and `session.parent_id` is the reconciliation check.
   */
  taskPart(p, d, state, input, turn) {
    const meta = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
    this.spawnSlots.push({
      partId: p.id,
      childSessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
      description: typeof input.description === 'string' ? input.description : '',
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : '',
      output: typeof state.output === 'string' ? state.output : '',
      status: typeof state.status === 'string' ? state.status : '',
      model: modelName(meta.model),
      fromNodeId: this.chainTip,
      turnId: turn?.id ?? null,
      startMs: Number.isFinite(state.time?.start) ? state.time.start : p.time_created,
      endMs: Number.isFinite(state.time?.end) ? state.time.end : null,
      at: p.time_created,
    });
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

  /** Which turn was open at a given instant — spawn/return fallbacks. */
  turnAt(at) {
    let cur = null;
    for (const t of this.turns) {
      if (Number.isFinite(t.at) && Number.isFinite(at) && t.at <= at) cur = t.id;
      else if (cur) break;
    }
    return cur;
  }

  finish() {
    this.closeTurn();
    for (const n of this.created) {
      if (n.kind !== 'tool') continue;
      // THE CROSS-ADAPTER INVARIANT: a collapsed node is `error` only when
      // EVERY collapsed call failed. isStormNode() in signals.js is
      // `errorsOf(n) > 0 && n.status === 'error'`, so retry-storm's entire
      // precision rests on this meaning. The naive reading — any error makes
      // the node an error — reports a retry storm on ordinary work, and
      // opencode reaches it easily: one real batch is 14 `read` calls with 5
      // errors, all on DIFFERENT non-existent paths (the model probing a
      // namespace, retrying nothing).
      if (this.live.has(n.id)) n.status = 'running';
      else if (n.errorCount > 0 && n.errorCount >= n.callCount) n.status = 'error';
      if (n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
      const files = this.toolFiles.get(n.id);
      if (files?.length) n.files = files;
      const offsets = callOffsetsOf(this.toolTimes.get(n.id), n.callCount);
      if (offsets) n.callOffsets = offsets;
      const endedAt = groupEndOf(this.toolTimes.get(n.id), n.callCount, this.live.has(n.id));
      if (endedAt) n.endedAt = endedAt;
    }
  }
}

/**
 * Replay's per-call timing on a collapsed group: each call's start in whole
 * milliseconds after the node's `startedAt`, in call order. Absent — never
 * partial, never `[0]` — unless the group has two or more calls and EVERY one
 * of them was timed; a single-call node's start IS `startedAt`, and a half
 * list would desynchronise the replay's `×k` count from the real one.
 *
 * Truncated to whole ms before subtracting, because `startedAt` was rendered
 * through `Date#toISOString`, which clips its argument to an integer: the
 * consumer's guard is `Date.parse(calls[i].startedAt) − Date.parse(startedAt)`,
 * and a fractional `time.start` (not observed, but the blob is opencode's to
 * write) would otherwise make the two arithmetics disagree by a millisecond.
 *
 * A list that comes out decreasing — a part recorded out of start order — or
 * of the wrong length is dropped whole rather than repaired: the consumer
 * ignores a malformed list, but the adapter must not lean on that.
 */
function callOffsetsOf(times, callCount) {
  if (!times || callCount < 2 || times.starts.length !== callCount) return undefined;
  if (times.starts.some((s) => s == null)) return undefined;
  const base = Math.trunc(times.starts[0]);
  const out = [];
  for (const s of times.starts) {
    const offset = Math.trunc(s) - base;
    if (!Number.isFinite(offset) || offset < 0 || (out.length && offset < out[out.length - 1])) {
      return undefined;
    }
    out.push(offset);
  }
  return out;
}

/**
 * When the group's LAST call resolved — its last result, error or denial.
 * Present only once every collapsed call has an end; a group with one call
 * still in flight carries none, exactly as a live turn does. Deliberately
 * `endedAt` and NOT `durationMs`: the outlier signal reads `durationMs`, and
 * giving tool groups one would move a calibrated threshold as a side effect.
 * The `< start` guard drops an end that would predate the node's own start
 * rather than emit a negative interval.
 */
function groupEndOf(times, callCount, live) {
  if (!times || live || times.ends.length !== callCount) return undefined;
  if (times.ends.some((e) => e == null)) return undefined;
  const last = Math.max(...times.ends);
  const start = times.starts[0];
  if (Number.isFinite(start) && last < start) return undefined;
  return iso(last);
}

// ---- subagent lanes --------------------------------------------------------

/**
 * Materialize this session's subagent children: an agent node per child
 * session, spawn/return edges, and the child's own messages walked
 * recursively into a lane.
 *
 * The two reconciliation mismatches resolve DIFFERENTLY and deliberately:
 *
 * - A child with `parent_id` but no surviving task part (compaction pruned
 *   it) gets a lane and a synthetic spawn edge, and NO coverage penalty — the
 *   child was read completely.
 * - A task part naming a session row that no longer exists is
 *   `sourcesUnread` +1, matching the IR's definition of a referenced source
 *   that could not be opened at all.
 */
function materializeChildren(ctx, walker, parentSessionId, depth) {
  if (depth > OPENCODE_MAX_DEPTH) return;
  const children = ctx.q.children(parentSessionId);
  const byId = new Map(children.map((c) => [c.id, c]));
  const claimed = new Set();

  for (const slot of walker.spawnSlots) {
    if (!slot.childSessionId) {
      // A task part that names NO session is not a source rungraph failed to
      // read — it is a dispatch opencode had not yet recorded a child for
      // (a live tail catching the moment between the tool call and
      // `metadata({sessionId})`). Nothing was written, so counting it against
      // coverage would claim a blind spot that does not exist, and dent a
      // healthy run's badge for it. Reported in `ext` instead.
      ctx.stats.unresolvedTasks++;
      continue;
    }
    const child = byId.get(slot.childSessionId) ?? ctx.q.session(slot.childSessionId);
    if (!child) {
      // A task part naming a session row that is GONE is exactly the IR's
      // definition of `sourcesUnread`: a referenced source it could not open.
      ctx.stats.sourcesUnread++;
      ctx.stats.missingChildren.push(slot.childSessionId);
      continue;
    }
    claimed.add(child.id);
    lane(ctx, walker, child, slot, depth);
  }

  for (const child of children) {
    if (claimed.has(child.id)) continue;
    ctx.stats.orphanLanes++;
    lane(ctx, walker, child, null, depth);
  }
}

function lane(ctx, walker, child, slot, depth) {
  if (typeof child.id !== 'string' || !child.id || ctx.seen.has(child.id)) return;
  ctx.seen.add(child.id);
  ctx.stats.agents++;

  const agentId = `a:${child.id}`;
  const groupId = `lane:${agentId}`;
  const label =
    snippet(slot?.description ?? '', 60) ||
    (typeof child.title === 'string' ? snippet(child.title, 60) : '') ||
    child.id;
  ctx.g.groups.push({ id: groupId, label });

  const node = {
    id: agentId,
    kind: 'agent',
    label,
    status: slot?.status === 'error' ? 'error' : slot?.status === 'completed' || !slot ? 'completed' : 'running',
    agentId: child.id,
    group: groupId,
    hasDetail: true,
  };
  const model = slot?.model ?? modelName(child.model);
  if (model) node.model = model;
  const startedAt = iso(slot?.startMs ?? child.time_created);
  if (startedAt) node.startedAt = startedAt;
  const endedAt = iso(slot?.endMs);
  if (endedAt) node.endedAt = endedAt;
  if (Number.isFinite(slot?.endMs) && Number.isFinite(slot?.startMs) && slot.endMs > slot.startMs) {
    node.durationMs = slot.endMs - slot.startMs;
  }
  if (walker.isReverted(slot?.at ?? child.time_created)) node.reverted = true;
  ctx.g.nodes.push(node);

  walker.edge('spawn', slot?.fromNodeId ?? walker.turnAt(child.time_created), agentId, {
    // A lane rebuilt without its task part says so, rather than presenting a
    // reconstruction as a record — on the LABEL, never on `reason`. `reason`
    // is decision lineage, and courseChanges() in signals.js promotes it into
    // a chip: a provenance caveat there would read as "the run changed course
    // because its spawn record was pruned", which is not a thing that happened.
    label: slot?.description
      ? snippet(slot.description, 90)
      : '(spawn record not retained — compacted)',
  });

  const childWalker = new SessionWalker(ctx, {
    groupId,
    startTip: agentId,
    // INHERIT the parent's boundary when the child has none of its own, which
    // is every subagent: `revert` is written on the session row the user was
    // looking at, never on the child it dispatched. Without this the agent
    // node is struck through (line below uses the parent walker) while every
    // turn and tool node INSIDE its lane renders unqualified — and, worse,
    // work-quality signals fire on it, because signals.js reads the same
    // `reverted` field. Timestamps are absolute epoch ms on one clock, so the
    // parent's instant applies unchanged; a lane dispatched BEFORE the
    // boundary still compares as not reverted, which is correct.
    revertAt: revertBoundary(ctx.q, child) ?? walker.revertAt,
  });
  childWalker.walk(child.id);
  const files = childWalker.laneFiles();
  if (files.length) node.files = files;
  if (childWalker.peakContext > 0 || childWalker.totalOutput > 0) {
    node.tokens = { input: childWalker.peakContext, output: childWalker.totalOutput };
  }

  const result = slot?.output || childWalker.lastText || '';
  walker.edge('return', agentId, slot?.turnId ?? walker.turnAt(child.time_created) ?? slot?.fromNodeId, {
    ...(result ? { label: snippet(taskResult(result), 90) } : {}),
  });

  ctx.details.set(agentId, {
    kind: 'agent',
    prompt: cap(slot?.prompt || label, 8000),
    result: result ? cap(taskResult(result), 8000) : null,
    transcript: [],
  });

  materializeChildren(ctx, childWalker, child.id, depth + 1);
}

// ----------------------------------------------------------------- helpers

/**
 * Label for a tool-group node.
 *
 * `state.title` is a SOURCE for the subject, not the label: opencode writes it
 * on 659 of 669 tool parts, but 10 are empty and the rest are inconsistent
 * (`Parallel Web Search: …`, or a bare `dashboard/package.json`). So the
 * subject is the title when there is one and a per-tool read of the input
 * otherwise, and the `<tool> · <subject>` shape is rungraph's, matching every
 * other adapter — which is also what lets `toolFamily()` in signals.js
 * recover the family from the display label.
 *
 * This is a LOCAL equivalent of claude-code's `toolNodeLabel`, deliberately
 * not an import: label formatting is format knowledge, and format knowledge
 * lives in adapters.
 */
export function toolLabel(tool, input, title, max = 40) {
  try {
    const subject =
      (typeof title === 'string' && title.trim() ? title.trim() : '') || toolHint(tool, input) || '';
    if (!subject) return tool;
    return snippet(`${tool} · ${subject}`, max);
  } catch {
    return tool;
  }
}

function toolHint(tool, input) {
  if (!input || typeof input !== 'object') return undefined;
  switch (tool) {
    case 'bash':
      return str(input.description) || str(input.command);
    case 'read':
    case 'edit':
    case 'write':
      return baseName(input.filePath);
    case 'grep':
    case 'glob':
      return str(input.pattern);
    case 'websearch':
      return str(input.query);
    case 'webfetch':
      return hostOf(input.url);
    case 'skill':
      return str(input.name);
    case 'task':
      return str(input.description);
    default:
      return undefined;
  }
}

/**
 * Which tool inputs name a file the run actually touched. `filePath` is
 * opencode's spelling on read/edit/write; grep/glob `path` is a search ROOT (a
 * directory, not a file that was touched) and bash `command` is guesswork.
 * Precision over recall — a wrong file on a node costs more than a missing one.
 */
export function filePathsFromInput(tool, input) {
  if (tool !== 'read' && tool !== 'edit' && tool !== 'write') return [];
  const p = input?.filePath;
  return isPath(p) ? [p] : [];
}

function isPath(p) {
  return typeof p === 'string' && Boolean(p.trim()) && p.length <= 512 && !/[\r\n]/.test(p);
}

/** The first non-empty `text` part of a message — the human's prompt. */
function firstText(parts) {
  for (const p of parts) {
    const d = parseData(p.data);
    if (d?.type === 'text' && typeof d.text === 'string' && d.text.trim()) return d.text;
  }
  return '';
}

/**
 * Display text for a tool result. A truncated call carries opencode's own
 * preview and says so in words — the spill file it came from does not survive
 * (two existed at 16:16 and the directory was empty afterwards while 58
 * truncated parts still referenced content), so the preview is the ceiling
 * and there is nothing to fetch lazily.
 */
function toolOutputText(state, truncated) {
  const preview = typeof state.metadata?.preview === 'string' ? state.metadata.preview : '';
  const output = typeof state.output === 'string' ? state.output : '';
  const error = typeof state.error === 'string' ? state.error : '';
  const body = error || output || preview;
  return truncated ? `${body}${TRUNCATION_NOTE}` : body;
}

/** opencode wraps a subagent's answer in `<task_result>…</task_result>`. */
function taskResult(text) {
  const m = String(text).match(/<task_result>([\s\S]*?)<\/task_result>/);
  return (m ? m[1] : String(text)).trim();
}

/**
 * The text a person actually chose, out of `state.metadata.answers`.
 *
 * The observed shape is NESTED — `[["Instagram/Facebook DMs"]]`, one array per
 * question holding the labels picked for it — so a flat `filter(isString)`
 * silently yields the empty string and the intervention chip reads
 * "answered:" with nothing after it. Flattened rather than special-cased for
 * the two-deep case, because this is a provider-written payload; the depth cap
 * is the backstop for a hostile or cyclic one.
 */
function answerText(answers) {
  const out = [];
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      if (v.trim()) out.push(v.trim());
      return;
    }
    if (depth > 4 || !v || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(answers, 0);
  return out.join(', ');
}

function questionContext(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const lines = [];
  for (const q of questions) {
    if (typeof q?.question === 'string') lines.push(q.question);
    for (const o of Array.isArray(q?.options) ? q.options : []) {
      if (typeof o?.label === 'string') lines.push(`- ${o.label}`);
    }
  }
  return lines.join('\n');
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v : undefined;
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
