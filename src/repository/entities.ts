/**
 * Repository for entity CRUD and queries.
 *
 * Entities represent every identifiable element in the analyzed project:
 * files, classes, functions, routes, tables, etc. This module is the
 * only code that writes to or reads from the `entities` table.
 *
 * Used by: Application Services (sync, search, context, graph, impact).
 */

import type { Database } from 'better-sqlite3';

import type { EntityRecord, EntityType, EntityScope, Language } from '../shared/types.js';
import { generateId } from '../shared/utils.js';

export interface CreateEntityInput {
  repository_id: string;
  entity_type: EntityType;
  scope: EntityScope;
  qualified_name: string;
  display_name: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  language?: Language;
  signature?: string;
  metadata?: Record<string, unknown>;
  snapshot_id: string;
}

/**
 * Inserts a new entity. If one with the same qualified_name already exists
 * in this repository, it updates the existing record instead (upsert).
 *
 * @returns The entity ID (new or existing).
 */
export function upsertEntity(db: Database, input: CreateEntityInput): string {
  const id = generateId('e');
  const metadataJson = JSON.stringify(input.metadata ?? {});

  const stmt = db.prepare(`
    INSERT INTO entities (
      id, repository_id, entity_type, scope, qualified_name, display_name,
      path, line_start, line_end, language, signature, metadata_json, snapshot_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, qualified_name) DO UPDATE SET
      entity_type = excluded.entity_type,
      scope = excluded.scope,
      display_name = excluded.display_name,
      path = excluded.path,
      line_start = excluded.line_start,
      line_end = excluded.line_end,
      language = excluded.language,
      signature = excluded.signature,
      metadata_json = excluded.metadata_json,
      snapshot_id = excluded.snapshot_id
  `);

  stmt.run(
    id,
    input.repository_id,
    input.entity_type,
    input.scope,
    input.qualified_name,
    input.display_name,
    input.path ?? null,
    input.line_start ?? null,
    input.line_end ?? null,
    input.language ?? null,
    input.signature ?? null,
    metadataJson,
    input.snapshot_id,
  );

  // Return the actual ID (might be the existing one after upsert)
  const row = db
    .prepare('SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?')
    .get(input.repository_id, input.qualified_name) as { id: string } | undefined;

  return row?.id ?? id;
}

/** Finds an entity by its primary ID. */
export function findEntityById(db: Database, id: string): EntityRecord | undefined {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRecord | undefined;
}

/** Finds an entity by its qualified name within a repository. */
export function findEntityByName(
  db: Database,
  repositoryId: string,
  qualifiedName: string,
): EntityRecord | undefined {
  return db
    .prepare('SELECT * FROM entities WHERE repository_id = ? AND qualified_name = ?')
    .get(repositoryId, qualifiedName) as EntityRecord | undefined;
}

/** Finds all entities in a file (by path). */
export function findEntitiesByPath(
  db: Database,
  repositoryId: string,
  filePath: string,
): EntityRecord[] {
  return db
    .prepare('SELECT * FROM entities WHERE repository_id = ? AND path = ? ORDER BY line_start')
    .all(repositoryId, filePath) as EntityRecord[];
}

/** Finds all entities of a given type in a repository. */
export function findEntitiesByType(
  db: Database,
  repositoryId: string,
  entityType: EntityType,
): EntityRecord[] {
  return db
    .prepare('SELECT * FROM entities WHERE repository_id = ? AND entity_type = ?')
    .all(repositoryId, entityType) as EntityRecord[];
}

/** Full-text search across entity names and paths. */
export function searchEntities(
  db: Database,
  query: string,
  filters?: {
    repository_id?: string;
    entity_type?: EntityType;
    language?: Language;
    path_prefix?: string;
  },
  limit: number = 20,
): Array<EntityRecord & { rank: number }> {
  let sql = `
    SELECT e.*, fts.rank
    FROM entities_fts fts
    JOIN entities e ON e.rowid = fts.rowid
    WHERE entities_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (filters?.repository_id) {
    sql += ' AND e.repository_id = ?';
    params.push(filters.repository_id);
  }
  if (filters?.entity_type) {
    sql += ' AND e.entity_type = ?';
    params.push(filters.entity_type);
  }
  if (filters?.language) {
    sql += ' AND e.language = ?';
    params.push(filters.language);
  }
  if (filters?.path_prefix) {
    sql += ' AND e.path LIKE ?';
    params.push(filters.path_prefix + '%');
  }

  sql += ' ORDER BY fts.rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<EntityRecord & { rank: number }>;
}

/** Removes all entities from a specific file (used during re-analysis). */
export function deleteEntitiesByPath(
  db: Database,
  repositoryId: string,
  filePath: string,
): number {
  const result = db
    .prepare('DELETE FROM entities WHERE repository_id = ? AND path = ?')
    .run(repositoryId, filePath);
  return result.changes;
}

/** Counts all entities in a repository. */
export function countEntities(db: Database, repositoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM entities WHERE repository_id = ?')
    .get(repositoryId) as { count: number };
  return row.count;
}
