#!/usr/bin/env node
// node:sqlite (the Hermes adapter) emits one ExperimentalWarning per process.
// Agents read stderr as the log channel, so that noise is filtered — scoped
// to exactly that warning; everything else still prints via the default
// handlers captured here.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const { runCli } = await import('../src/cli.js');

await runCli();
