/**
 * Tests for the graph (edges) repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot } from '../../../src/repository/snapshots.js';
import { upsertEntity } from '../../../src/repository/entities.js';
import {
  upsertEdge,
  findOutgoingEdges,
  findIncomingEdges,
  traverseGraph,
  countEdges,
  countUnresolvedEdges,
} from '../../../src/repository/graph.js';

describe('Graph Repository', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;
  let entityA: string;
  let entityB: string;
  let entityC: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const project = createProjectWithRepository(db, 'test-project', '/tmp/test', '/tmp/test');
    repositoryId = project.repositoryId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });

    entityA = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\A',
      display_name: 'A',
      path: 'a.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    entityB = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\B',
      display_name: 'B',
      path: 'b.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    entityC = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\C',
      display_name: 'C',
      path: 'c.php',
      language: 'php',
      snapshot_id: snapshotId,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should create and count edges', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      snapshot_id: snapshotId,
    });

    expect(countEdges(db, repositoryId)).toBe(1);
  });

  it('should upsert edges (update on conflict)', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      weight: 0.5,
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      weight: 0.9,
      snapshot_id: snapshotId,
    });

    expect(countEdges(db, repositoryId)).toBe(1);
  });

  it('should find outgoing edges', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityC,
      edge_type: 'imports',
      snapshot_id: snapshotId,
    });

    const outgoing = findOutgoingEdges(db, entityA);
    expect(outgoing.length).toBe(2);
  });

  it('should find incoming edges', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      snapshot_id: snapshotId,
    });

    const incoming = findIncomingEdges(db, entityB);
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.source_id).toBe(entityA);
  });

  it('should filter edges by type', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityC,
      edge_type: 'imports',
      snapshot_id: snapshotId,
    });

    const extendsOnly = findOutgoingEdges(db, entityA, ['extends']);
    expect(extendsOnly.length).toBe(1);
    expect(extendsOnly[0]!.edge_type).toBe('extends');
  });

  it('should traverse graph with BFS', () => {
    // A -> B -> C
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'calls',
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityB,
      target_id: entityC,
      edge_type: 'calls',
      snapshot_id: snapshotId,
    });

    const result = traverseGraph(db, entityA, 'outgoing', 2);
    expect(result.nodeIds.size).toBe(3);
    expect(result.nodeIds.has(entityA)).toBe(true);
    expect(result.nodeIds.has(entityB)).toBe(true);
    expect(result.nodeIds.has(entityC)).toBe(true);
    expect(result.edges.length).toBe(2);
  });

  it('should respect maxDepth in traversal', () => {
    // A -> B -> C with maxDepth=1 should only reach B
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'calls',
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityB,
      target_id: entityC,
      edge_type: 'calls',
      snapshot_id: snapshotId,
    });

    const result = traverseGraph(db, entityA, 'outgoing', 1);
    expect(result.nodeIds.size).toBe(2);
    expect(result.nodeIds.has(entityC)).toBe(false);
  });

  it('should count unresolved edges', () => {
    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: entityA,
      target_id: entityB,
      edge_type: 'extends',
      resolution_status: 'unresolved',
      snapshot_id: snapshotId,
    });

    expect(countUnresolvedEdges(db, repositoryId)).toBe(1);
  });
});
