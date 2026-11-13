/**
 * Tests for the database layer: connection, PRAGMAs, and migrations.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';

describe('openDatabase', () => {
  let db: ReturnType<typeof openDatabase>;

  afterEach(() => {
    if (db) closeDatabase(db);
  });

  it('should create an in-memory database', () => {
    db = openDatabase(':memory:');
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should apply WAL journal mode (falls back to memory for in-memory DBs)', () => {
    db = openDatabase(':memory:');
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    // In-memory databases cannot use WAL — SQLite silently falls back to 'memory'
    expect(['wal', 'memory']).toContain(result[0]?.journal_mode);
  });

  it('should enable foreign keys', () => {
    db = openDatabase(':memory:');
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0]?.foreign_keys).toBe(1);
  });

  it('should run initial migration and create all tables', () => {
    db = openDatabase(':memory:');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('repositories');
    expect(tableNames).toContain('snapshots');
    expect(tableNames).toContain('entities');
    expect(tableNames).toContain('evidence');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('knowledge');
    expect(tableNames).toContain('conventions');
    expect(tableNames).toContain('summaries');
    expect(tableNames).toContain('session_cache');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('knowledge_entities');
    expect(tableNames).toContain('knowledge_evidence');
    expect(tableNames).toContain('convention_evidence');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('work_sessions');
    expect(tableNames).toContain('work_session_checkpoints');
  });

  it('should create FTS5 virtual tables', () => {
    db = openDatabase(':memory:');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('entities_fts');
    expect(tableNames).toContain('knowledge_fts');
    expect(tableNames).toContain('evidence_fts');
  });

  it('should record migration version', () => {
    db = openDatabase(':memory:');

    const version = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number };

    expect(version.v).toBe(2);
  });

  it('should be idempotent (running twice should not fail)', () => {
    db = openDatabase(':memory:');
    // openDatabase runs migrations internally — the second call to runMigrations
    // should skip already-applied migrations
    expect(() => openDatabase(':memory:')).not.toThrow();
  });
});
