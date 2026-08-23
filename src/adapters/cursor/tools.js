/**
 * Cursor IDE tool vocabulary — the `ClientSideToolV2` enum and the display
 * names the canvas uses for it. IDE only: the CLI's tool names are already
 * plain (`Read`, `Shell`, `StrReplace`) and are used as they are.
 *
 * The enum is extracted VERBATIM from `workbench.desktop.main.js` of Cursor
 * 3.16.29 (55 entries, numbered 0–66 with gaps). Cursor's own indexer keys a
 * call by `name` and falls back to `tool`; `search_conversations` is the case
 * that forced that order — it is tool `0`, the enum's UNSPECIFIED.
 *
 * Pure: no imports.
 */

/** `tool` number → enum member (the `CLIENT_SIDE_TOOL_V2_` prefix stripped). */
export const CLIENT_SIDE_TOOL_V2 = Object.freeze({
  0: 'UNSPECIFIED',
  1: 'READ_SEMSEARCH_FILES',
  3: 'RIPGREP_SEARCH',
  5: 'READ_FILE',
  6: 'LIST_DIR',
  7: 'EDIT_FILE',
  8: 'FILE_SEARCH',
  9: 'SEMANTIC_SEARCH_FULL',
  11: 'DELETE_FILE',
  12: 'REAPPLY',
  15: 'RUN_TERMINAL_COMMAND_V2',
  16: 'FETCH_RULES',
  18: 'WEB_SEARCH',
  19: 'MCP',
  23: 'SEARCH_SYMBOLS',
  24: 'BACKGROUND_COMPOSER_FOLLOWUP',
  25: 'KNOWLEDGE_BASE',
  26: 'FETCH_PULL_REQUEST',
  27: 'DEEP_SEARCH',
  28: 'CREATE_DIAGRAM',
  29: 'FIX_LINTS',
  30: 'READ_LINTS',
  31: 'GO_TO_DEFINITION',
  32: 'TASK',
  33: 'AWAIT_TASK',
  34: 'TODO_READ',
  35: 'TODO_WRITE',
  38: 'EDIT_FILE_V2',
  39: 'LIST_DIR_V2',
  40: 'READ_FILE_V2',
  41: 'RIPGREP_RAW_SEARCH',
  42: 'GLOB_FILE_SEARCH',
  43: 'CREATE_PLAN',
  44: 'LIST_MCP_RESOURCES',
  45: 'READ_MCP_RESOURCE',
  46: 'READ_PROJECT',
  47: 'UPDATE_PROJECT',
  48: 'TASK_V2',
  49: 'CALL_MCP_TOOL',
  50: 'APPLY_AGENT_DIFF',
  51: 'ASK_QUESTION',
  52: 'SWITCH_MODE',
  53: 'GENERATE_IMAGE',
  54: 'COMPUTER_USE',
  55: 'WRITE_SHELL_STDIN',
  56: 'RECORD_SCREEN',
  57: 'WEB_FETCH',
  58: 'REPORT_BUGFIX_RESULTS',
  59: 'AI_ATTRIBUTION',
  60: 'MCP_AUTH',
  61: 'REFLECT',
  62: 'AWAIT',
  63: 'GET_MCP_TOOLS',
  65: 'SEND_TO_USER',
  66: 'CONNECT_SCM',
});

/**
 * Display names, keyed by the snake_case `name` Cursor writes on
 * `toolFormerData`. Chosen to match the families the other adapters already
 * emit (`Shell`, `Read`, `Edit`, `Grep`, `Glob`), so `toolFamily()` in
 * signals.js groups a Cursor run the way it groups a Claude Code one. Unknown
 * names pass through verbatim — a family nobody mapped is still a family.
 */
