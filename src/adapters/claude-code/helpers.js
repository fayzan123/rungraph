/** Shared helpers for the claude-code adapter. Format knowledge only. */

import { snippet } from '../../ir.js';

/** Line types we understand in MAIN session files. Anything else → unrecognized. */
export const KNOWN_MAIN_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'ai-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'pr-link',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'summary', // legacy; tolerated
]);

/**
 * Types tolerated only in the SHAPE we actually observed, never by name alone.
 *
 * `atis-latch` appeared in Claude Code output in August 2026 and pushed the
 * skip rate from 0% to ~5% on every new session. The first 220 samples were
 * `{ type, atis, sessionId }` with `atis === ''`; by 2026-08-23 the corpus
 * held 857, of which 140 carried a POPULATED `atis` — an opaque token
 * (`v1.<hex>.…`, or a bare 16-hex id), never prose — and the key set had not
 * changed. `bridge-session` arrived with Claude Code's remote-control bridge
 * (393 lines over 12 sessions here): `{ type, sessionId, bridgeSessionId,
 * lastSequenceNum, ownerAccountUuid, ownerOrganizationUuid }`, ids and a
 * counter, no content.
 *
 * The general policy, not a one-off: RECOGNIZE THE SHAPE YOU OBSERVED. The
 * shape is the KEY SET, checked exactly — a line of a known type that grows a
 * key (a `message`, a `content`) is a shape nobody has seen and falls through
 * to unrecognized, where it is visible. The value of `atis` is deliberately
 * NOT inspected: it is a token rungraph never carries anywhere, and gating on
 * its emptiness is what made every populated latch read as drift for three
 * weeks (148 "unrecognized" records on an ordinary session, found by
 * dogfooding). Adding the bare NAME would be the opposite mistake: the day a
 * latch line carries content, rungraph would swallow it *and report 100%
 * coverage* — manufacturing precisely the blind spot the coverage layer
 * exists to remove.
 *
 * A MAP, not an object literal, and that is load-bearing: `obj.type` is
 * transcript-controlled, so a plain-object lookup would walk the prototype
 * chain — `{"type":"constructor"}` would find a truthy "gate" and be counted as
 * READ, and `{"type":"valueOf"}` would throw. Both defeat the layer this gate
 * belongs to. The same reason `KNOWN_MAIN_TYPES` is a Set.
 */
export const SHAPE_GATED_MAIN_TYPES = new Map([
  ['atis-latch', exactKeys(['type', 'sessionId'], ['atis'], { atis: 'string' })],
  [
    'bridge-session',
    exactKeys(
      ['type', 'sessionId', 'bridgeSessionId', 'lastSequenceNum', 'ownerAccountUuid', 'ownerOrganizationUuid'],
      [],
      { bridgeSessionId: 'string', lastSequenceNum: 'number' },
    ),
  ],
]);

/**
 * A shape gate: the object's own keys must be exactly `required` plus any
 * subset of `optional`, and each listed value must have the listed type.
 * Own keys only (`Object.keys`), so nothing inherited can satisfy it.
 */
function exactKeys(required, optional, types) {
  const allowed = new Set([...required, ...optional]);
  return (obj) => {
    const keys = Object.keys(obj);
    if (keys.length < required.length || keys.length > allowed.size) return false;
    for (const k of keys) if (!allowed.has(k)) return false;
    for (const k of required) if (!Object.hasOwn(obj, k)) return false;
    for (const [k, t] of Object.entries(types)) {
      if (Object.hasOwn(obj, k) && typeof obj[k] !== t) return false;
    }
    return true;
  };
}

/** True if a main-session line is one this adapter understands. */
export function isKnownMainLine(obj) {
  if (typeof obj?.type !== 'string') return false;
  const gate = SHAPE_GATED_MAIN_TYPES.get(obj.type);
  if (gate) return gate(obj) === true;
  return KNOWN_MAIN_TYPES.has(obj.type);
}

/** Line types we understand in agent transcript files. */
export const KNOWN_AGENT_TYPES = new Set(['user', 'assistant', 'attachment']);

export const INTERRUPT_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

/** Extract plain text from a message content (string or block array). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Blocks of a given type from a message content array. */
export function blocksOf(message, type) {
  const c = message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === type);
}

/** True if a user line is a human-typed prompt that starts a turn. */
export function isPromptLine(obj) {
  if (obj.type !== 'user' || obj.isMeta) return false;
  // The compact summary is synthetic — the binary groups `isCompactSummary`
  // and `isVisibleInTranscriptOnly` with `isMeta` as "not typed by a human"
  // (some paths carry only one of the two flags). Without this, the summary's
  // string content reads as a prompt and puts a turn nobody typed on the spine.
  if (obj.isCompactSummary || obj.isVisibleInTranscriptOnly) return false;
  const c = obj.message?.content;
  if (typeof c === 'string') {
    if (c.startsWith('<local-command-stdout>')) return false;
    if (c.startsWith('<task-notification>')) return false;
    if (c.startsWith('<local-command-caveat>')) return false;
    return c.trim().length > 0;
  }
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return false;
    const text = contentText(c);
    if (!text.trim()) return false;
    if (INTERRUPT_TEXTS.has(text.trim())) return false;
    return true;
  }
  return false;
}

