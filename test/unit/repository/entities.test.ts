/**
 * Tests for the entity repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot } from '../../../src/repository/snapshots.js';
import {
  upsertEntity,
  findEntityById,
  findEntityByName,
  findEntitiesByPath,
  findEntitiesByType,
  searchEntities,
  deleteEntitiesByPath,
  countEntities,
} from '../../../src/repository/entities.js';

describe('Entity Repository', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const project = createProjectWithRepository(db, 'test-project', '/tmp/test', '/tmp/test');
    repositoryId = project.repositoryId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should create and retrieve an entity', () => {
    const id = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      line_start: 10,
      line_end: 50,
      language: 'php',
      snapshot_id: snapshotId,
    });

    const entity = findEntityById(db, id);
    expect(entity).toBeDefined();
    expect(entity!.display_name).toBe('User');
    expect(entity!.entity_type).toBe('class');
    expect(entity!.qualified_name).toBe('App\\Models\\User');
  });

  it('should upsert (update on conflict)', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      line_start: 10,
      line_end: 50,
      language: 'php',
      snapshot_id: snapshotId,
    });

    // Upsert with updated data
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      line_start: 10,
      line_end: 60,
      language: 'php',
      snapshot_id: snapshotId,
    });

    // Should still be one entity
    expect(countEntities(db, repositoryId)).toBe(1);

    const entity = findEntityByName(db, repositoryId, 'App\\Models\\User');
    expect(entity!.line_end).toBe(60);
  });

  it('should find entities by path', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/Models/User.php',
      display_name: 'User.php',
      path: 'app/Models/User.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      line_start: 10,
      line_end: 50,
      language: 'php',
      snapshot_id: snapshotId,
    });

    const results = findEntitiesByPath(db, repositoryId, 'app/Models/User.php');
    expect(results.length).toBe(2);
  });

  it('should find entities by type', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'function',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User::create',
      display_name: 'create',
      path: 'app/Models/User.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const classes = findEntitiesByType(db, repositoryId, 'class');
    expect(classes.length).toBe(1);
    expect(classes[0]!.display_name).toBe('User');
  });

  it('should full-text search entities', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Services\\OrderService',
      display_name: 'OrderService',
      path: 'app/Services/OrderService.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const results = searchEntities(db, '"OrderService"', { repository_id: repositoryId });
    expect(results.length).toBe(1);
    expect(results[0]!.display_name).toBe('OrderService');
  });

  it('should delete entities by path', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const deleted = deleteEntitiesByPath(db, repositoryId, 'app/Models/User.php');
    expect(deleted).toBe(1);
    expect(countEntities(db, repositoryId)).toBe(0);
  });
});
