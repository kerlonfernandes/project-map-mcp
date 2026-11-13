/**
 * Tool handler for `record`.
 *
 * Delegates to the Record Management application service for
 * creating, updating, and validating knowledge records.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { manageRecord } from '../../services/record.js';
import { sanitizeInput } from '../../shared/utils.js';
import type { OndbayConfig } from '../../shared/types.js';

interface RecordArgs {
  action: 'create' | 'update' | 'validate' | 'invalidate' | 'dispute';
  knowledge_type?: string;
  subject?: string;
  content?: string;
  evidence?: Array<{
    path: string;
    line_start?: number;
    line_end?: number;
    excerpt?: string;
    source_kind: string;
  }>;
  entity_ids?: string[];
  knowledge_id?: string;
  validation_status?: string;
  confidence?: number;
}

export function handleRecord(
  db: Database,
  repositoryId: string,
  config: OndbayConfig,
  args: RecordArgs,
) {
  const result = manageRecord(db, repositoryId, config, {
    action: args.action,
    knowledge_type: args.knowledge_type,
    subject: args.subject ? sanitizeInput(args.subject) : undefined,
    content: args.content ? sanitizeInput(args.content) : undefined,
    evidence: args.evidence,
    entity_ids: args.entity_ids,
    knowledge_id: args.knowledge_id,
    validation_status: args.validation_status,
    confidence: args.confidence,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
