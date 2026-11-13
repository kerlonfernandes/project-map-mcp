/**
 * Tests for the Reconciliation domain service.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot, updateSnapshot } from '../../../src/repository/snapshots.js';
import { upsertEntity } from '../../../src/repository/entities.js';
import { upsertEdge } from '../../../src/repository/graph.js';
import { setCache } from '../../../src/repository/cache.js';
import { reconcile, shouldReconcile } from '../../../src/domain/reconciliation.js';

describe('Reconciliation', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should return zero changes on clean database', () => {
    const snap = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap, { status: 'completed' });

    const result = reconcile(db, repositoryId);
    expect(result.orphan_entities_removed).toBe(0);
    expect(result.broken_edges_removed).toBe(0);
    expect(result.stale_knowledge_found).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('should remove broken edges where source or target is missing', () => {
    const snap = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap, { status: 'completed' });

    const entityId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Existing',
      display_name: 'Existing',
      path: 'app/Existing.php',
      language: 'php',
      snapshot_id: snap,
    });

    // Temporarily disable FK to simulate broken state (e.g. after entity deletion)
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO edges (id, repository_id, source_id, target_id, edge_type, weight, snapshot_id)
      VALUES ('edge-broken', ?, ?, 'nonexistent-id', 'references', 0.5, ?)
    `).run(repositoryId, entityId, snap);
    db.pragma('foreign_keys = ON');

    const result = reconcile(db, repositoryId);
    expect(result.broken_edges_removed).toBe(1);
  });

  it('should clean expired session cache', () => {
    const snap = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap, { status: 'completed' });

    // Insert an already-expired cache entry
    db.prepare(`
      INSERT INTO session_cache (session_id, cache_key, content, token_count, snapshot_id, expires_at)
      VALUES ('test-session', 'expired-key', '{}', 10, ?, '2020-01-01T00:00:00Z')
    `).run(snap);

    const result = reconcile(db, repositoryId);
    expect(result.expired_cache_cleaned).toBe(1);
  });

  it('should detect stale knowledge', () => {
    const snap = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap, { status: 'completed' });

    db.prepare(`
      INSERT INTO knowledge (id, repository_id, knowledge_type, subject, content, origin, validation_status, confidence, validity, snapshot_id)
      VALUES ('k-stale', ?, 'business_rule', 'Test', 'Test content', 'ai_generated', 'unverified', 0.5, 'needs_review', ?)
    `).run(repositoryId, snap);

    const result = reconcile(db, repositoryId);
    expect(result.stale_knowledge_found).toBe(1);
  });
});

describe('shouldReconcile', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should return false when no snapshots', () => {
    expect(shouldReconcile(db, repositoryId, 10)).toBe(false);
  });

  it('should return true when snapshot count is a multiple of interval', () => {
    for (let i = 0; i < 10; i++) {
      const snap = createSnapshot(db, { repository_id: repositoryId });
      updateSnapshot(db, snap, { status: 'completed' });
    }

    expect(shouldReconcile(db, repositoryId, 10)).toBe(true);
    expect(shouldReconcile(db, repositoryId, 3)).toBe(false);
  });

  it('should return false when count is not a multiple', () => {
    for (let i = 0; i < 7; i++) {
      const snap = createSnapshot(db, { repository_id: repositoryId });
      updateSnapshot(db, snap, { status: 'completed' });
    }

    expect(shouldReconcile(db, repositoryId, 10)).toBe(false);
  });
});
