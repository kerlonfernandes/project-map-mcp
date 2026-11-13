/**
 * Record Management application service.
 *
 * Handles CRUD operations on knowledge records: create, update,
 * validate, invalidate, and dispute. Each operation creates audit
 * entries and manages the evidence linkage chain.
 *
 * Used by: adapter/tools/record.ts.
 */

import type { Database } from 'better-sqlite3';

import {
  createKnowledge,
  findKnowledgeById,
  updateKnowledgeStatus,
  linkKnowledgeToEntity,
  linkKnowledgeToEvidence,
} from '../repository/knowledge.js';
import { createEvidence } from '../repository/evidence.js';
import { findLatestSnapshot } from '../repository/snapshots.js';
import { logAudit } from '../repository/audit.js';
import { checkForDuplicates } from '../domain/knowledge.js';
import { KnowledgeNotFoundError, ValidationError } from '../shared/errors.js';
import { hashParams } from '../shared/utils.js';
import type { ProjectMapConfig, KnowledgeType, KnowledgeOrigin, ValidationStatus, SourceKind } from '../shared/types.js';
import {
  writeKnowledgeFile,
  removeKnowledgeFile,
  getEvidenceForKnowledge,
  getEntityNamesForKnowledge,
} from './knowledge-files.js';

interface RecordInput {
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

/**
 * Routes record operations to the appropriate handler.
 */
export function manageRecord(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
): Record<string, unknown> {
  const startTime = Date.now();

  switch (input.action) {
    case 'create':
      return handleCreate(db, repositoryId, config, input, startTime);
    case 'update':
      return handleUpdate(db, repositoryId, config, input, startTime);
    case 'validate':
      return handleValidate(db, repositoryId, config, input, startTime);
    case 'invalidate':
      return handleInvalidate(db, repositoryId, config, input, startTime);
    case 'dispute':
      return handleDispute(db, repositoryId, config, input, startTime);
    default:
      throw new ValidationError(`Unknown record action: ${input.action}`);
  }
}

function handleCreate(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.knowledge_type || !input.subject || !input.content) {
    throw new ValidationError('create action requires knowledge_type, subject, and content');
  }

  // Duplicate detection before insert
  const duplicateCheck = checkForDuplicates(
    db,
    repositoryId,
    input.subject,
    input.content,
    input.knowledge_type as KnowledgeType,
    input.entity_ids ?? [],
  );

  if (duplicateCheck.action === 'reject') {
    logAudit(db, {
      operation: 'knowledge_duplicate_rejected',
      tool_name: 'record',
      parameters_hash: hashParams(input),
      result_summary: `Duplicate rejected: similar to ${duplicateCheck.similar_records[0]?.id}`,
      entities_affected: 0,
      duration_ms: Date.now() - startTime,
    });

    return {
      action: 'rejected',
      reason: 'duplicate',
      duplicate_check: duplicateCheck,
      meta: { tokens_used: 0 },
    };
  }

  if (duplicateCheck.action === 'dispute') {
    // Mark existing conflicting records as disputed
    for (const similar of duplicateCheck.similar_records) {
      if (similar.similarity_score >= 0.5) {
        updateKnowledgeStatus(db, similar.id, 'disputed');
      }
    }
  }

  const snapshot = findLatestSnapshot(db, repositoryId);

  const result = db.transaction(() => {
    // Create the knowledge record
    const knowledgeId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: input.subject!,
      knowledge_type: input.knowledge_type as KnowledgeType,
      content: input.content!,
      origin: 'ai_generated' as KnowledgeOrigin,
      validation_status: input.evidence ? 'supported_by_code' : 'unverified',
      confidence: input.confidence ?? 0.5,
      snapshot_id: snapshot?.id,
    });

    // Create and link evidence
    const evidenceIds: string[] = [];
    if (input.evidence) {
      for (const ev of input.evidence) {
        const evidenceId = createEvidence(db, {
          repository_id: repositoryId,
          source_kind: ev.source_kind as SourceKind,
          path: ev.path,
          line_start: ev.line_start,
          line_end: ev.line_end,
          excerpt: ev.excerpt,
          snapshot_id: snapshot?.id,
        });
        linkKnowledgeToEvidence(db, knowledgeId, evidenceId);
        evidenceIds.push(evidenceId);
      }
    }

    // Link to entities
    if (input.entity_ids) {
      for (const entityId of input.entity_ids) {
        linkKnowledgeToEntity(db, knowledgeId, entityId);
      }
    }

    return { knowledgeId, evidenceIds };
  })();

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'knowledge_create',
    tool_name: 'record',
    parameters_hash: hashParams(input),
    result_summary: `Created ${input.knowledge_type}: "${input.subject}"`,
    entities_affected: (input.entity_ids?.length ?? 0) + 1,
    duration_ms: durationMs,
  });

  // Write-through to versionable knowledge file
  writeKnowledgeFileForRecord(db, config, result.knowledgeId);

  return {
    knowledge_id: result.knowledgeId,
    action: 'created',
    evidence_ids: result.evidenceIds,
    validation_status: input.evidence ? 'supported_by_code' : 'unverified',
    duplicate_check: duplicateCheck.similar_records.length > 0 ? duplicateCheck : undefined,
    meta: { tokens_used: 0 },
  };
}

