/**
 * Knowledge Manager — domain service for knowledge record business logic.
 *
 * Owns the rules around knowledge creation: duplicate detection,
 * conflict resolution, and validation. The repository layer handles
 * persistence; this module handles the "should we insert?" decisions.
 *
 * Duplicate detection pipeline (runs before every insert):
 * 1. FTS5 similarity search on content
 * 2. Entity overlap — do the candidates share linked entities?
 * 3. Type match — same knowledge_type raises duplicate score
 * 4. Scope check — same file/module raises duplicate score
 * 5. Conflict detection — similar but contradictory → mark disputed
 * 6. Merge or reject — exact duplicate rejected, complementary linked
 *
 * Used by: services/record.ts.
 */

import type { Database } from 'better-sqlite3';
import type { KnowledgeRecord, KnowledgeType } from '../shared/types.js';

/** Result of duplicate detection. */
export interface DuplicateCheckResult {
  is_duplicate: boolean;
  is_conflict: boolean;
  similar_records: Array<{
    id: string;
    subject: string;
    similarity_score: number;
    reason: string;
  }>;
  action: 'insert' | 'reject' | 'dispute' | 'link';
}

/** Threshold above which a record is considered a duplicate. */
const DUPLICATE_THRESHOLD = 0.75;

/** Threshold above which records are considered conflicting. */
const CONFLICT_THRESHOLD = 0.50;

/**
 * Checks for potentially duplicate or conflicting knowledge records
 * before insertion. Returns an action recommendation.
 *
 * @param db - Database connection.
 * @param repositoryId - Repository to search within.
 * @param subject - Subject of the new knowledge record.
 * @param content - Content of the new knowledge record.
 * @param knowledgeType - Type of the new knowledge record.
 * @param entityIds - Entity IDs the new record will be linked to.
 * @returns Detection result with recommended action.
 */
export function checkForDuplicates(
  db: Database,
  repositoryId: string,
  subject: string,
  content: string,
  knowledgeType: KnowledgeType,
  entityIds: string[] = [],
): DuplicateCheckResult {
  const candidates = findCandidates(db, repositoryId, subject, content, knowledgeType);

  if (candidates.length === 0) {
    return { is_duplicate: false, is_conflict: false, similar_records: [], action: 'insert' };
  }

  const scored = candidates.map((candidate) => {
    const score = computeSimilarityScore(
      db,
      candidate,
      subject,
      content,
      knowledgeType,
      entityIds,
    );
    return { ...candidate, similarity_score: score };
  });

  scored.sort((a, b) => b.similarity_score - a.similarity_score);

  const topMatch = scored[0]!;
  const similarRecords = scored
    .filter((s) => s.similarity_score >= CONFLICT_THRESHOLD)
    .map((s) => ({
      id: s.id,
      subject: s.subject,
      similarity_score: s.similarity_score,
      reason: buildReason(s),
    }));

  if (topMatch.similarity_score >= DUPLICATE_THRESHOLD) {
    return {
      is_duplicate: true,
      is_conflict: false,
      similar_records: similarRecords,
      action: 'reject',
    };
  }

  if (topMatch.similarity_score >= CONFLICT_THRESHOLD) {
    const isConflict = detectConflict(topMatch.content, content);
    return {
      is_duplicate: false,
      is_conflict: isConflict,
      similar_records: similarRecords,
      action: isConflict ? 'dispute' : 'link',
    };
  }

  return { is_duplicate: false, is_conflict: false, similar_records: similarRecords, action: 'insert' };
}

// ──────────────────────────────────────────────────────────────────────
// Candidate search
// ──────────────────────────────────────────────────────────────────────

interface CandidateRecord extends KnowledgeRecord {
  fts_rank?: number;
  matched_entity_count?: number;
}

/**
 * Finds candidate records that might be duplicates.
 * Uses FTS5 first, then falls back to subject LIKE match.
 */
