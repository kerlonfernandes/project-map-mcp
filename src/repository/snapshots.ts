/**
 * Repository for snapshot lifecycle management.
 *
 * Snapshots are points-in-time records of the repository state.
 * They track which commit was analyzed, how many entities/edges
 * were found, and whether the analysis completed successfully.
 *
 * Used by: Sync Engine (services/sync.ts).
 */

import type { Database } from 'better-sqlite3';

import type { SnapshotRecord, SnapshotStatus } from '../shared/types.js';
import { generateId, nowISO } from '../shared/utils.js';
import { ANALYZER_VERSION } from '../shared/constants.js';

export interface CreateSnapshotInput {
  repository_id: string;
  branch_name?: string;
  head_commit?: string;
  index_tree_hash?: string;
  working_tree_hash?: string;
}

/**
 * Creates a new pending snapshot.
 * @returns The new snapshot ID.
 */
export function createSnapshot(db: Database, input: CreateSnapshotInput): string {
  const id = generateId('snap');

  db.prepare(`
    INSERT INTO snapshots (
      id, repository_id, branch_name, head_commit,
      index_tree_hash, working_tree_hash,
      analyzer_version, status, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    input.repository_id,
    input.branch_name ?? null,
    input.head_commit ?? null,
    input.index_tree_hash ?? null,
    input.working_tree_hash ?? null,
    ANALYZER_VERSION,
    nowISO(),
  );

  return id;
}

/** Updates a snapshot's status and counters. */
export function updateSnapshot(
  db: Database,
  id: string,
  updates: {
    status?: SnapshotStatus;
    files_analyzed?: number;
    files_total?: number;
    entities_found?: number;
    edges_found?: number;
    duration_ms?: number;
    error_message?: string;
  },
): void {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
    if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'partial') {
      fields.push('completed_at = ?');
      params.push(nowISO());
    }
  }
  if (updates.files_analyzed !== undefined) {
    fields.push('files_analyzed = ?');
    params.push(updates.files_analyzed);
  }
  if (updates.files_total !== undefined) {
    fields.push('files_total = ?');
    params.push(updates.files_total);
  }
  if (updates.entities_found !== undefined) {
    fields.push('entities_found = ?');
    params.push(updates.entities_found);
  }
  if (updates.edges_found !== undefined) {
    fields.push('edges_found = ?');
    params.push(updates.edges_found);
  }
  if (updates.duration_ms !== undefined) {
    fields.push('duration_ms = ?');
    params.push(updates.duration_ms);
  }
  if (updates.error_message !== undefined) {
    fields.push('error_message = ?');
    params.push(updates.error_message);
  }

  if (fields.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE snapshots SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

/** Finds the most recent completed snapshot for a repository. */
export function findLatestSnapshot(
  db: Database,
  repositoryId: string,
): SnapshotRecord | undefined {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE repository_id = ? AND status IN ('completed', 'partial')
    ORDER BY started_at DESC
    LIMIT 1
  `).get(repositoryId) as SnapshotRecord | undefined;
}

/** Finds a snapshot by its primary ID. */
export function findSnapshotById(
  db: Database,
  id: string,
): SnapshotRecord | undefined {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
    | SnapshotRecord
    | undefined;
}

/** Counts completed snapshots for a repository (for reconciliation interval). */
export function countSnapshotsSince(
  db: Database,
  repositoryId: string,
  sinceSnapshotId: string,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM snapshots
    WHERE repository_id = ?
      AND status = 'completed'
      AND started_at > (
        SELECT started_at FROM snapshots WHERE id = ?
      )
  `).get(repositoryId, sinceSnapshotId) as { count: number };
  return row.count;
}
