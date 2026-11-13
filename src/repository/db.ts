/**
 * SQLite database connection, configuration, and migration runner.
 *
 * This is the lowest layer of persistence. It owns the database file,
 * applies PRAGMAs for performance and safety, and runs SQL migrations.
 *
 * No other module should import `better-sqlite3` directly — all access
 * goes through this module or the repository classes that depend on it.
 *
 * Used by: repository/*.ts modules.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQLITE_PRAGMAS } from '../shared/constants.js';
import { DatabaseError } from '../shared/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved path to the migrations/ directory at project root. */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Opens (or creates) a SQLite database, applies PRAGMAs, and runs
 * any pending migrations.
 *
 * @param dbPath - Absolute path to the .db file. Use ':memory:' for tests.
 * @returns A configured, migrated better-sqlite3 Database instance.
 * @throws DatabaseError if migration fails.
 */
export function openDatabase(dbPath: string): DatabaseType {
  ensureDirectoryExists(dbPath);

  const db = new Database(dbPath);

  applyPragmas(db);
  runMigrations(db);

  return db;
}

/**
 * Creates the directory for the database file if it doesn't exist.
 * Skipped for in-memory databases.
 */
function ensureDirectoryExists(dbPath: string): void {
  if (dbPath === ':memory:') return;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Applies SQLite PRAGMAs for performance and safety.
 *
 * WAL mode allows concurrent reads during writes.
 * foreign_keys enforces referential integrity.
 * busy_timeout prevents immediate SQLITE_BUSY errors.
 */
function applyPragmas(db: DatabaseType): void {
  for (const [pragma, value] of Object.entries(SQLITE_PRAGMAS)) {
    db.pragma(`${pragma} = ${value}`);
  }
}

/**
 * Runs all pending SQL migrations in order.
 *
 * Migrations are numbered files (001_name.sql, 002_name.sql) in the
 * migrations/ directory. Each runs inside a transaction. Already-applied
 * migrations (tracked in schema_version) are skipped.
 *
 * @throws DatabaseError if any migration fails.
 */
function runMigrations(db: DatabaseType): void {
  // schema_version may not exist yet — create it if needed
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      description TEXT
    );
  `);

  const appliedRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) as max_version FROM schema_version')
    .get() as { max_version: number };
  const currentVersion = appliedRow.max_version;

  const migrationFiles = getMigrationFiles();

  for (const file of migrationFiles) {
    const version = extractVersion(file);
    if (version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    try {
      db.exec('BEGIN TRANSACTION');
      db.exec(sql);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new DatabaseError(`Migration ${file} failed: ${message}`);
    }
  }
}

/**
 * Reads migration files from disk, sorted by version number.
 * Only files matching the pattern NNN_name.sql are included.
 */
function getMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

/** Extracts the numeric version from a migration filename like "001_initial.sql". */
function extractVersion(filename: string): number {
  const match = filename.match(/^(\d{3})/);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}

/**
 * Closes the database connection gracefully.
 * Should be called during server shutdown.
 */
export function closeDatabase(db: DatabaseType): void {
  db.close();
}
