import { spawn } from 'node:child_process';
import { shellQuote } from './util.js';

/**
 * Terminal launcher — the "open in terminal" tier of resume-from-dashboard.
 * Takes (argv, cwd) and knows nothing about vendors or runs; the adapters
 * decide WHAT to run, this module only decides HOW to open a window running it.
 *
 * macOS is the only launch platform in v1. Terminal.app is the default target
 * (always present, always scriptable); `RUNGRAPH_TERMINAL=iTerm` selects a
 * dedicated iTerm2 branch, following the repo's env-override pattern
 * (RUNGRAPH_CLAUDE_PROJECTS). The user's daily terminal may not be scriptable
 * as a launch target at all — VS Code's integrated terminal is not — so a
 * universal default plus one override beats auto-detection. Any other value
 * falls back to Terminal.app with a warning on stderr. Everywhere else the
 * caller gets `false` immediately and degrades to the copy tier, which works
 * by construction.
 */

/**
 * Pure planning half, split out so the escaping and branching are unit-tested
 * without ever opening a real window (the real window is a manual test, like
 * the rest of the rendered UI).
 *
 * @param {string[]} argv Command to run in the new window.
 * @param {string|null} cwd Directory to run it in; null = wherever the
 *   terminal opens by default (the user's $HOME).
 * @param {{ platform?: string, terminal?: string }} [env]
 * @returns {{ command: string[], warnings: string[] }|null} The osascript
 *   invocation to spawn, or null when this platform cannot launch.
 */
export function buildLaunchPlan(argv, cwd, env = {}) {
  const platform = env.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const shellCommand = [
    ...(cwd ? [`cd ${shellQuote(cwd)}`] : []),
    argv.map(shellQuote).join(' '),
  ].join(' && ');

  const warnings = [];
  const requested = env.terminal ?? process.env.RUNGRAPH_TERMINAL ?? '';
  let app = 'Terminal';
  if (/^iterm2?(\.app)?$/i.test(requested)) app = 'iTerm';
  else if (requested && !/^terminal(\.app)?$/i.test(requested)) {
    warnings.push(`unknown RUNGRAPH_TERMINAL "${requested}" — launching Terminal.app instead`);
  }

  const lines =
    app === 'iTerm'
      ? [
          'tell application "iTerm"',
          'create window with default profile',
          'tell current session of current window',
          `write text ${appleScriptString(shellCommand)}`,
          'end tell',
          'activate',
          'end tell',
        ]
      : [
          'tell application "Terminal"',
          `do script ${appleScriptString(shellCommand)}`,
          'activate',
          'end tell',
        ];

  return { command: ['osascript', ...lines.flatMap((l) => ['-e', l])], warnings };
}

/** An AppleScript double-quoted string literal. */
function appleScriptString(s) {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Open a new terminal window running `argv` in `cwd`. Resolves true only when
 * osascript exited 0 — a denied Automation permission or a missing app
 * resolves false, so the caller can degrade to the copy tier instead of
 * reporting a launch that never happened. Never throws.
 *
 * @param {string[]} argv
 * @param {string|null} cwd
 * @returns {Promise<boolean>}
 */
export function launchTerminal(argv, cwd) {
  const plan = buildLaunchPlan(argv, cwd);
  if (!plan) return Promise.resolve(false);
  for (const w of plan.warnings) process.stderr.write(`rungraph: ${w}\n`);
  const [cmd, ...args] = plan.command;
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
