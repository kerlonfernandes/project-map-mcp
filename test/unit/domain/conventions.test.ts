/**
 * Tests for the Convention Detector domain service.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot, updateSnapshot } from '../../../src/repository/snapshots.js';
import { upsertEntity } from '../../../src/repository/entities.js';
import { detectConventions } from '../../../src/domain/conventions.js';

describe('Convention Detector', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should return 0 for empty repository', () => {
    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBe(0);
  });

  it('should detect naming convention for Controller suffix', () => {
    const controllers = ['UserController', 'OrderController', 'ProductController', 'CartController'];
    for (const name of controllers) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\Http\\Controllers\\${name}`,
        display_name: name,
        path: `app/Http/Controllers/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBeGreaterThanOrEqual(1);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND category = 'naming'",
    ).all(repositoryId) as Array<{ description: string; occurrences: number }>;

    const controllerConv = conventions.find((c) => c.description.includes('Controller'));
    expect(controllerConv).toBeDefined();
    expect(controllerConv!.occurrences).toBe(4);
  });

  it('should detect structure convention for classes in same directory', () => {
    const services = ['PaymentService', 'OrderService', 'UserService'];
    for (const name of services) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\Services\\${name}`,
        display_name: name,
        path: `app/Services/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBeGreaterThanOrEqual(1);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND category = 'structure'",
    ).all(repositoryId) as Array<{ description: string }>;

    const structConv = conventions.find((c) => c.description.includes('app/Services'));
    expect(structConv).toBeDefined();
  });

  it('should detect pattern convention for Repository pattern', () => {
    const repos = ['UserRepository', 'OrderRepository', 'ProductRepository'];
    for (const name of repos) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\Repositories\\${name}`,
        display_name: name,
        path: `app/Repositories/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBeGreaterThanOrEqual(1);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND category = 'pattern'",
    ).all(repositoryId) as Array<{ description: string }>;

    const repoConv = conventions.find((c) => c.description.includes('Repository'));
    expect(repoConv).toBeDefined();
  });

  it('should detect camelCase function naming convention', () => {
    const functions = ['getUserById', 'createOrder', 'processPayment', 'validateInput'];
    for (const name of functions) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'function',
        scope: 'symbol',
        qualified_name: `functions::${name}`,
        display_name: name,
        path: 'app/helpers.php',
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBeGreaterThanOrEqual(1);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND description LIKE '%camelCase%'",
    ).all(repositoryId) as Array<{ description: string }>;

    expect(conventions.length).toBeGreaterThan(0);
  });

  it('should not detect convention below threshold', () => {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\FooService',
      display_name: 'FooService',
      path: 'app/FooService.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBe(0);
  });

  it('should update convention on re-detection', () => {
    const services = ['AService', 'BService', 'CService'];
    for (const name of services) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\${name}`,
        display_name: name,
        path: `app/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    detectConventions(db, repositoryId, snapshotId);

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\DService',
      display_name: 'DService',
      path: 'app/DService.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const snap2 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap2, { status: 'completed' });

    detectConventions(db, repositoryId, snap2);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND description LIKE '%Service%' AND category = 'naming'",
    ).all(repositoryId) as Array<{ occurrences: number }>;

    expect(conventions.length).toBe(1);
    expect(conventions[0]!.occurrences).toBe(4);
  });

  it('should compute confidence proportional to occurrences', () => {
    const controllers = ['AController', 'BController', 'CController', 'DController', 'EController'];
    for (const name of controllers) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\${name}`,
        display_name: name,
        path: `app/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    detectConventions(db, repositoryId, snapshotId);

    const conventions = db.prepare(
      "SELECT * FROM conventions WHERE repository_id = ? AND description LIKE '%Controller%' AND category = 'naming'",
    ).all(repositoryId) as Array<{ confidence: number }>;

    expect(conventions.length).toBe(1);
    expect(conventions[0]!.confidence).toBeGreaterThan(0);
    expect(conventions[0]!.confidence).toBeLessThanOrEqual(1.0);
  });
});
