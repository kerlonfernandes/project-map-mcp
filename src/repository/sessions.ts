/**
 * Repository for work session persistence and queries.
 *
 * Work sessions track AI task progress across chat sessions.
 * Each session has multiple checkpoints that snapshot the state
 * at a point in time for recovery.
 *
 * Used by: services/session.ts.
 */

import type { Database } from 'better-sqlite3';

import type { WorkSessionRecord, WorkSessionCheckpointRecord, WorkSessionStatus } from '../shared/types.js';
import { generateId, nowISO } from '../shared/utils.js';

export interface CreateSessionInput {
  repository_id: string;
  session_name: string;
  task_description: string;
  current_status?: string;
  completed_steps?: string[];
  pending_steps?: string[];
  files_involved?: string[];
  notes?: string;
}

/**
 * Creates a new work session with its first checkpoint.
 * @returns The new session ID.
 */
export function createWorkSession(db: Database, input: CreateSessionInput): string {
  const id = generateId('sess');
  const now = nowISO();

  const completedJson = JSON.stringify(input.completed_steps ?? []);
  const pendingJson = JSON.stringify(input.pending_steps ?? []);
  const filesJson = JSON.stringify(input.files_involved ?? []);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO work_sessions (
        id, repository_id, session_name, status, task_description,
        current_status, completed_steps, pending_steps, files_involved,
        notes, checkpoints_count, created_at, updated_at
      )
      VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      input.repository_id,
      input.session_name,
      input.task_description,
      input.current_status ?? null,
      completedJson,
      pendingJson,
      filesJson,
      input.notes ?? null,
      now,
      now,
    );

    db.prepare(`
      INSERT INTO work_session_checkpoints (
        session_id, checkpoint_number, current_status,
        completed_steps, pending_steps, files_involved, notes
      )
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.current_status ?? null,
      completedJson,
      pendingJson,
      filesJson,
      input.notes ?? null,
    );
  })();

  return id;
}

export interface UpdateSessionInput {
  current_status?: string;
  completed_steps?: string[];
  pending_steps?: string[];
  files_involved?: string[];
  notes?: string;
  task_description?: string;
}

/**
 * Updates a work session and creates a new checkpoint.
 * @returns The new checkpoint number.
 */
export function updateWorkSession(
  db: Database,
  sessionId: string,
  input: UpdateSessionInput,
): number {
  const session = findWorkSessionById(db, sessionId);
  if (!session) return 0;

  const now = nowISO();
  const newCheckpoint = session.checkpoints_count + 1;

  const completedJson = input.completed_steps
    ? JSON.stringify(input.completed_steps)
    : session.completed_steps;
  const pendingJson = input.pending_steps
    ? JSON.stringify(input.pending_steps)
    : session.pending_steps;
  const filesJson = input.files_involved
    ? JSON.stringify(input.files_involved)
    : session.files_involved;
  const currentStatus = input.current_status ?? session.current_status;
  const notes = input.notes ?? session.notes;
  const taskDescription = input.task_description ?? session.task_description;

  db.transaction(() => {
    db.prepare(`
      UPDATE work_sessions
      SET task_description = ?,
          current_status = ?,
          completed_steps = ?,
          pending_steps = ?,
          files_involved = ?,
          notes = ?,
          checkpoints_count = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      taskDescription,
      currentStatus,
      completedJson,
      pendingJson,
      filesJson,
      notes,
      newCheckpoint,
      now,
      sessionId,
    );

    db.prepare(`
      INSERT INTO work_session_checkpoints (
        session_id, checkpoint_number, current_status,
        completed_steps, pending_steps, files_involved, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      newCheckpoint,
      currentStatus,
      completedJson,
      pendingJson,
      filesJson,
      notes,
    );
  })();

  return newCheckpoint;
}

/** Finds a work session by ID. */
export function findWorkSessionById(db: Database, id: string): WorkSessionRecord | undefined {
  return db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(id) as WorkSessionRecord | undefined;
}

/** Finds an in-progress session by name for a repository. */
export function findActiveSessionByName(
  db: Database,
  repositoryId: string,
  sessionName: string,
): WorkSessionRecord | undefined {
  return db.prepare(`
    SELECT * FROM work_sessions
    WHERE repository_id = ? AND session_name = ? AND status = 'in_progress'
    ORDER BY updated_at DESC LIMIT 1
  `).get(repositoryId, sessionName) as WorkSessionRecord | undefined;
}

/** Lists work sessions for a repository, ordered by most recent first. */
export function listWorkSessions(
  db: Database,
  repositoryId: string,
  status?: WorkSessionStatus,
): WorkSessionRecord[] {
  if (status) {
    return db.prepare(`
      SELECT * FROM work_sessions
      WHERE repository_id = ? AND status = ?
      ORDER BY updated_at DESC
    `).all(repositoryId, status) as WorkSessionRecord[];
  }

  return db.prepare(`
    SELECT * FROM work_sessions
    WHERE repository_id = ?
    ORDER BY updated_at DESC
  `).all(repositoryId) as WorkSessionRecord[];
}

/** Closes a work session by setting status and closed_at. */
export function closeWorkSession(db: Database, sessionId: string): void {
  const now = nowISO();

  db.prepare(`
    UPDATE work_sessions
    SET status = 'completed', closed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now, now, sessionId);
}

/** Retrieves all checkpoints for a session, ordered by number. */
export function getSessionCheckpoints(
  db: Database,
  sessionId: string,
): WorkSessionCheckpointRecord[] {
  return db.prepare(`
    SELECT * FROM work_session_checkpoints
    WHERE session_id = ?
    ORDER BY checkpoint_number ASC
  `).all(sessionId) as WorkSessionCheckpointRecord[];
}
