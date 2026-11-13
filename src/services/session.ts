/**
 * Session Management application service.
 *
 * Handles work session continuity: checkpoint (save progress),
 * resume (load state), list (find sessions), and close (mark done).
 * Enables AI clients to persist task state across chat sessions.
 *
 * Used by: adapter/tools/session.ts.
 */

import type { Database } from 'better-sqlite3';

import {
  createWorkSession,
  updateWorkSession,
  findWorkSessionById,
  findActiveSessionByName,
  listWorkSessions,
  closeWorkSession,
} from '../repository/sessions.js';
import { logAudit } from '../repository/audit.js';
import { SessionNotFoundError, ValidationError } from '../shared/errors.js';
import { hashParams, sanitizeInput } from '../shared/utils.js';
import type { ProjectMapConfig } from '../shared/types.js';

interface SessionServiceInput {
  action: 'checkpoint' | 'resume' | 'list' | 'close';
  session_name?: string;
  task_description?: string;
  current_status?: string;
  completed_steps?: string[];
  pending_steps?: string[];
  files_involved?: string[];
  notes?: string;
  session_id?: string;
}

/**
 * Routes session operations to the appropriate handler.
 */
export function manageSession(
  db: Database,
  repositoryId: string,
  _config: ProjectMapConfig,
  input: SessionServiceInput,
): Record<string, unknown> {
  const startTime = Date.now();

  switch (input.action) {
    case 'checkpoint':
      return handleCheckpoint(db, repositoryId, input, startTime);
    case 'resume':
      return handleResume(db, repositoryId, input, startTime);
    case 'list':
      return handleList(db, repositoryId, startTime);
    case 'close':
      return handleClose(db, repositoryId, input, startTime);
    default:
      throw new ValidationError(`Unknown session action: ${input.action}`);
  }
}

function handleCheckpoint(
  db: Database,
  repositoryId: string,
  input: SessionServiceInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.session_name || !input.task_description) {
    throw new ValidationError('checkpoint action requires session_name and task_description');
  }

  const sessionName = sanitizeInput(input.session_name);
  const taskDescription = sanitizeInput(input.task_description);

  const existing = findActiveSessionByName(db, repositoryId, sessionName);

  if (existing) {
    const checkpointNumber = updateWorkSession(db, existing.id, {
      task_description: taskDescription,
      current_status: input.current_status ? sanitizeInput(input.current_status) : undefined,
      completed_steps: input.completed_steps,
      pending_steps: input.pending_steps,
      files_involved: input.files_involved,
      notes: input.notes ? sanitizeInput(input.notes) : undefined,
    });

    const durationMs = Date.now() - startTime;

    logAudit(db, {
      operation: 'session_checkpoint_update',
      tool_name: 'session',
      parameters_hash: hashParams({ session_id: existing.id, checkpoint: checkpointNumber }),
      result_summary: `Updated checkpoint #${checkpointNumber} for "${sessionName}"`,
      entities_affected: 0,
      duration_ms: durationMs,
    });

    return {
      session_id: existing.id,
      session_name: sessionName,
      action: 'saved',
      checkpoint_number: checkpointNumber,
      message: `Checkpoint salvo. Use session resume com session_id '${existing.id}' para continuar.`,
      meta: { tokens_used: estimateResponseTokens(existing.id, sessionName), duration_ms: durationMs },
    };
  }

  const sessionId = createWorkSession(db, {
    repository_id: repositoryId,
    session_name: sessionName,
    task_description: taskDescription,
    current_status: input.current_status ? sanitizeInput(input.current_status) : undefined,
    completed_steps: input.completed_steps,
    pending_steps: input.pending_steps,
    files_involved: input.files_involved,
    notes: input.notes ? sanitizeInput(input.notes) : undefined,
  });

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'session_checkpoint_create',
    tool_name: 'session',
    parameters_hash: hashParams({ session_id: sessionId }),
    result_summary: `Created session "${sessionName}" with first checkpoint`,
    entities_affected: 0,
    duration_ms: durationMs,
  });

  return {
    session_id: sessionId,
    session_name: sessionName,
    action: 'saved',
    checkpoint_number: 1,
    message: `Checkpoint salvo. Use session resume com session_id '${sessionId}' para continuar.`,
    meta: { tokens_used: estimateResponseTokens(sessionId, sessionName), duration_ms: durationMs },
  };
}

