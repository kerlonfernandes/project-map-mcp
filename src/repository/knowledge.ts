/**
 * Repository for knowledge record persistence and queries.
 *
 * Knowledge records are assertions about the project — business rules,
 * architectural decisions, patterns — each backed by evidence. This
 * module handles CRUD, versioning (supersedes), and FTS search.
 *
 * The Knowledge Manager (domain layer) owns the business logic around
 * validation and deduplication; this module just persists.
 *
 * Used by: Knowledge Manager (domain/knowledge.ts).
 */

import type { Database } from 'better-sqlite3';

import type {
  KnowledgeRecord,
  KnowledgeType,
  KnowledgeOrigin,
  ValidationStatus,
  ValidityState,
} from '../shared/types.js';
import { generateId, nowISO } from '../shared/utils.js';

export interface CreateKnowledgeInput {
  repository_id: string;
  subject: string;
  knowledge_type: KnowledgeType;
  content: string;
  origin: KnowledgeOrigin;
  validation_status?: ValidationStatus;
  confidence?: number;
  snapshot_id?: string;
  supersedes_id?: string;
}

/**
 * Creates a new knowledge record.
 * @returns The new knowledge ID.
 */
export function createKnowledge(db: Database, input: CreateKnowledgeInput): string {
  const id = generateId('k');

  db.prepare(`
    INSERT INTO knowledge (
      id, repository_id, subject, knowledge_type, content, origin,
      validation_status, confidence, snapshot_id, supersedes_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.repository_id,
    input.subject,
    input.knowledge_type,
    input.content,
    input.origin,
    input.validation_status ?? 'unverified',
    input.confidence ?? 0.5,
    input.snapshot_id ?? null,
    input.supersedes_id ?? null,
  );

  // If superseding, mark old record
  if (input.supersedes_id) {
    db.prepare(`
      UPDATE knowledge
      SET validation_status = 'superseded', validity = 'archived'
      WHERE id = ?
    `).run(input.supersedes_id);
  }

  return id;
}

/** Finds a knowledge record by its primary ID. */
export function findKnowledgeById(db: Database, id: string): KnowledgeRecord | undefined {
  return db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as
    | KnowledgeRecord
    | undefined;
}

/** Finds all current (non-archived) knowledge for a repository. */
export function findCurrentKnowledge(
  db: Database,
  repositoryId: string,
  knowledgeType?: KnowledgeType,
): KnowledgeRecord[] {
  let sql = `SELECT * FROM knowledge WHERE repository_id = ? AND validity != 'archived'`;
  const params: unknown[] = [repositoryId];

  if (knowledgeType) {
    sql += ' AND knowledge_type = ?';
    params.push(knowledgeType);
  }

  sql += ' ORDER BY confidence DESC, created_at DESC';
  return db.prepare(sql).all(...params) as KnowledgeRecord[];
}

/** Finds knowledge records linked to specific entities. */
export function findKnowledgeByEntityId(
  db: Database,
  entityId: string,
): KnowledgeRecord[] {
  return db.prepare(`
    SELECT k.*
    FROM knowledge k
    JOIN knowledge_entities ke ON ke.knowledge_id = k.id
    WHERE ke.entity_id = ?
      AND k.validity != 'archived'
    ORDER BY k.confidence DESC
  `).all(entityId) as KnowledgeRecord[];
}

/** Links a knowledge record to an entity (M:N junction). */
export function linkKnowledgeToEntity(
  db: Database,
  knowledgeId: string,
  entityId: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_entities (knowledge_id, entity_id)
    VALUES (?, ?)
  `).run(knowledgeId, entityId);
}

/** Links a knowledge record to an evidence record (M:N junction). */
export function linkKnowledgeToEvidence(
  db: Database,
  knowledgeId: string,
  evidenceId: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_evidence (knowledge_id, evidence_id)
    VALUES (?, ?)
  `).run(knowledgeId, evidenceId);
}

/**
 * Updates the validation status and validity of a knowledge record.
 * Also updates the validated_at timestamp.
 */
export function updateKnowledgeStatus(
  db: Database,
  id: string,
  validationStatus: ValidationStatus,
  validity?: ValidityState,
): void {
  const validatedAt = nowISO();

  if (validity) {
    db.prepare(`
      UPDATE knowledge
      SET validation_status = ?, validity = ?, validated_at = ?
      WHERE id = ?
    `).run(validationStatus, validity, validatedAt, id);
  } else {
    db.prepare(`
      UPDATE knowledge
      SET validation_status = ?, validated_at = ?
      WHERE id = ?
    `).run(validationStatus, validatedAt, id);
  }
}

/**
 * Marks knowledge records as needs_review when their evidence changes.
 * @param evidenceIds - IDs of evidence records that changed.
 * @returns Number of knowledge records affected.
 */
export function markKnowledgeStaleByEvidence(
  db: Database,
  evidenceIds: string[],
): number {
  if (evidenceIds.length === 0) return 0;

  const placeholders = evidenceIds.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE knowledge
    SET validity = 'needs_review'
    WHERE id IN (
      SELECT ke.knowledge_id
      FROM knowledge_evidence ke
      WHERE ke.evidence_id IN (${placeholders})
    )
    AND validity = 'current'
  `).run(...evidenceIds);

  return result.changes;
}

/** Full-text search on knowledge subject and content. */
export function searchKnowledge(
  db: Database,
  query: string,
  filters?: {
    repository_id?: string;
    knowledge_type?: KnowledgeType;
    validation_status?: ValidationStatus;
    origin?: KnowledgeOrigin;
  },
  limit: number = 20,
): Array<KnowledgeRecord & { rank: number }> {
  let sql = `
    SELECT k.*, fts.rank
    FROM knowledge_fts fts
    JOIN knowledge k ON k.rowid = fts.rowid
    WHERE knowledge_fts MATCH ?
      AND k.validity != 'archived'
  `;
  const params: unknown[] = [query];

  if (filters?.repository_id) {
    sql += ' AND k.repository_id = ?';
    params.push(filters.repository_id);
  }
  if (filters?.knowledge_type) {
    sql += ' AND k.knowledge_type = ?';
    params.push(filters.knowledge_type);
  }
  if (filters?.validation_status) {
    sql += ' AND k.validation_status = ?';
    params.push(filters.validation_status);
  }
  if (filters?.origin) {
    sql += ' AND k.origin = ?';
    params.push(filters.origin);
  }

  sql += ' ORDER BY fts.rank LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<KnowledgeRecord & { rank: number }>;
}

/** Counts knowledge records by validity state. */
export function countKnowledgeByValidity(
  db: Database,
  repositoryId: string,
): Record<string, number> {
  const rows = db.prepare(`
    SELECT validity, COUNT(*) as count
    FROM knowledge
    WHERE repository_id = ?
    GROUP BY validity
  `).all(repositoryId) as Array<{ validity: string; count: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.validity] = row.count;
  }
  return result;
}
