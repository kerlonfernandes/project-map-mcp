/**
 * Tool handler for `session`.
 *
 * Delegates to the Session Management application service for
 * checkpoint, resume, list, and close operations.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { manageSession } from '../../services/session.js';
import { sanitizeInput } from '../../shared/utils.js';
import type { ProjectMapConfig } from '../../shared/types.js';

interface SessionArgs {
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

export function handleSession(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  args: SessionArgs,
) {
  const result = manageSession(db, repositoryId, config, {
    action: args.action,
    session_name: args.session_name ? sanitizeInput(args.session_name) : undefined,
    task_description: args.task_description ? sanitizeInput(args.task_description) : undefined,
    current_status: args.current_status ? sanitizeInput(args.current_status) : undefined,
    completed_steps: args.completed_steps,
    pending_steps: args.pending_steps,
    files_involved: args.files_involved,
    notes: args.notes ? sanitizeInput(args.notes) : undefined,
    session_id: args.session_id,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