const DISPLAY = Object.freeze({
  __proto__: null,
  run_terminal_command_v2: 'Shell',
  read_file_v2: 'Read',
  read_file: 'Read',
  edit_file_v2: 'Edit',
  edit_file: 'Edit',
  ripgrep_raw_search: 'Grep',
  ripgrep_search: 'Grep',
  glob_file_search: 'Glob',
  file_search: 'Glob',
  list_dir_v2: 'List',
  list_dir: 'List',
  delete_file: 'Delete',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  get_mcp_tools: 'MCPTools',
  task: 'Task',
  task_v2: 'Task',
  todo_write: 'Todo',
  todo_read: 'Todo',
});

/**
 * The family name for a tool call. `name` first, `tool` as the fallback (the
 * enum member, lower-cased), exactly Cursor's own order.
 *
 * `call_mcp_tool` reports the MCP tool's OWN name, read from the parsed
 * params — `name` is the spelling the IDE's tool-call protobuf uses for it;
 * the two alternates are tolerated because no `call_mcp_tool` record has been
 * captured yet (spec §16). When none is present the family is `MCP`.
 */
export function toolFamily(tf, params) {
  const name = typeof tf?.name === 'string' && tf.name ? tf.name : '';
  if (name === 'call_mcp_tool') {
    const own = firstString(params?.name, params?.toolName, params?.tool);
    return own ?? 'MCP';
  }
  if (name) return DISPLAY[name] ?? name;
  const member = Number.isInteger(tf?.tool) ? CLIENT_SIDE_TOOL_V2[tf.tool] : undefined;
  if (member && member !== 'UNSPECIFIED') {
    const snake = member.toLowerCase();
    return DISPLAY[snake] ?? snake;
  }
  return 'tool';
}

/**
 * The `· <hint>` half of a tool label: the command, the file's basename, the
 * pattern. Per observed `params` shape (spec Ground truth); anything else has
 * no hint and the label is the family alone.
 */
export function toolHint(tf, params) {
  if (!params || typeof params !== 'object') return undefined;
  switch (tf?.name) {
    case 'run_terminal_command_v2':
      return firstString(params.commandDescription, params.command);
    case 'read_file_v2':
    case 'read_file':
      return baseName(params.targetFile ?? params.path);
    case 'edit_file_v2':
    case 'edit_file':
    case 'delete_file':
      return baseName(params.relativeWorkspacePath ?? params.targetFile ?? params.path);
    case 'ripgrep_raw_search':
    case 'ripgrep_search':
      return firstString(params.pattern);
    case 'glob_file_search':
    case 'file_search':
      return firstString(params.globPattern, params.pattern, params.query);
    case 'get_mcp_tools':
      return firstString(params.server, params.pattern);
    case 'list_dir_v2':
    case 'list_dir':
      return baseName(params.targetDirectory ?? params.path);
    case 'web_search':
      return firstString(params.query, params.searchTerm);
    case 'web_fetch':
      return hostOf(params.url);
    case 'call_mcp_tool':
      return firstString(params.server, params.serverName);
    default:
      return undefined;
  }
}

/**
 * Which IDE tool params name a file the run actually touched — the read and
 * the edit, by the param each spells its path in. `edit_file_v2` says
 * `relativeWorkspacePath` and writes an ABSOLUTE path in it (observed). Search
 * roots and command strings are deliberately not paths here: precision over
 * recall, a wrong file on a node costs more than a missing one.
 */
export function toolFiles(tf, params) {
  if (!params || typeof params !== 'object') return [];
  let p;
  switch (tf?.name) {
    case 'read_file_v2':
    case 'read_file':
      p = params.targetFile ?? params.path;
      break;
    case 'edit_file_v2':
    case 'edit_file':
    case 'delete_file':
      p = params.relativeWorkspacePath ?? params.targetFile ?? params.path;
      break;
    default:
      return [];
  }
  return isPath(p) ? [p] : [];
}

export function isPath(p) {
  return typeof p === 'string' && Boolean(p.trim()) && p.length <= 512 && !/[\r\n]/.test(p);
}

function firstString(...vs) {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
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
