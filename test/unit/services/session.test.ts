/**
 * Tests for the session management application service.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/repository/db.js';
import { createProjectWithRepository } from '../../../src/repository/projects.js';
import { manageSession } from '../../../src/services/session.js';
import { SessionNotFoundError, ValidationError } from '../../../src/shared/errors.js';
import type { ProjectMapConfig } from '../../../src/shared/types.js';

const TEST_CONFIG: ProjectMapConfig = {
  project: { name: 'test', root: '/tmp/test' },
  analysis: {
    languages: ['php', 'javascript'],
    frameworks: ['laravel', 'express'],
    exclude_patterns: ['node_modules/', 'vendor/'],
    max_file_size_mb: 2,
    max_directory_depth: 20,
    max_files_per_sync: 500,
    parse_timeout_ms: 30000,
  },
  database: { path: ':memory:', max_size_mb: 50, cache_size_mb: 10 },
  security: {
    blocked_paths: ['.env', '.git/'],
    mysql: { allow_connection: false, allowed_hosts: ['localhost'], blocked_schemas: ['mysql', 'information_schema'] },
    rate_limit: { enabled: false, max_per_minute: 60 },
  },
  sync: { reconciliation_interval: 10, staleness_max_depth: 3 },
  context: { default_depth: 'structure', default_purpose: 'understand', default_token_budget: 2000, max_token_budget: 50000 },
};

describe('Session Service', () => {
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

  describe('checkpoint', () => {
    it('should create a new session on first checkpoint', () => {
      const result = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'refactor-auth',
        task_description: 'Refactor authentication',
        current_status: 'Planning phase',
        completed_steps: ['Review current code'],
        pending_steps: ['Create new service', 'Write tests'],
        files_involved: ['app/Services/Auth.php'],
        notes: 'Using JWT approach',
      });

      expect(result.session_id).toMatch(/^sess-/);
      expect(result.session_name).toBe('refactor-auth');
      expect(result.action).toBe('saved');
      expect(result.checkpoint_number).toBe(1);
      expect(result.message).toContain('Checkpoint salvo');
    });

    it('should update existing session on subsequent checkpoints', () => {
      const first = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'my-task',
        task_description: 'Task description',
        pending_steps: ['Step 1', 'Step 2'],
      });

      const second = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'my-task',
        task_description: 'Task description updated',
        current_status: 'Working on step 1',
        completed_steps: ['Step 1'],
        pending_steps: ['Step 2'],
      });

      expect(second.session_id).toBe(first.session_id);
      expect(second.checkpoint_number).toBe(2);
    });

    it('should throw on checkpoint without session_name', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'checkpoint',
          task_description: 'Missing name',
        }),
      ).toThrow(ValidationError);
    });

    it('should throw on checkpoint without task_description', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'checkpoint',
          session_name: 'has-name',
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('resume', () => {
    it('should return full session state', () => {
      const checkpoint = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'resume-test',
        task_description: 'Test resume functionality',
        current_status: 'In progress',
        completed_steps: ['Step A'],
        pending_steps: ['Step B', 'Step C'],
        files_involved: ['file1.ts', 'file2.ts'],
        notes: 'Some important notes',
      });

      const result = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'resume',
        session_id: checkpoint.session_id as string,
      });

      expect(result.session_id).toBe(checkpoint.session_id);
      expect(result.session_name).toBe('resume-test');
      expect(result.task_description).toBe('Test resume functionality');
      expect(result.current_status).toBe('In progress');
      expect(result.completed_steps).toEqual(['Step A']);
      expect(result.pending_steps).toEqual(['Step B', 'Step C']);
      expect(result.files_involved).toEqual(['file1.ts', 'file2.ts']);
      expect(result.notes).toBe('Some important notes');
      expect(result.checkpoints_count).toBe(1);
    });

    it('should throw on resume without session_id', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'resume',
        }),
      ).toThrow(ValidationError);
    });

    it('should throw on resume with nonexistent session_id', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'resume',
          session_id: 'sess-nonexistent',
        }),
      ).toThrow(SessionNotFoundError);
    });
  });

  describe('list', () => {
    it('should return empty array when no sessions exist', () => {
      const result = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'list',
      });

      expect(result.sessions).toEqual([]);
    });

    it('should list all sessions with summary info', () => {
      manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'task-1',
        task_description: 'First task',
        completed_steps: ['Done 1'],
        pending_steps: ['Todo 1', 'Todo 2'],
      });

      manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'task-2',
        task_description: 'Second task',
      });

      const result = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'list',
      });

      const sessions = result.sessions as Array<Record<string, unknown>>;
      expect(sessions).toHaveLength(2);

      const task1 = sessions.find((s) => s.session_name === 'task-1')!;
      expect(task1.status).toBe('in_progress');
      expect(task1.completed_steps_count).toBe(1);
      expect(task1.pending_steps_count).toBe(2);
    });
  });

  describe('close', () => {
    it('should close an active session', () => {
      const checkpoint = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'close-me',
        task_description: 'Will be closed',
      });

      const result = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'close',
        session_id: checkpoint.session_id as string,
      });

      expect(result.action).toBe('closed');
      expect(result.session_name).toBe('close-me');

      // Verify it's actually closed
      const resumed = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'resume',
        session_id: checkpoint.session_id as string,
      });

      expect(resumed.status).toBe('completed');
    });

    it('should throw on close without session_id', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'close',
        }),
      ).toThrow(ValidationError);
    });

    it('should throw on close with nonexistent session_id', () => {
      expect(() =>
        manageSession(db, repositoryId, TEST_CONFIG, {
          action: 'close',
          session_id: 'sess-nonexistent',
        }),
      ).toThrow(SessionNotFoundError);
    });
  });

  describe('full workflow', () => {
    it('should support create → update → resume → close', () => {
      // 1. Create initial checkpoint
      const created = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'full-workflow',
        task_description: 'Complete workflow test',
        pending_steps: ['Step 1', 'Step 2', 'Step 3'],
      });

      expect(created.checkpoint_number).toBe(1);

      // 2. Update with progress
      const updated = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'checkpoint',
        session_name: 'full-workflow',
        task_description: 'Complete workflow test',
        current_status: 'Working on step 2',
        completed_steps: ['Step 1'],
        pending_steps: ['Step 2', 'Step 3'],
      });

      expect(updated.checkpoint_number).toBe(2);
      expect(updated.session_id).toBe(created.session_id);

      // 3. Resume in "new session"
      const resumed = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'resume',
        session_id: created.session_id as string,
      });

      expect(resumed.current_status).toBe('Working on step 2');
      expect(resumed.completed_steps).toEqual(['Step 1']);
      expect(resumed.pending_steps).toEqual(['Step 2', 'Step 3']);
      expect(resumed.checkpoints_count).toBe(2);

      // 4. Close
      const closed = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'close',
        session_id: created.session_id as string,
      });

      expect(closed.action).toBe('closed');

      // 5. Verify closed sessions still show in list
      const list = manageSession(db, repositoryId, TEST_CONFIG, {
        action: 'list',
      });

      const sessions = list.sessions as Array<Record<string, unknown>>;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('completed');
    });
  });
});
