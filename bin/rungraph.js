#!/usr/bin/env node
import { main } from '../src/cli.js';

// `rungraph list --json | head -1` closes stdout early — exit quietly.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

process.exitCode = await main(process.argv.slice(2));