/** Label for a prompt: slash commands become "/name args", else a snippet. */
export function promptLabel(obj) {
  const c = obj.message?.content;
  const text = typeof c === 'string' ? c : contentText(c);
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const name = tag(text, 'command-name') ?? tag(text, 'command-message');
    const args = tag(text, 'command-args');
    return `${name ?? '(command)'}${args ? ' ' + args : ''}`.trim();
  }
  return text;
}

function tag(text, name) {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : undefined;
}

/**
 * Parse a <task-notification> XML blob (from queue-operation content or a
 * user string line). Returns null if it doesn't look like one.
 * task-id prefixes: a = agent, b = background bash, w = workflow task.
 */
export function parseTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const t = (name) => tag(text, name);
  const taskId = t('task-id');
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: t('tool-use-id'),
    status: t('status'), // completed | failed | killed | running
    summary: t('summary'),
    result: t('result'),
  };
}

/**
 * Descriptive label for a tool-group node, synthesized from the call's input:
 * "Bash · npm test", "Read · session.ts", "Grep · waitForURL". Unknown tools
 * or any synthesis failure fall back to the plain tool name (never-blank-screen).
 */
export function toolNodeLabel(name, input, max = 40) {
  try {
    // An MCP tool is named `mcp__<server>__<tool>` in the transcript. The raw
    // id ran past the node's width and said nothing a person reads
    // (`mcp__claude-in-chrome__computer ×6`); `computer · claude-in-chrome`
    // keeps the family in the head segment where `toolFamily()` reads it and
    // puts the server where a hint goes. Found by dogfooding a browser session.
    const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
    if (mcp) return snippet(`${mcp[2]} · ${mcp[1]}`, max);
    let hint;
    if (name === 'Bash') hint = input.description || input.command;
    else if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit')
      hint = baseName(input.file_path);
    else if (name === 'Grep' || name === 'Glob') hint = input.pattern;
    else if (name === 'WebFetch') hint = new URL(input.url).hostname;
    else if (name === 'WebSearch') hint = input.query;
    if (typeof hint !== 'string' || !hint.trim()) return name;
    return snippet(`${name} · ${hint}`, max);
  } catch {
    return name;
  }
}

function baseName(p) {
  if (typeof p !== 'string') return undefined;
  return p.split(/[\\/]/).filter(Boolean).pop();
}

/** Was a kill human-initiated, per the notification summary phrasing? */
export function isHumanStop(summary) {
  return /stopped by (the )?user/.test(summary ?? '');
}

/**
 * Accumulates token usage, deduping split assistant lines by message.id
 * (one API message spans multiple JSONL lines, each repeating usage —
 * last write wins, then sum once per message).
 */
export class UsageTally {
  constructor() {
    this.byMessage = new Map();
  }
  add(message) {
    const u = message?.usage;
    if (!u || !message.id) return;
    this.byMessage.set(message.id, u);
  }
  totals() {
    let input = 0;
    let output = 0;
    for (const u of this.byMessage.values()) {
      input +=
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      output += u.output_tokens ?? 0;
    }
    return { input, output };
  }
  outputOnlyTotals() {
    let input = 0;
    let output = 0;
    for (const u of this.byMessage.values()) {
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
    }
    return { input, output };
  }
}

/** Cap a string for detail payloads (display artifacts, not data fidelity). */
export function cap(text, max = 10000) {
  if (typeof text !== 'string') return text == null ? '' : JSON.stringify(text).slice(0, max);
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
}

/** Strip ANSI escape sequences (local_command output embeds them). */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '').replace(/\[[0-9;]+m/g, '');
}

/** ms between two ISO timestamps, or undefined. */
export function msBetween(a, b) {
  if (!a || !b) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** A file is "live" if modified within the window. */
export function looksLive(mtimeIso, windowMs = 45000, now = Date.now()) {
  return now - Date.parse(mtimeIso) < windowMs;
}

/**
 * Liveness windows for status derivation. Transcripts go quiet for minutes
 * during long thinking blocks or long-running tools, so these are generous:
 * a session only counts as over after 5 minutes with zero writes across ALL
 * of its files, a manifest-less workflow after 15. (The index "live" badge
 * uses its own tighter window — a stale badge is harmless, a false "error"
 * status is not.)
 */
export const SESSION_QUIET_MS = 5 * 60 * 1000;
export const WORKFLOW_QUIET_MS = 15 * 60 * 1000;
