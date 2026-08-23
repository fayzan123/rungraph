#!/usr/bin/env node
/**
 * cursor-probe — re-derive the Cursor adapter's ground truth from the stores
 * on THIS machine. Read-only, always.
 *
 * Cursor is closed-source and auto-updates; its format drifted between two
 * probes three days apart (a new `composerHeaders` table, new fields, a
 * nine-value tool-status vocabulary). When `ext.cursor.unknown*` or the
 * coverage badge starts naming drift, this is how it gets diagnosed: run it,
 * diff its output against the "Ground truth" section of
 * `docs/superpowers/specs/2026-08-20-cursor-adapter-design.md`, and fix the
 * adapter from the measurement rather than from memory.
 *
 *   node scripts/cursor-probe.mjs            # both surfaces, default paths
 *   node scripts/cursor-probe.mjs ide        # the IDE store only
 *   node scripts/cursor-probe.mjs cli        # cursor-agent chats only
 *   node scripts/cursor-probe.mjs --json     # machine-readable
 *
 * Honours the same overrides as the adapter: RUNGRAPH_CURSOR_GLOBAL_STORAGE,
 * RUNGRAPH_CURSOR_CLI_HOME, CURSOR_DATA_DIR. Opens every database with
 * `{ readOnly: true }` through src/sqlite.js and writes nothing, anywhere.
 * Content is summarised by shape and length — prompts, outputs and keys are
 * never printed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRootDirs } from '../src/scanner.js';
import { loadSqlite, openDb } from '../src/sqlite.js';
import { statOrNull } from '../src/util.js';
import { decodeValue } from '../src/adapters/cursor/ide/read.js';
import { isSubagentComposer, isValidComposer, headersOf } from '../src/adapters/cursor/ide/parse.js';
import { decodeMessageBlob, readMeta0, rootMessageIds } from '../src/adapters/cursor/cli/read.js';
import { IN_FLIGHT_STATUSES, TERMINAL_STATUSES } from '../src/adapters/cursor/db.js';
import { CLIENT_SIDE_TOOL_V2 } from '../src/adapters/cursor/tools.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const only = args.find((a) => a === 'ide' || a === 'cli');

if (!(await loadSqlite())) {
  console.error(`cursor-probe needs Node 22.13+ (node:sqlite); this is ${process.version}`);
  process.exit(2);
}

const report = { probedAt: new Date().toISOString(), node: process.version, ide: null, cli: null };
const roots = defaultRootDirs().cursor;
for (const root of roots) {
  if ((!only || only === 'ide') && (await statOrNull(join(root, 'state.vscdb')))) report.ide = await probeIde(join(root, 'state.vscdb'));
  if ((!only || only === 'cli') && (await statOrNull(join(root, 'chats')))?.isDirectory()) report.cli = await probeCli(join(root, 'chats'));
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  printIde(report.ide);
  printCli(report.cli);
}

// ---------------------------------------------------------------- IDE

async function probeIde(path) {
  const { db, close } = await openDb(path);
  try {
    const q = (sql, ...a) => db.prepare(sql).all(...a);
    const out = { path, journalMode: q('PRAGMA journal_mode')[0]?.journal_mode, tables: q("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name) };
    const prefixes = {};
    for (const { key } of q('SELECT key FROM cursorDiskKV')) {
      const p = String(key).split(':')[0];
      prefixes[p] = (prefixes[p] ?? 0) + 1;
    }
    out.keyPrefixes = prefixes;
    if (out.tables.includes('composerHeaders')) {
      out.composerHeaders = { rows: q('SELECT COUNT(*) AS c FROM composerHeaders')[0].c, columns: q('PRAGMA table_info(composerHeaders)').map((c) => c.name) };
    }

    const rows = q("SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'");
    const versions = {};
    const statuses = {};
    const presence = {};
    const misses = {};
    const modern = [];
    const WATCH = ['name', 'subComposerIds', 'subagentInfo', 'createdFromBackgroundAgent', 'isDraft', 'isEphemeral', 'isBestOfNSubcomposer', 'trackedGitRepos', 'workspaceIdentifier', 'modelConfig', 'contextTokensUsed', 'blobEncryptionKey', 'speculativeSummarizationEncryptionKey', 'unifiedMode', 'forceMode', 'isAgentic', 'agentBackend', 'totalLinesAdded', 'filesChangedCount', 'isArchived', 'todos', 'conversationCheckpointLastUpdatedAt', 'lastUpdatedAt', 'createdAt', 'status'];
    for (const r of rows) {
      const { json: c, miss } = decodeValue(r.value);
      if (!c) {
        misses[miss] = (misses[miss] ?? 0) + 1;
        continue;
      }
      versions[c._v] = (versions[c._v] ?? 0) + 1;
      statuses[c.status] = (statuses[c.status] ?? 0) + 1;
      for (const f of WATCH) if (c[f] !== undefined) presence[f] = (presence[f] ?? 0) + 1;
      if (isValidComposer(c) && c._v >= 9 && headersOf(c).length > 0) {
        modern.push({
          composerId: c.composerId,
          _v: c._v,
          headers: headersOf(c).length,
          status: c.status,
          subagent: isSubagentComposer(c),
          subComposerIds: Array.isArray(c.subComposerIds) ? c.subComposerIds.length : null,
          hasLastUpdatedAt: Number.isFinite(c.lastUpdatedAt),
          headerFields: Object.keys(headersOf(c)[0] ?? {}),
          headersWithCreatedAt: headersOf(c).filter((h) => typeof h.createdAt === 'string').length,
          project: c.trackedGitRepos?.[0]?.repoPath ?? c.workspaceIdentifier?.uri?.fsPath ?? null,
        });
      }
    }
    out.composers = { total: rows.length, misses, versions, statuses, fieldPresence: presence, modern };

    // Bubble audit over the modern composers.
    const toolStatus = {};
    const adStatus = {};
    const tools = {};
    const groupingShapes = {};
    let nulls = 0;
    let orphans = 0;
    let missing = 0;
    let tokSeen = 0;
    let tokNonZero = 0;
    let skipFlagged = 0;
    const unknownStatuses = new Set();
    for (const m of modern) {
      const c = rows.map((r) => decodeValue(r.value).json).find((x) => x?.composerId === m.composerId);
      const headerIds = new Set(headersOf(c).map((h) => h.bubbleId));
      for (const h of headersOf(c)) {
        const k = JSON.stringify(Object.keys(h.grouping ?? {}).sort());
        groupingShapes[k] = (groupingShapes[k] ?? 0) + 1;
      }
      const brows = q('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?', `bubbleId:${m.composerId}:`, `bubbleId:${m.composerId};`);
      const seen = new Set();
      for (const r of brows) {
        const id = String(r.key).split(':')[2];
        seen.add(id);
        if (!headerIds.has(id)) orphans++;
        const { json: b } = decodeValue(r.value);
        if (!b) {
          if (r.value == null) nulls++;
          continue;
        }
        if (b.isDisplayOnly || b.isEphemeral) skipFlagged++;
        if (b.tokenCount) {
          tokSeen++;
          if (b.tokenCount.inputTokens || b.tokenCount.outputTokens) tokNonZero++;
        }
        const tf = b.toolFormerData;
        if (tf) {
          toolStatus[tf.status] = (toolStatus[tf.status] ?? 0) + 1;
          if (!TERMINAL_STATUSES.has(tf.status) && !IN_FLIGHT_STATUSES.has(tf.status)) unknownStatuses.add(String(tf.status));
          const ad = tf.additionalData?.status;
          adStatus[String(ad)] = (adStatus[String(ad)] ?? 0) + 1;
          const name = tf.name ?? `tool:${tf.tool}`;
          tools[name] = (tools[name] ?? 0) + 1;
          if (Number.isInteger(tf.tool) && !CLIENT_SIDE_TOOL_V2[tf.tool]) unknownStatuses.add(`tool-enum:${tf.tool}`);
        }
      }
      for (const id of headerIds) if (!seen.has(id)) missing++;
    }
    out.bubbles = {
      modernComposers: modern.length,
      nullRows: nulls,
      orphanRows: orphans,
      missingRows: missing,
      skipFlagged,
      tokenCountSeen: tokSeen,
      tokenCountNonZero: tokNonZero,
      toolFormerStatus: toolStatus,
      additionalDataStatus: adStatus,
      tools,
      groupingShapes,
      outsideKnownVocabulary: [...unknownStatuses],
    };
    return out;
  } finally {
    await close();
  }
}

function printIde(ide) {
  if (!ide) {
    console.log('IDE: no state.vscdb found under the configured root');
    return;
  }
  console.log(`IDE  ${ide.path}`);
  console.log(`  journal_mode=${ide.journalMode}  tables=${ide.tables.join(',')}`);
  console.log(`  key prefixes: ${JSON.stringify(ide.keyPrefixes)}`);
  if (ide.composerHeaders) console.log(`  composerHeaders (NOT read by the adapter): ${ide.composerHeaders.rows} rows, columns ${ide.composerHeaders.columns.join(',')}`);
  const c = ide.composers;
  console.log(`  composers: ${c.total} total, misses ${JSON.stringify(c.misses)}, _v ${JSON.stringify(c.versions)}, status ${JSON.stringify(c.statuses)}`);
  console.log(`  field presence: ${JSON.stringify(c.fieldPresence)}`);
  console.log(`  modern (valid, _v>=9, >0 headers): ${c.modern.length}`);
  for (const m of c.modern) console.log(`    ${m.composerId.slice(0, 8)} _v=${m._v} headers=${m.headers} status=${m.status} subagent=${m.subagent} lastUpdatedAt=${m.hasLastUpdatedAt} headerCreatedAt=${m.headersWithCreatedAt}/${m.headers} project=${m.project}`);
  const b = ide.bubbles;
  console.log(`  bubbles: null=${b.nullRows} orphan=${b.orphanRows} missing=${b.missingRows} skipFlagged=${b.skipFlagged} tokenCount nonzero=${b.tokenCountNonZero}/${b.tokenCountSeen}`);
  console.log(`  toolFormerData.status: ${JSON.stringify(b.toolFormerStatus)}`);
  console.log(`  additionalData.status: ${JSON.stringify(b.additionalDataStatus)}`);
  console.log(`  tools: ${JSON.stringify(b.tools)}`);
  console.log(`  header grouping shapes: ${Object.keys(b.groupingShapes).length}`);
  if (b.outsideKnownVocabulary.length) console.log(`  !! OUTSIDE THE ADAPTER'S VOCABULARY: ${b.outsideKnownVocabulary.join(', ')}`);
  else console.log('  every tool status and tool id is inside the adapter vocabulary');
}

// ---------------------------------------------------------------- CLI

async function probeCli(chats) {
  const out = { path: chats, chats: [] };
  for (const ws of await readdir(chats, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    for (const a of await readdir(join(chats, ws.name), { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      const dir = join(chats, ws.name, a.name);
      const entry = { workspaceHash: ws.name, agentId: a.name, files: await readdir(dir) };
      try {
        entry.meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
        delete entry.meta.cwd; // a path is content
        entry.metaCwdPresent = typeof JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).cwd === 'string';
      } catch {
        entry.meta = null;
      }
      if (!(await statOrNull(join(dir, 'store.db')))) {
        out.chats.push(entry);
        continue;
      }
      const { db, close } = await openDb(join(dir, 'store.db'));
      try {
        const q = (sql, ...a) => db.prepare(sql).all(...a);
        entry.journalMode = q('PRAGMA journal_mode')[0]?.journal_mode;
        entry.schema = q("SELECT sql FROM sqlite_master WHERE type='table'").map((r) => r.sql);
        entry.metaKeys = q('SELECT key FROM meta').map((r) => r.key);
        const m0 = readMeta0(db);
        entry.meta0 = m0 ? { keys: Object.keys(m0), hasRoot: typeof m0.latestRootBlobId === 'string', name: m0.name === 'New Agent' ? 'New Agent' : `<${String(m0.name ?? '').length} chars>`, mode: m0.mode, isRunEverything: m0.isRunEverything } : null;
        const blobs = q('SELECT id, data FROM blobs');
        entry.blobs = blobs.length;
        const root = m0?.latestRootBlobId ? blobs.find((b) => b.id === m0.latestRootBlobId) : null;
        const ids = root ? rootMessageIds(Buffer.from(root.data)) : null;
        entry.rootFieldOneIds = ids?.length ?? null;
        const roles = [];
        const blocks = {};
        const outcomes = {};
        let injected = 0;
        let userQuery = 0;
        for (const id of ids ?? []) {
          const b = blobs.find((x) => x.id === id);
          const { json: m } = b ? decodeMessageBlob(Buffer.from(b.data)) : {};
          if (!m) {
            roles.push('MISSING');
            continue;
          }
          roles.push(m.role);
          if (m.role === 'user' && (typeof m.content === 'string' || m.providerOptions?.cursor?.requestContextCompleteness)) injected++;
          if (m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => /<user_query>/.test(c?.text ?? ''))) userQuery++;
          for (const c of Array.isArray(m.content) ? m.content : []) blocks[c?.type] = (blocks[c?.type] ?? 0) + 1;
          const output = m.providerOptions?.cursor?.highLevelToolCallResult?.output;
          if (output) {
            const kind = Object.keys(output)[0];
            const k = `${kind}/isError=${m.providerOptions.cursor.highLevelToolCallResult.isError}`;
            outcomes[k] = (outcomes[k] ?? 0) + 1;
          }
        }
        entry.roles = roles;
        entry.blockTypes = blocks;
        entry.outcomeKinds = outcomes;
        entry.injectedContextMessages = injected;
        entry.userQueryMessages = userQuery;
      } finally {
        await close();
      }
      out.chats.push(entry);
    }
  }
  return out;
}

function printCli(cli) {
  if (!cli) {
    console.log('CLI: no chats/ directory found under the configured root');
    return;
  }
  console.log(`CLI  ${cli.path}`);
  for (const c of cli.chats) {
    console.log(`  ${c.workspaceHash.slice(0, 8)}/${c.agentId.slice(0, 8)}  files=${c.files.join(',')}  meta.json=${c.meta ? `schemaVersion ${c.meta.schemaVersion}, hasConversation ${c.meta.hasConversation}, cwd ${c.metaCwdPresent}` : 'absent'}`);
    if (c.blobs === undefined) continue;
    console.log(`    journal=${c.journalMode} meta keys=${c.metaKeys.join(',')} meta0=${JSON.stringify(c.meta0)}`);
    console.log(`    blobs=${c.blobs} root field-1 ids=${c.rootFieldOneIds} roles=${c.roles.join(',')}`);
    console.log(`    blocks=${JSON.stringify(c.blockTypes)} outcomes=${JSON.stringify(c.outcomeKinds)} injected=${c.injectedContextMessages} user_query=${c.userQueryMessages}`);
  }
}
