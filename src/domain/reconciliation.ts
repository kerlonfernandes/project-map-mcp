/**
 * Reconciliation — periodic consistency checks and cleanup.
 *
 * Runs every N snapshots (configured via sync.reconciliation_interval)
 * to maintain database integrity:
 * - Detect and remove orphan entities (no snapshot, no edges)
 * - Verify edge consistency (both endpoints exist)
 * - Clean expired session cache entries
 * - Update convention occurrences
 *
 * Used by: services/sync.ts (after full/incremental sync completes).
 */

import type { Database } from 'better-sqlite3';

import { cleanExpiredCache } from '../repository/cache.js';

export interface ReconciliationResult {
  orphan_entities_removed: number;
  broken_edges_removed: number;
  expired_cache_cleaned: number;
  stale_knowledge_found: number;
  duration_ms: number;
}

/**
 * Runs a full reconciliation pass on the repository.
 *
 * @param db - Database connection.
 * @param repositoryId - Repository to reconcile.
 * @returns Summary of changes made.
 */
export function reconcile(
  db: Database,
  repositoryId: string,
): ReconciliationResult {
  const start = Date.now();

  const orphanEntities = removeOrphanEntities(db, repositoryId);
  const brokenEdges = removeBrokenEdges(db, repositoryId);
  const expiredCache = cleanExpiredCache(db);
  const staleKnowledge = countStaleKnowledge(db, repositoryId);

  return {
    orphan_entities_removed: orphanEntities,
    broken_edges_removed: brokenEdges,
    expired_cache_cleaned: expiredCache,
    stale_knowledge_found: staleKnowledge,
    duration_ms: Date.now() - start,
  };
}

/**
 * Checks whether reconciliation should run based on snapshot count.
 */
export function shouldReconcile(
  db: Database,
  repositoryId: string,
  interval: number,
): boolean {
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM snapshots WHERE repository_id = ?',
  ).get(repositoryId) as { count: number };

  return result.count > 0 && result.count % interval === 0;
}

function removeOrphanEntities(db: Database, repositoryId: string): number {
  const result = db.prepare(`
    DELETE FROM entities WHERE repository_id = ? AND id NOT IN (
      SELECT DISTINCT source_id FROM edges WHERE repository_id = ?
      UNION
      SELECT DISTINCT target_id FROM edges WHERE repository_id = ?
      UNION
      SELECT DISTINCT entity_id FROM knowledge_entities
    ) AND entity_type NOT IN ('file', 'directory')
    AND id NOT IN (
      SELECT DISTINCT id FROM entities WHERE repository_id = ? AND snapshot_id IN (
        SELECT id FROM snapshots WHERE repository_id = ? ORDER BY created_at DESC LIMIT 2
      )
    )
  `).run(repositoryId, repositoryId, repositoryId, repositoryId, repositoryId);

  return result.changes;
}

function removeBrokenEdges(db: Database, repositoryId: string): number {
  const result = db.prepare(`
    DELETE FROM edges WHERE repository_id = ? AND (
      source_id NOT IN (SELECT id FROM entities WHERE repository_id = ?)
      OR target_id NOT IN (SELECT id FROM entities WHERE repository_id = ?)
    )
  `).run(repositoryId, repositoryId, repositoryId);

  return result.changes;
}

function countStaleKnowledge(db: Database, repositoryId: string): number {
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM knowledge WHERE repository_id = ? AND validity IN ('needs_review', 'stale')",
  ).get(repositoryId) as { count: number };

  return result.count;
}
