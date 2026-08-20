import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { statOrNull } from './util.js';

const requireBuiltin = createRequire(import.meta.url);

/**
 * rungraph's ONLY `node:sqlite` touchpoint — the sixth entry in CLAUDE.md's
 * "shared code, one implementation" list.
 *
 * Everything about how rungraph reads a vendor's database — the graceful
 * degrade on old Nodes, the readonly open, the crash-recovery copy, the
 * schema-tolerance helpers — lives here so every SQLite adapter's detect and
 * parse can treat the DB as "rows in". Extracted from the Hermes adapter when
 * the opencode adapter arrived: a second copy of the Node ≥22.13 gate and the
 * recovery policy could disagree with the first, which is the exact failure
 * the shared-code rule exists to prevent.
 *
 * VENDOR NEUTRALITY: this file names no adapter and knows no schema. Every
 * column list, every query and every table name stays in its adapter.
 *
 * Zero runtime dependencies is load-bearing for `npx rungraph`, which is why
 * this is `node:sqlite` (built in since 22.5, unflagged since 22.13) and not
 * better-sqlite3, a sqlite3-CLI subprocess, or a hand-rolled B-tree walker.
 */

let sqliteModule; // cached import result: { DatabaseSync } | null (unavailable)
let sqliteProbed = false;
const warnedSubjects = new Set();

/**
 * `node:sqlite`, or null where this Node cannot import it (< 22.13 unflagged;
 * < 22.5 at all). Unavailability is detected by the import itself throwing —
 * mechanism over version-sniffing: wherever the module imports, the adapters
 * work.
 */
