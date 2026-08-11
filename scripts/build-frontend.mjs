import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [join(root, 'frontend/src/main.jsx')],
  bundle: true,
  outfile: join(root, 'dist/app.js'),
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

await mkdir(join(root, 'dist'), { recursive: true });
await cp(join(root, 'frontend/index.html'), join(root, 'dist/index.html'));

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('watching frontend…');
} else {
  await build(options);
}
