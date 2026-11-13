/**
 * Tests for the knowledge repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { createSnapshot } from '../../../src/repository/snapshots.js';
import { createEvidence } from '../../../src/repository/evidence.js';
import { upsertEntity } from '../../../src/repository/entities.js';
import {
  createKnowledge,
  findKnowledgeById,
  findCurrentKnowledge,
  findKnowledgeByEntityId,
  linkKnowledgeToEntity,
  linkKnowledgeToEvidence,
  updateKnowledgeStatus,
  markKnowledgeStaleByEvidence,
  searchKnowledge,
  countKnowledgeByValidity,
} from '../../../src/repository/knowledge.js';

describe('Knowledge Repository', () => {
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

  it('should create and retrieve a knowledge record', () => {
    const id = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'User Model',
      knowledge_type: 'business_rule',
      content: 'Users must have a unique email address.',
      origin: 'deterministic',
      snapshot_id: snapshotId,
    });

    const record = findKnowledgeById(db, id);
    expect(record).toBeDefined();
    expect(record!.subject).toBe('User Model');
    expect(record!.knowledge_type).toBe('business_rule');
    expect(record!.validation_status).toBe('unverified');
    expect(record!.confidence).toBe(0.5);
  });

  it('should supersede an older knowledge record', () => {
    const oldId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Auth Rule',
      knowledge_type: 'business_rule',
      content: 'Users authenticate with username.',
      origin: 'deterministic',
    });

    const newId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Auth Rule',
      knowledge_type: 'business_rule',
      content: 'Users authenticate with email.',
      origin: 'deterministic',
      supersedes_id: oldId,
    });

    const oldRecord = findKnowledgeById(db, oldId);
    expect(oldRecord!.validation_status).toBe('superseded');
    expect(oldRecord!.validity).toBe('archived');

    const newRecord = findKnowledgeById(db, newId);
    expect(newRecord!.supersedes_id).toBe(oldId);
  });

  it('should find current (non-archived) knowledge', () => {
    createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Active Rule',
      knowledge_type: 'business_rule',
      content: 'Active content',
      origin: 'deterministic',
    });

    const oldId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Old Rule',
      knowledge_type: 'business_rule',
      content: 'Old content',
      origin: 'deterministic',
    });

    // Supersede the old one so it becomes archived
    createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Old Rule v2',
      knowledge_type: 'business_rule',
      content: 'Updated content',
      origin: 'deterministic',
      supersedes_id: oldId,
    });

    const current = findCurrentKnowledge(db, repositoryId);
    // Should have 2 (the first active + the v2 that superseded), not 3
    expect(current.length).toBe(2);
  });

  it('should link knowledge to entities and find by entity', () => {
    const entityId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Models\\User',
      display_name: 'User',
      path: 'app/Models/User.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const knowledgeId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'User Model',
      knowledge_type: 'pattern',
      content: 'Uses Active Record pattern.',
      origin: 'deterministic',
    });

    linkKnowledgeToEntity(db, knowledgeId, entityId);

    const linked = findKnowledgeByEntityId(db, entityId);
    expect(linked.length).toBe(1);
    expect(linked[0]!.subject).toBe('User Model');
  });

  it('should link knowledge to evidence', () => {
    const evidenceId = createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'docblock',
      path: 'file.php',
      excerpt: 'test evidence',
      snapshot_id: snapshotId,
    });

    const knowledgeId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Test',
      knowledge_type: 'pattern',
      content: 'Test content.',
      origin: 'deterministic',
    });

    expect(() => linkKnowledgeToEvidence(db, knowledgeId, evidenceId)).not.toThrow();
  });

  it('should update validation status', () => {
    const id = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Rule',
      knowledge_type: 'business_rule',
      content: 'Content.',
      origin: 'deterministic',
    });

    updateKnowledgeStatus(db, id, 'human_confirmed', 'current');

    const record = findKnowledgeById(db, id);
    expect(record!.validation_status).toBe('human_confirmed');
    expect(record!.validity).toBe('current');
    expect(record!.validated_at).toBeTruthy();
  });

  it('should mark knowledge stale when evidence changes', () => {
    const evidenceId = createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'file.php',
      excerpt: 'code snippet',
      snapshot_id: snapshotId,
    });

    const knowledgeId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Code Pattern',
      knowledge_type: 'pattern',
      content: 'Some pattern.',
      origin: 'deterministic',
    });

    linkKnowledgeToEvidence(db, knowledgeId, evidenceId);
    updateKnowledgeStatus(db, knowledgeId, 'human_confirmed', 'current');

    const affected = markKnowledgeStaleByEvidence(db, [evidenceId]);
    expect(affected).toBe(1);

    const record = findKnowledgeById(db, knowledgeId);
    expect(record!.validity).toBe('needs_review');
  });

  it('should full-text search knowledge', () => {
    createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Authentication Flow',
      knowledge_type: 'business_rule',
      content: 'All API endpoints require bearer token authentication.',
      origin: 'deterministic',
    });

    const results = searchKnowledge(db, '"authentication"', {
      repository_id: repositoryId,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.subject).toBe('Authentication Flow');
  });

  it('should count knowledge by validity', () => {
    createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Rule 1',
      knowledge_type: 'business_rule',
      content: 'Content 1.',
      origin: 'deterministic',
    });

    createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Rule 2',
      knowledge_type: 'pattern',
      content: 'Content 2.',
      origin: 'deterministic',
    });

    const counts = countKnowledgeByValidity(db, repositoryId);
    expect(counts['current']).toBe(2);
  });
});
