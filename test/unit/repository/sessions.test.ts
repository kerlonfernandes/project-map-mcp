/**
 * Tests for the work sessions repository layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import {
  createWorkSession,
  updateWorkSession,
  findWorkSessionById,
  findActiveSessionByName,
  listWorkSessions,
  closeWorkSession,
  getSessionCheckpoints,
} from '../../../src/repository/sessions.js';

describe('Sessions Repository', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const project = createProjectWithRepository(db, 'test-project', '/tmp/test', '/tmp/test');
    repositoryId = project.repositoryId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should create a work session with first checkpoint', () => {
    const id = createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'refactor-auth',
      task_description: 'Refactor auth module to use JWT',
      current_status: 'Starting implementation',
      completed_steps: ['Plan the approach'],
      pending_steps: ['Create JwtService', 'Update middleware'],
      files_involved: ['app/Services/JwtService.php'],
      notes: 'Using firebase/php-jwt',
    });

    expect(id).toMatch(/^sess-/);

    const session = findWorkSessionById(db, id);
    expect(session).toBeDefined();
    expect(session!.session_name).toBe('refactor-auth');
    expect(session!.task_description).toBe('Refactor auth module to use JWT');
    expect(session!.status).toBe('in_progress');
    expect(session!.checkpoints_count).toBe(1);

    const completed = JSON.parse(session!.completed_steps);
    expect(completed).toEqual(['Plan the approach']);

    const pending = JSON.parse(session!.pending_steps);
    expect(pending).toEqual(['Create JwtService', 'Update middleware']);

    const checkpoints = getSessionCheckpoints(db, id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpoint_number).toBe(1);
  });

  it('should update a work session and create new checkpoint', () => {
    const id = createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'fix-bug',
      task_description: 'Fix order cancellation bug',
      pending_steps: ['Investigate', 'Fix', 'Test'],
    });

    const newCheckpoint = updateWorkSession(db, id, {
      current_status: 'Investigating root cause',
      completed_steps: ['Investigate'],
      pending_steps: ['Fix', 'Test'],
    });

    expect(newCheckpoint).toBe(2);

    const session = findWorkSessionById(db, id);
    expect(session!.checkpoints_count).toBe(2);
    expect(session!.current_status).toBe('Investigating root cause');

    const checkpoints = getSessionCheckpoints(db, id);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1].checkpoint_number).toBe(2);
  });

  it('should find active session by name', () => {
    createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'my-task',
      task_description: 'Do something',
    });

    const found = findActiveSessionByName(db, repositoryId, 'my-task');
    expect(found).toBeDefined();
    expect(found!.session_name).toBe('my-task');

    const notFound = findActiveSessionByName(db, repositoryId, 'nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('should list sessions ordered by updated_at desc', () => {
    createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'first',
      task_description: 'First task',
    });

    createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'second',
      task_description: 'Second task',
    });

    const sessions = listWorkSessions(db, repositoryId);
    expect(sessions).toHaveLength(2);
  });

  it('should list sessions filtered by status', () => {
    const id = createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'to-close',
      task_description: 'Will be closed',
    });

    createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'stays-open',
      task_description: 'Stays in progress',
    });

    closeWorkSession(db, id);

    const inProgress = listWorkSessions(db, repositoryId, 'in_progress');
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].session_name).toBe('stays-open');

    const completed = listWorkSessions(db, repositoryId, 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].session_name).toBe('to-close');
  });

  it('should close a work session', () => {
    const id = createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'close-me',
      task_description: 'To be closed',
    });

    closeWorkSession(db, id);

    const session = findWorkSessionById(db, id);
    expect(session!.status).toBe('completed');
    expect(session!.closed_at).toBeTruthy();
  });

  it('should return 0 when updating nonexistent session', () => {
    const result = updateWorkSession(db, 'nonexistent-id', {
      current_status: 'test',
    });

    expect(result).toBe(0);
  });

  it('should handle session with minimal fields', () => {
    const id = createWorkSession(db, {
      repository_id: repositoryId,
      session_name: 'minimal',
      task_description: 'Just the basics',
    });

    const session = findWorkSessionById(db, id);
    expect(session!.completed_steps).toBe('[]');
    expect(session!.pending_steps).toBe('[]');
    expect(session!.files_involved).toBe('[]');
    expect(session!.notes).toBeNull();
    expect(session!.current_status).toBeNull();
  });
});
