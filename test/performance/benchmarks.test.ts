/**
 * Performance benchmark tests.
 *
 * Validates targets from the spec:
 * - get_context (cache hit): < 500ms
 * - search: < 200ms
 * - Session cache read: < 50ms
 *
 * Note: Full sync and incremental sync benchmarks require filesystem
 * I/O with real project fixtures and are covered by E2E tests.
 * These tests validate in-memory operation performance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/repository/db.js';
import { createProjectWithRepository } from '../../src/repository/projects.js';
import { createSnapshot, updateSnapshot } from '../../src/repository/snapshots.js';
import { upsertEntity } from '../../src/repository/entities.js';
import { upsertEdge } from '../../src/repository/graph.js';
import { createEvidence } from '../../src/repository/evidence.js';
import { setCache, getCache } from '../../src/repository/cache.js';
import { getContext } from '../../src/services/context.js';
import { search as searchRepository } from '../../src/services/search.js';

describe('Performance Benchmarks', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 100, entities_found: 500 });

    // Seed 100 files, 300 classes, 500 edges
    for (let i = 0; i < 100; i++) {
      const fileId = upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'file',
        scope: 'file',
        qualified_name: `app/Module${i}/Service${i}.php`,
        display_name: `Service${i}.php`,
        path: `app/Module${i}/Service${i}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });

      const classId = upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\Module${i}\\Service${i}`,
        display_name: `Service${i}`,
        path: `app/Module${i}/Service${i}.php`,
        language: 'php',
        signature: `class Service${i}`,
        snapshot_id: snapshotId,
      });

      const funcId = upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'function',
        scope: 'symbol',
        qualified_name: `App\\Module${i}\\Service${i}::execute`,
        display_name: 'execute',
        path: `app/Module${i}/Service${i}.php`,
        language: 'php',
        signature: `public function execute(): void`,
        snapshot_id: snapshotId,
      });

      upsertEdge(db, {
        repository_id: repositoryId,
        source_id: funcId,
        target_id: classId,
        edge_type: 'belongs_to',
        snapshot_id: snapshotId,
      });

      if (i > 0) {
        const prevClassId = db.prepare(
          'SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?',
        ).get(repositoryId, `App\\Module${i - 1}\\Service${i - 1}`) as { id: string } | undefined;

        if (prevClassId) {
          upsertEdge(db, {
            repository_id: repositoryId,
            source_id: classId,
            target_id: prevClassId.id,
            edge_type: 'references',
            snapshot_id: snapshotId,
          });
        }
      }

      createEvidence(db, {
        repository_id: repositoryId,
        source_kind: 'code',
        path: `app/Module${i}/Service${i}.php`,
        line_start: 1,
        line_end: 50,
        excerpt: `class Service${i} { public function execute() { /* module ${i} logic */ } }`,
        snapshot_id: snapshotId,
      });
    }
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should execute get_context under 500ms (target: cache miss)', () => {
    const start = performance.now();

    const result = getContext(db, repositoryId, {
      target: 'app/Module50/Service50.php',
      depth: 'detail',
      purpose: 'understand',
      token_budget: 5000,
    });

    const elapsed = performance.now() - start;

    expect(result.target).toBeDefined();
    expect(elapsed).toBeLessThan(500);
  });

  it('should execute get_context under 100ms (target: cache hit)', () => {
    getContext(db, repositoryId, {
      target: 'app/Module50/Service50.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'perf-test',
    });

    const start = performance.now();

    const result = getContext(db, repositoryId, {
      target: 'app/Module50/Service50.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'perf-test',
    });

    const elapsed = performance.now() - start;

    expect((result.meta as Record<string, unknown>).cached).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('should execute search under 200ms', () => {
    const start = performance.now();

    const result = searchRepository(db, repositoryId, {
      query: 'Service execute',
      scope: 'entities',
      limit: 20,
      token_budget: 2000,
    });

    const elapsed = performance.now() - start;

    expect(result.results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });

  it('should read session cache under 50ms', () => {
    setCache(db, 'perf-session', 'perf-key', '{"large":"payload","data":"test"}', 100, snapshotId);

    const start = performance.now();

    const cached = getCache(db, 'perf-session', 'perf-key');

    const elapsed = performance.now() - start;

    expect(cached).not.toBeNull();
    expect(elapsed).toBeLessThan(50);
  });

  it('should handle 100 entity search with acceptable latency', () => {
    const start = performance.now();

    const result = searchRepository(db, repositoryId, {
      query: 'execute',
      scope: 'entities',
      limit: 100,
      token_budget: 10000,
    });

    const elapsed = performance.now() - start;

    expect(result.results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});