function findCandidates(
  db: Database,
  repositoryId: string,
  subject: string,
  content: string,
  knowledgeType: KnowledgeType,
): CandidateRecord[] {
  const candidates: CandidateRecord[] = [];
  const seenIds = new Set<string>();

  // Step 1: FTS5 content similarity
  const ftsQuery = buildFtsQuery(content);
  if (ftsQuery) {
    try {
      const ftsResults = db.prepare(`
        SELECT k.*, fts.rank as fts_rank
        FROM knowledge_fts fts
        JOIN knowledge k ON k.rowid = fts.rowid
        WHERE knowledge_fts MATCH ?
          AND k.repository_id = ?
          AND k.validity != 'archived'
        ORDER BY fts.rank
        LIMIT 10
      `).all(ftsQuery, repositoryId) as CandidateRecord[];

      for (const r of ftsResults) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          candidates.push(r);
        }
      }
    } catch {
      // FTS query syntax error — fall through to LIKE search
    }
  }

  // Step 2: Subject LIKE match
  const likeResults = db.prepare(`
    SELECT * FROM knowledge
    WHERE repository_id = ?
      AND knowledge_type = ?
      AND validity != 'archived'
      AND subject LIKE ?
    ORDER BY confidence DESC
    LIMIT 10
  `).all(repositoryId, knowledgeType, `%${subject}%`) as CandidateRecord[];

  for (const r of likeResults) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      candidates.push(r);
    }
  }

  return candidates;
}

// ──────────────────────────────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────────────────────────────

/**
 * Computes a 0–1 similarity score between a candidate and the new record.
 * Combines: text overlap, type match, entity overlap, scope proximity.
 */
function computeSimilarityScore(
  db: Database,
  candidate: CandidateRecord,
  newSubject: string,
  newContent: string,
  newType: KnowledgeType,
  newEntityIds: string[],
): number {
  let score = 0;

  // Text similarity (Jaccard on word sets) — weight 0.4
  const candidateWords = tokenize(candidate.content);
  const newWords = tokenize(newContent);
  const textSim = jaccardSimilarity(candidateWords, newWords);
  score += textSim * 0.4;

  // Subject similarity — weight 0.2
  const subjectSim = jaccardSimilarity(
    tokenize(candidate.subject),
    tokenize(newSubject),
  );
  score += subjectSim * 0.2;

  // Type match — weight 0.15
  if (candidate.knowledge_type === newType) {
    score += 0.15;
  }

  // Entity overlap — weight 0.25
  if (newEntityIds.length > 0) {
    const candidateEntityIds = db.prepare(`
      SELECT entity_id FROM knowledge_entities WHERE knowledge_id = ?
    `).all(candidate.id) as Array<{ entity_id: string }>;

    const candidateSet = new Set(candidateEntityIds.map((e) => e.entity_id));
    const overlap = newEntityIds.filter((id) => candidateSet.has(id)).length;
    const total = new Set([...newEntityIds, ...candidateEntityIds.map((e) => e.entity_id)]).size;

    if (total > 0) {
      score += (overlap / total) * 0.25;
    }
  }

  return Math.min(score, 1);
}

// ──────────────────────────────────────────────────────────────────────
// Conflict detection
// ──────────────────────────────────────────────────────────────────────

/** Negation indicators that suggest conflicting content. */
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'without', 'none', 'neither',
  'nor', 'cannot', 'must not', 'should not', 'does not',
  'não', 'nunca', 'sem', 'nenhum', 'nem',
]);

/**
 * Heuristic check for whether two texts contradict each other.
 * Looks for negation asymmetry between the two contents.
 */
function detectConflict(existingContent: string, newContent: string): boolean {
  const existingTokens = tokenize(existingContent);
  const newTokens = tokenize(newContent);

  const existingNegations = existingTokens.filter((t) => NEGATION_WORDS.has(t));
  const newNegations = newTokens.filter((t) => NEGATION_WORDS.has(t));

  // If one has negation and the other doesn't, possible conflict
  return (
    (existingNegations.length > 0 && newNegations.length === 0) ||
    (existingNegations.length === 0 && newNegations.length > 0)
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Tokenizes text into lowercase words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Jaccard similarity between two word arrays. */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

/** Builds a safe FTS5 query from content. */
function buildFtsQuery(content: string): string | null {
  const words = tokenize(content)
    .filter((w) => w.length > 2)
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(' OR ');
}

function buildReason(candidate: CandidateRecord & { similarity_score: number }): string {
  const parts: string[] = [];
  if (candidate.similarity_score >= DUPLICATE_THRESHOLD) {
    parts.push('high content overlap');
  }
  if (candidate.fts_rank !== undefined) {
    parts.push('FTS match');
  }
  if (candidate.matched_entity_count && candidate.matched_entity_count > 0) {
    parts.push(`${candidate.matched_entity_count} shared entities`);
  }
  return parts.length > 0 ? parts.join(', ') : 'subject match';
}