function handleResume(
  db: Database,
  _repositoryId: string,
  input: SessionServiceInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.session_id) {
    throw new ValidationError('resume action requires session_id');
  }

  const session = findWorkSessionById(db, input.session_id);
  if (!session) {
    throw new SessionNotFoundError(input.session_id);
  }

  const completedSteps = parseJsonArray(session.completed_steps);
  const pendingSteps = parseJsonArray(session.pending_steps);
  const filesInvolved = parseJsonArray(session.files_involved);

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'session_resume',
    tool_name: 'session',
    parameters_hash: hashParams({ session_id: input.session_id }),
    result_summary: `Resumed session "${session.session_name}"`,
    entities_affected: 0,
    duration_ms: durationMs,
  });

  const response: Record<string, unknown> = {
    session_id: session.id,
    session_name: session.session_name,
    status: session.status,
    task_description: session.task_description,
    current_status: session.current_status,
    completed_steps: completedSteps,
    pending_steps: pendingSteps,
    files_involved: filesInvolved,
    notes: session.notes,
    checkpoints_count: session.checkpoints_count,
    last_checkpoint_at: session.updated_at,
    created_at: session.created_at,
    meta: { tokens_used: estimateResumeTokens(session), duration_ms: durationMs },
  };

  return response;
}

function handleList(
  db: Database,
  repositoryId: string,
  startTime: number,
): Record<string, unknown> {
  const sessions = listWorkSessions(db, repositoryId);

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'session_list',
    tool_name: 'session',
    parameters_hash: hashParams({ action: 'list' }),
    result_summary: `Listed ${sessions.length} sessions`,
    entities_affected: 0,
    duration_ms: durationMs,
  });

  return {
    sessions: sessions.map((s) => ({
      session_id: s.id,
      session_name: s.session_name,
      status: s.status,
      task_description: s.task_description,
      pending_steps_count: parseJsonArray(s.pending_steps).length,
      completed_steps_count: parseJsonArray(s.completed_steps).length,
      last_checkpoint_at: s.updated_at,
      created_at: s.created_at,
    })),
    meta: { tokens_used: sessions.length * 40, duration_ms: durationMs },
  };
}

function handleClose(
  db: Database,
  _repositoryId: string,
  input: SessionServiceInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.session_id) {
    throw new ValidationError('close action requires session_id');
  }

  const session = findWorkSessionById(db, input.session_id);
  if (!session) {
    throw new SessionNotFoundError(input.session_id);
  }

  closeWorkSession(db, input.session_id);

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'session_close',
    tool_name: 'session',
    parameters_hash: hashParams({ session_id: input.session_id }),
    result_summary: `Closed session "${session.session_name}"`,
    entities_affected: 0,
    duration_ms: durationMs,
  });

  return {
    session_id: input.session_id,
    session_name: session.session_name,
    action: 'closed',
    message: `Sessão "${session.session_name}" encerrada.`,
    meta: { tokens_used: 30, duration_ms: durationMs },
  };
}

/** Safely parses a JSON array string, returning empty array on failure. */
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function estimateResponseTokens(sessionId: string, sessionName: string): number {
  return Math.ceil((sessionId.length + sessionName.length + 80) / 4);
}

function estimateResumeTokens(session: {
  task_description: string;
  completed_steps: string;
  pending_steps: string;
  notes: string | null;
}): number {
  const totalChars =
    session.task_description.length +
    session.completed_steps.length +
    session.pending_steps.length +
    (session.notes?.length ?? 0) +
    200;
  return Math.ceil(totalChars / 4);
}
