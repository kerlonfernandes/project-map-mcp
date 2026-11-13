/**
 * Tests for the evidence repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot } from '../../../src/repository/snapshots.js';
import {
  createEvidence,
  findEvidenceById,
  findEvidenceByPath,
  findEvidenceBySnapshot,
  searchEvidence,
  deleteEvidenceByPath,
} from '../../../src/repository/evidence.js';

describe('Evidence Repository', () => {
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

  it('should create and retrieve evidence', () => {
    const id = createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'app/Models/User.php',
      line_start: 5,
      line_end: 10,
      excerpt: '/** The User model represents a registered user. */',
      snapshot_id: snapshotId,
    });

    const ev = findEvidenceById(db, id);
    expect(ev).toBeDefined();
    expect(ev!.source_kind).toBe('docblock');
    expect(ev!.path).toBe('app/Models/User.php');
    expect(ev!.content_hash).toBeDefined();
  });

  it('should compute content_hash from excerpt', () => {
    const id = createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'app/test.php',
      excerpt: 'some code',
      snapshot_id: snapshotId,
    });

    const ev = findEvidenceById(db, id);
    expect(ev!.content_hash).toBeTruthy();
    expect(ev!.content_hash!.length).toBe(64);
  });

  it('should find evidence by path', () => {
    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'app/Models/User.php',
      line_start: 5,
      line_end: 10,
      excerpt: 'comment 1',
      snapshot_id: snapshotId,
    });

    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'comment',
      path: 'app/Models/User.php',
      line_start: 20,
      line_end: 22,
      excerpt: 'comment 2',
      snapshot_id: snapshotId,
    });

    const results = findEvidenceByPath(db, repositoryId, 'app/Models/User.php');
    expect(results.length).toBe(2);
  });

  it('should find evidence by snapshot', () => {
    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'file.php',
      excerpt: 'test',
      snapshot_id: snapshotId,
    });

    const results = findEvidenceBySnapshot(db, snapshotId);
    expect(results.length).toBe(1);
  });

  it('should full-text search evidence', () => {
    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'file.php',
      excerpt: 'This function handles user authentication and login',
      snapshot_id: snapshotId,
    });

    const results = searchEvidence(db, '"authentication"', repositoryId);
    expect(results.length).toBe(1);
  });

  it('should delete evidence by path', () => {
    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'app/delete-me.php',
      excerpt: 'to be deleted',
      snapshot_id: snapshotId,
    });

    const deleted = deleteEvidenceByPath(db, repositoryId, 'app/delete-me.php');
    expect(deleted).toBe(1);

    const results = findEvidenceByPath(db, repositoryId, 'app/delete-me.php');
    expect(results.length).toBe(0);
  });
});
