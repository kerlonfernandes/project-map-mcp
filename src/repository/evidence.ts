/**
 * Repository for evidence CRUD and queries.
 *
 * Evidence is a first-class entity: a traceable source reference that
 * backs knowledge records and conventions. Its content_hash enables
 * change detection between snapshots.
 *
 * Used by: Knowledge Manager, Sync Engine, Application Services.
 */

import type { Database } from 'better-sqlite3';

import type { EvidenceRecord, SourceKind } from '../shared/types.js';
import { generateId, sha256 } from '../shared/utils.js';

export interface CreateEvidenceInput {
  repository_id: string;
  source_kind: SourceKind;
  path?: string;
  line_start?: number;
  line_end?: number;
  symbol_id?: string;
  excerpt?: string;
  snapshot_id?: string;
  commit_sha?: string;
}

/**
 * Creates a new evidence record.
 * Automatically computes content_hash from the excerpt.
 *
 * @returns The new evidence ID.
 */
export function createEvidence(db: Database, input: CreateEvidenceInput): string {
  const id = generateId('ev');
  const contentHash = input.excerpt ? sha256(input.excerpt) : null;

  db.prepare(`
    INSERT INTO evidence (
      id, repository_id, source_kind, path, line_start, line_end,
      symbol_id, content_hash, snapshot_id, commit_sha, excerpt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.repository_id,
    input.source_kind,
    input.path ?? null,
    input.line_start ?? null,
    input.line_end ?? null,
    input.symbol_id ?? null,
    contentHash,
    input.snapshot_id ?? null,
    input.commit_sha ?? null,
    input.excerpt ?? null,
  );

  return id;
}

/** Finds evidence by its primary ID. */
export function findEvidenceById(db: Database, id: string): EvidenceRecord | undefined {
  return db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as EvidenceRecord | undefined;
}

/** Finds all evidence linked to a specific file path. */
export function findEvidenceByPath(
  db: Database,
  repositoryId: string,
  filePath: string,
): EvidenceRecord[] {
  return db
    .prepare('SELECT * FROM evidence WHERE repository_id = ? AND path = ? ORDER BY line_start')
    .all(repositoryId, filePath) as EvidenceRecord[];
}

/** Finds all evidence for a specific snapshot. */
export function findEvidenceBySnapshot(
  db: Database,
  snapshotId: string,
): EvidenceRecord[] {
  return db
    .prepare('SELECT * FROM evidence WHERE snapshot_id = ?')
    .all(snapshotId) as EvidenceRecord[];
}

/**
 * Finds evidence whose content_hash changed between two snapshots.
 * This drives the staleness propagation system.
 *
 * @returns Evidence records from the new snapshot whose hash differs
 *          from the previous snapshot's evidence at the same path+lines.
 */
export function findChangedEvidence(
  db: Database,
  repositoryId: string,
  oldSnapshotId: string,
  newSnapshotId: string,
): EvidenceRecord[] {
  return db.prepare(`
    SELECT new_ev.*
    FROM evidence new_ev
    LEFT JOIN evidence old_ev
      ON old_ev.repository_id = new_ev.repository_id
      AND old_ev.path = new_ev.path
      AND old_ev.line_start = new_ev.line_start
      AND old_ev.snapshot_id = ?
    WHERE new_ev.repository_id = ?
      AND new_ev.snapshot_id = ?
      AND (old_ev.id IS NULL OR old_ev.content_hash != new_ev.content_hash)
  `).all(oldSnapshotId, repositoryId, newSnapshotId) as EvidenceRecord[];
}

/** Full-text search on evidence excerpts. */
export function searchEvidence(
  db: Database,
  query: string,
  repositoryId?: string,
  limit: number = 20,
): Array<EvidenceRecord & { rank: number }> {
  let sql = `
    SELECT e.*, fts.rank
    FROM evidence_fts fts
    JOIN evidence e ON e.rowid = fts.rowid
    WHERE evidence_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (repositoryId) {
    sql += ' AND e.repository_id = ?';
    params.push(repositoryId);
  }

  sql += ' ORDER BY fts.rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<EvidenceRecord & { rank: number }>;
}

/** Deletes all evidence from a specific file (used during re-analysis). */
export function deleteEvidenceByPath(
  db: Database,
  repositoryId: string,
  filePath: string,
): number {
  const result = db
    .prepare('DELETE FROM evidence WHERE repository_id = ? AND path = ?')
    .run(repositoryId, filePath);
  return result.changes;
}
