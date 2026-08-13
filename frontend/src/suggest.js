/**
 * Example questions, generated from the run that is actually on screen.
 *
 * "Ask your agent about this run" teaches nobody anything. A question about
 * *their* run — naming the file their Edit kept failing on — teaches the
 * capability by demonstrating it, and the answer proves it worked. This is the
 * whole onboarding strategy: nobody reads a README while looking at a
 * dashboard.
 *
 * Every suggestion must be answerable with the tools that ship (signals, files,
 * node detail). A suggestion that comes back empty is worse than no suggestion,
 * so these are derived from what the IR actually contains, never guessed.
 *
 * Pure: no preact, no DOM, unit-tested alongside focus and viewmath.
 */

import { filesIndex, relPath } from './focus.js';

const MAX = 4;

/** Last path segment — reasons and questions read better with the short name. */
function baseName(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? '');
}

/**
 * A path short enough to sit inside a sentence. Deep spec paths run to 60+
 * characters and turn a question you would actually type into one you would
 * not, so past a limit the file name alone carries it — and `find_nodes`
 * matches on substring, so the short form still resolves.
 */
function shortPath(path, project, max = 34) {
  const rel = relPath(path, project);
  return rel.length <= max ? rel : baseName(rel);
}

/** The tool name out of a descriptive label ("Edit · token.js ×6" → "Edit"). */
function toolOf(label) {
  return String(label ?? '').split(' · ')[0].replace(/ ×\d+$/, '').trim();
}

/**
 * @param {object} ir      the graph on screen
 * @param {string} [project] project root, so paths read the way the user thinks of them
 * @returns {{text: string, from: string}[]} at most 4, most specific first
 */
export function suggestQuestions(ir, project) {
  if (!ir?.nodes?.length) return [];
  const out = [];
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const add = (text, from) => {
    if (out.length < MAX && !out.some((q) => q.text === text)) out.push({ text, from });
  };
  const signal = (kind) => (ir.signals ?? []).find((s) => s.kind === kind);
  const nodesOf = (s) => (s?.nodeIds ?? []).map((id) => byId.get(id)).filter(Boolean);

  // Most specific first: the thing that actually went wrong, named.
  const storm = signal('retry-storm');
  if (storm) {
    const [first] = nodesOf(storm);
    const file = first?.files?.[0];
    const tool = toolOf(first?.label) || 'tool';
    add(
      file
        ? `why did the ${tool} on ${baseName(file)} keep failing in this run?`
        : `why did ${tool} keep failing in this run?`,
      'retry-storm',
    );
  }

  const unresolved = signal('unresolved-error');
  if (unresolved) {
    const tool = toolOf(nodesOf(unresolved)[0]?.label) || 'tool';
    add(`what was the unresolved ${tool} error in this run, and did anything fix it?`, 'unresolved-error');
  }

  const denial = (ir.signals ?? []).find(
    (s) => s.kind === 'intervention' && s.severity === 'high',
  );
  if (denial) {
    add('what did I refuse in this run, and what did the agent do instead?', 'intervention');
  }

  // Subagents are the part of a run people can least see for themselves.
  const agent = ir.nodes.find((n) => n.kind === 'agent' && n.label);
  if (agent) add(`what did the “${agent.label}” agent find?`, 'agent');

  // An outsized step is the other thing people notice and cannot explain.
  const outlier = signal('outlier');
  if (outlier) {
    const [worst] = nodesOf(outlier); // ranked, biggest first
    add(
      worst?.label
        ? `why did “${worst.label}” cost so much more than the rest of this run?`
        : 'which step cost the most in this run, and why?',
      'outlier',
    );
  }

  // The files lane, which is the answer to "why does this code look like this".
  const [topFile] = filesIndex(ir);
  if (topFile) add(`which steps touched ${shortPath(topFile.path, project)} in this run?`, 'files');

  // Always leave with something, even on a clean run with no attribution.
  add('what went wrong in this run?', 'fallback');
  add('summarise what this run actually did, in order', 'fallback');
  return out.slice(0, MAX);
}