function handleUpdate(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.knowledge_id) {
    throw new ValidationError('update action requires knowledge_id');
  }

  const existing = findKnowledgeById(db, input.knowledge_id);
  if (!existing) {
    throw new KnowledgeNotFoundError(input.knowledge_id);
  }

  const snapshot = findLatestSnapshot(db, repositoryId);

  // Create new version that supersedes the old one
  const newId = createKnowledge(db, {
    repository_id: repositoryId,
    subject: input.subject ?? existing.subject,
    knowledge_type: (input.knowledge_type as KnowledgeType) ?? existing.knowledge_type,
    content: input.content ?? existing.content,
    origin: existing.origin,
    validation_status: input.validation_status as ValidationStatus ?? existing.validation_status,
    confidence: input.confidence ?? existing.confidence,
    snapshot_id: snapshot?.id,
    supersedes_id: input.knowledge_id,
  });

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'knowledge_update',
    tool_name: 'record',
    parameters_hash: hashParams(input),
    result_summary: `Updated ${existing.knowledge_type}: supersedes ${input.knowledge_id}`,
    entities_affected: 1,
    duration_ms: durationMs,
  });

  // Write-through: write new version, remove old version's file
  writeKnowledgeFileForRecord(db, config, newId);
  removeKnowledgeFile(config.project.root, existing.knowledge_type, existing.subject, existing.id);

  return {
    knowledge_id: newId,
    action: 'updated',
    supersedes_id: input.knowledge_id,
    meta: { tokens_used: 0 },
  };
}

function handleValidate(
  db: Database,
  _repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.knowledge_id) {
    throw new ValidationError('validate action requires knowledge_id');
  }

  const existing = findKnowledgeById(db, input.knowledge_id);
  if (!existing) {
    throw new KnowledgeNotFoundError(input.knowledge_id);
  }

  const newStatus = (input.validation_status as ValidationStatus) ?? 'human_confirmed';
  updateKnowledgeStatus(db, input.knowledge_id, newStatus, 'current');

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'knowledge_validate',
    tool_name: 'record',
    parameters_hash: hashParams(input),
    result_summary: `Validated ${input.knowledge_id} as ${newStatus}`,
    entities_affected: 1,
    duration_ms: durationMs,
  });

  writeKnowledgeFileForRecord(db, config, input.knowledge_id);

  return {
    knowledge_id: input.knowledge_id,
    action: 'validated',
    validation_status: newStatus,
    meta: { tokens_used: 0 },
  };
}

function handleInvalidate(
  db: Database,
  _repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.knowledge_id) {
    throw new ValidationError('invalidate action requires knowledge_id');
  }

  const existing = findKnowledgeById(db, input.knowledge_id);
  if (!existing) {
    throw new KnowledgeNotFoundError(input.knowledge_id);
  }

  updateKnowledgeStatus(db, input.knowledge_id, 'invalidated', 'archived');

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'knowledge_invalidate',
    tool_name: 'record',
    parameters_hash: hashParams(input),
    result_summary: `Invalidated ${input.knowledge_id}`,
    entities_affected: 1,
    duration_ms: durationMs,
  });

  removeKnowledgeFile(config.project.root, existing.knowledge_type, existing.subject, existing.id);

  return {
    knowledge_id: input.knowledge_id,
    action: 'invalidated',
    meta: { tokens_used: 0 },
  };
}

function handleDispute(
  db: Database,
  _repositoryId: string,
  config: ProjectMapConfig,
  input: RecordInput,
  startTime: number,
): Record<string, unknown> {
  if (!input.knowledge_id) {
    throw new ValidationError('dispute action requires knowledge_id');
  }

  const existing = findKnowledgeById(db, input.knowledge_id);
  if (!existing) {
    throw new KnowledgeNotFoundError(input.knowledge_id);
  }

  updateKnowledgeStatus(db, input.knowledge_id, 'disputed');

  const durationMs = Date.now() - startTime;

  logAudit(db, {
    operation: 'knowledge_dispute',
    tool_name: 'record',
    parameters_hash: hashParams(input),
    result_summary: `Disputed ${input.knowledge_id}`,
    entities_affected: 1,
    duration_ms: durationMs,
  });

  writeKnowledgeFileForRecord(db, config, input.knowledge_id);

  return {
    knowledge_id: input.knowledge_id,
    action: 'disputed',
    meta: { tokens_used: 0 },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Versionable Knowledge Write-Through
// ──────────────────────────────────────────────────────────────────────

/**
 * Writes the current state of a knowledge record to its Markdown file.
 * Silently skips on I/O errors to avoid breaking record operations.
 */
function writeKnowledgeFileForRecord(
  db: Database,
  config: ProjectMapConfig,
  knowledgeId: string,
): void {
  try {
    const record = findKnowledgeById(db, knowledgeId);
    if (!record) return;

    const evidence = getEvidenceForKnowledge(db, knowledgeId);
    const entityNames = getEntityNamesForKnowledge(db, knowledgeId);
    writeKnowledgeFile(config.project.root, record, evidence, entityNames);
  } catch {
    // Write-through is best-effort — DB is the runtime source of truth
  }
}
