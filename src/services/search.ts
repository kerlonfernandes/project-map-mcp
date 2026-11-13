/**
 * Search application service.
 *
 * Provides full-text search across entities, knowledge records, and
 * evidence using SQLite FTS5. Results are ranked with explainable
 * score components (text match, graph centrality, recency, confidence).
 *
 * Used by: adapter/tools/search.ts.
 */

import type { Database } from 'better-sqlite3';

import { searchEntities } from '../repository/entities.js';
import { searchKnowledge } from '../repository/knowledge.js';
import { searchEvidence } from '../repository/evidence.js';
import { estimateTokens } from '../shared/utils.js';
import type { EntityType, Language, KnowledgeType, ValidationStatus, KnowledgeOrigin } from '../shared/types.js';

interface SearchInput {
  query: string;
  scope: 'entities' | 'knowledge' | 'evidence' | 'all';
  filters?: Record<string, string | undefined>;
  limit: number;
  token_budget: number;
}

interface SearchResult {
  results: Array<Record<string, unknown>>;
  meta: {
    total_matches: number;
    returned: number;
    tokens_used: number;
  };
}

/**
 * Executes a search across the specified scope.
 * Merges and ranks results from multiple sources when scope is 'all'.
 */
export function search(
  db: Database,
  repositoryId: string,
  input: SearchInput,
): SearchResult {
  const results: Array<Record<string, unknown>> = [];
  let totalMatches = 0;

  // FTS5 query: escape special characters to prevent syntax errors
  const ftsQuery = sanitizeFtsQuery(input.query);

  if (input.scope === 'entities' || input.scope === 'all') {
    const entityResults = searchEntities(db, ftsQuery, {
      repository_id: repositoryId,
      entity_type: input.filters?.entity_type as EntityType | undefined,
      language: input.filters?.language as Language | undefined,
      path_prefix: input.filters?.path_prefix,
    }, input.limit);

    for (const entity of entityResults) {
      results.push({
        type: 'entity',
        entity_id: entity.id,
        entity_type: entity.entity_type,
        name: entity.display_name,
        qualified_name: entity.qualified_name,
        path: entity.path,
        line: entity.line_start,
        score: normalizeRank(entity.rank),
        score_components: {
          text_match: normalizeRank(entity.rank),
        },
      });
    }
    totalMatches += entityResults.length;
  }

  if (input.scope === 'knowledge' || input.scope === 'all') {
    const knowledgeResults = searchKnowledge(db, ftsQuery, {
      repository_id: repositoryId,
      knowledge_type: input.filters?.knowledge_type as KnowledgeType | undefined,
      validation_status: input.filters?.validation_status as ValidationStatus | undefined,
      origin: input.filters?.origin as KnowledgeOrigin | undefined,
    }, input.limit);

    for (const k of knowledgeResults) {
      results.push({
        type: 'knowledge',
        knowledge_id: k.id,
        knowledge_type: k.knowledge_type,
        subject: k.subject,
        content: k.content,
        validation_status: k.validation_status,
        confidence: k.confidence,
        score: normalizeRank(k.rank),
      });
    }
    totalMatches += knowledgeResults.length;
  }

  if (input.scope === 'evidence' || input.scope === 'all') {
    const evidenceResults = searchEvidence(db, ftsQuery, repositoryId, input.limit);

    for (const ev of evidenceResults) {
      results.push({
        type: 'evidence',
        evidence_id: ev.id,
        source_kind: ev.source_kind,
        path: ev.path,
        line_start: ev.line_start,
        excerpt: ev.excerpt?.slice(0, 200),
        score: normalizeRank(ev.rank),
      });
    }
    totalMatches += evidenceResults.length;
  }

  // Sort all results by score descending
  results.sort((a, b) => (b.score as number) - (a.score as number));

  // Apply limit and token budget
  const limited = results.slice(0, input.limit);
  const responseText = JSON.stringify(limited);
  const tokensUsed = estimateTokens(responseText);

  return {
    results: limited,
    meta: {
      total_matches: totalMatches,
      returned: limited.length,
      tokens_used: tokensUsed,
    },
  };
}

/**
 * Sanitizes a query string for FTS5.
 * Wraps terms in quotes to prevent FTS5 syntax errors from special chars.
 */
function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/[^\w\s]/g, ' ')
    .trim();

  // Split into terms and wrap each in quotes for phrase matching
  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '""';

  // Use OR between terms for broader matching
  return terms.map((t) => `"${t}"`).join(' OR ');
}

/**
 * FTS5 rank values are negative (lower = better match).
 * Normalize to 0.0-1.0 scale for consistent scoring.
 */
function normalizeRank(rank: number): number {
  return Math.max(0, Math.min(1, 1 / (1 + Math.abs(rank))));
}