export async function loadSqlite() {
  if (sqliteProbed) return sqliteModule;
  sqliteProbed = true;
  try {
    // require rather than a literal dynamic import: the module is
    // CJS-compatible, the throw-on-missing degrade is identical, and require
    // survives import rewriting (vite-node mangles `import('node:sqlite')`
    // into a file lookup, which would disable every SQLite adapter under the
    // test runner on a Node that has SQLite).
    sqliteModule = requireBuiltin('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/**
 * One stderr warning per process PER SUBJECT when an agent's runs are being
 * skipped for lack of `node:sqlite`. Per subject, not per process: a machine
 * with both Hermes and opencode installed is missing both, and collapsing
 * them into one line would tell the user only half of what is unavailable.
 *
 * The same fact reaches agents structurally, through the scan index's
 * `warnings` array — stderr alone would be invisible to `list --json`
 * consumers.
 *
 * @param {string} subject  Display name of the agent whose runs are skipped.
 */
export function unavailableReason(subject) {
  const reason = `${subject} runs need Node 22.13+ (node:sqlite); this Node is ${process.version}`;
  if (!warnedSubjects.has(subject)) {
    warnedSubjects.add(subject);
    process.stderr.write(`rungraph: ${reason}\n`);
  }
  return reason;
}

/** Test hook: reset the module-level probe/warn state. */
export function resetForTests() {
  sqliteProbed = false;
  sqliteModule = undefined;
  warnedSubjects.clear();
}

/**
 * Open a vendor's database strictly readonly.
 *
 * rungraph never writes to a vendor's files, never checkpoints, never creates
 * anything in their data directory. Three roads, in order:
 *
 * 1. `new DatabaseSync(path, { readOnly: true })` — reads the LIVE WAL-mode
 *    DB up to the second (verified against writes landing seconds earlier,
 *    for both Hermes and opencode).
 * 2. One retry on a busy/locked error — the writer may be mid-checkpoint.
 * 3. The crash-recovery copy: after a crash mid-write a WAL database needs
 *    recovery, and SQLite refuses recovery on a readonly connection
 *    (SQLITE_READONLY_RECOVERY). "It crashed, what was it doing?" is
 *    rungraph's marquee moment, so the db + `-wal` + `-shm` are copied into
 *    rungraph's OWN temp dir, the copy is opened writable so recovery runs
 *    there, and the copy is discarded after the parse. The vendor's files are
 *    never touched.
 *
 * Any other failure throws — the caller surfaces it as a per-run error (or a
 * scan warning), never a crash.
 *
 * @param {string} path
 * @param {{ scratchPrefix?: string }} [opts]  temp-dir prefix for road 3.
 * @returns {Promise<{ db: import('node:sqlite').DatabaseSync, close: () => Promise<void> }>}
 */
export async function openDb(path, opts = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite) throw new Error(unavailableReason('SQLite-backed'));

  let firstErr;
  try {
    return plainHandle(openAndProbe(sqlite, path, { readOnly: true }));
  } catch (err) {
    firstErr = err;
  }
  if (isBusy(firstErr)) {
    await sleep(30);
    try {
      return plainHandle(openAndProbe(sqlite, path, { readOnly: true }));
    } catch (err) {
      firstErr = err;
    }
  }
  // Recovery-class only: a genuinely corrupt, missing, or unreadable DB must
  // fail loudly here — with ITS error — not survive one extra hop through a
  // scratch copy. The access() probe keeps a plain permission problem (which
  // also spells "unable to open database file") off the recovery road.
  if (isRecoveryClass(firstErr) && (await statOrNull(path)) && (await readable(path))) {
    return recoveryCopyHandle(sqlite, path, firstErr, opts.scratchPrefix ?? 'rungraph-sqlite-');
  }
  throw firstErr;
}

/**
 * Open AND touch the database. The DatabaseSync constructor defers all file
 * access to the first prepared statement, so without this probe a corrupt or
 * recovery-needing DB "opens" fine and only fails later, inside a schema read
 * whose catch would mis-report it as "not this vendor's database" — and the
 * crash-recovery classification below would never see the real error.
 */
function openAndProbe(sqlite, path, opts) {
  const db = new sqlite.DatabaseSync(path, opts);
  try {
    db.prepare('PRAGMA schema_version').get();
  } catch (err) {
    try {
      db.close();
    } catch {
      /* keep the probe error */
    }
    throw err;
  }
  return db;
}

function plainHandle(db) {
  return {
    db,
    close: async () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function recoveryCopyHandle(sqlite, path, originalErr, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const copy = join(dir, basename(path));
  // Copy failures surface the ORIGINAL open error (the honest diagnosis) and
  // never leak the scratch dir; a copy that opens but proves corrupt surfaces
  // its own error — that one is the truer diagnosis.
  try {
    await copyFile(path, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (await statOrNull(path + suffix)) await copyFile(path + suffix, copy + suffix);
    }
  } catch {
    await rm(dir, { recursive: true, force: true });
    throw originalErr;
  }
  let db;
  try {
    // Writable on purpose: this connection exists so WAL recovery can run —
    // against rungraph's own scratch copy, never against the vendor's dir.
    db = openAndProbe(sqlite, copy, {});
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    db,
    close: async () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isBusy(err) {
  return /busy|locked/i.test(String(err?.message ?? err));
}

function isRecoveryClass(err) {
  // SQLITE_READONLY_RECOVERY surfaces as a readonly/recovery/cantopen-shaped
  // message depending on the VFS path that hit it; all three spell "the DB is
  // fine but a readonly connection cannot bring it up".
  return /readonly|recovery|unable to open/i.test(String(err?.message ?? err));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------- schema shape

/**
 * The column names a table actually has, read once per open. Vendor schemas
 * evolve (Hermes is on v26; opencode's `session` gained ten columns across
 * 1.15→1.18), and missing expected columns (older) and unknown extra ones
 * (newer) must degrade field-by-field, never blank-screen.
 *
 * @returns {Set<string>}
 */
export function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

/**
 * A SELECT column list over `wanted` restricted to columns that exist —
 * missing ones come back as literal NULLs under the same name, so row readers
 * stay one shape.
 */
export function selectList(have, wanted) {
  return wanted.map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(', ');
}

/** Epoch-SECONDS → ISO 8601, or undefined. (Hermes's timestamp unit.) */
export function isoSeconds(sec) {
  if (!Number.isFinite(sec)) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Epoch-MILLISECONDS → ISO 8601, or undefined. (opencode's timestamp unit.) */
export function isoMillis(ms) {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
