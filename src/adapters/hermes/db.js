import { openDb as openSqlite, unavailableReason as sqliteUnavailable } from '../../sqlite.js';

/**
 * The Hermes adapter's database seam.
 *
 * Everything generic about reading a vendor SQLite database — the Node ≥22.13
 * gate, the readonly open, the crash-recovery copy, the schema-tolerance
 * helpers — moved to `src/sqlite.js` when the opencode adapter arrived (the
 * second SQLite adapter is the moment CLAUDE.md's shared-code rule was
 * written for). Behaviour is unchanged: `tests/hermes.test.js` passes
 * unmodified across the extraction, which is the extraction's own test.
 *
 * What is left here is Hermes-specific: the display name in the unavailable
 * warning, the scratch-dir prefix, and `schemaVersion` (a Hermes table).
 */

export { loadSqlite, resetForTests, tableColumns, selectList, isoSeconds as iso } from '../../sqlite.js';

/** The Node ≥22.13 gate's warning, named for Hermes. */
export function unavailableReason() {
  return sqliteUnavailable('Hermes');
}

/**
 * Open a Hermes state.db strictly readonly — see `src/sqlite.js` for the
 * three-road policy. The scratch prefix keeps a Hermes crash-recovery copy
 * identifiable in `$TMPDIR` next to any other adapter's.
 */
export function openDb(path) {
  return openSqlite(path, { scratchPrefix: 'rungraph-hermes-' });
}

/** `schema_version.version`, or null where the table is absent. */
export function schemaVersion(db) {
  try {
    const row = db.prepare('SELECT version FROM schema_version').get();
    return Number.isFinite(row?.version) ? row.version : null;
  } catch {
    return null;
  }
}
