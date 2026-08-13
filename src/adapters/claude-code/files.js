/**
 * File attribution: which tool inputs name a file the run actually touched.
 * The tool-shape knowledge is Claude-Code-specific and stops here — what
 * leaves this module is a plain array of path strings.
 */

/**
 * The keys Claude Code uses for "the file this call touches". Every
 * path-bearing built-in — Read, Edit, Write, MultiEdit, NotebookEdit — spells
 * it one of these two, so the *key* is the rule rather than a list of tool
 * names: MCP servers and custom tools that follow the convention are picked up
 * for free, and a new built-in needs no change here.
 *
 * Deliberately absent: Grep/Glob `path` (a search root — a directory, not a
 * file that was touched) and Bash `command` (recovering paths out of shell is
 * guesswork). Precision over recall — a wrong file on a node costs more than a
 * missing one, because the moment the files lane lies the user stops using it.
 */
const PATH_KEYS = ['file_path', 'notebook_path'];

/** Longer than any real path; past this it is a payload that landed in the wrong key. */
const MAX_PATH_LEN = 512;

/**
 * Paths one tool call touched. Never throws — `input` comes straight off a
 * transcript and is whatever the provider wrote, including nothing at all.
 *
 * `toolName` is not branched on today (see PATH_KEYS), but stays in the
 * signature because deciding per tool name is exactly this module's job: a
 * future tool that names its file differently is a change here, not at the
 * call sites.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string[]}
 */
export function filePathsFromToolInput(toolName, input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  try {
    for (const key of PATH_KEYS) {
      const v = input[key];
      if (typeof v !== 'string') continue;
      // Single-line, non-blank, bounded — anything else is not a path.
      if (!v.trim() || v.length > MAX_PATH_LEN || /[\r\n]/.test(v)) continue;
      if (!out.includes(v)) out.push(v);
    }
  } catch {
    // A hostile getter threw: keep whatever we already read, never blank-screen.
  }
  return out;
}

/**
 * De-duplicating union in FIRST-SEEN order — deterministic for snapshots, and
 * first touch is the order that means something to a reader. Capped so a
 * pathological run cannot bloat the IR with thousands of paths nobody reads.
 *
 * @param {string[]|undefined} existing
 * @param {string[]|undefined} incoming
 * @param {number} [max]
 * @returns {string[]}
 */
export function mergeFiles(existing, incoming, max = 200) {
  const out = [];
  const seen = new Set();
  for (const list of [existing, incoming]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p !== 'string' || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}
