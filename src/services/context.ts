/**
 * Context Delivery application service.
 *
 * Assembles progressive context responses about any part of the
 * project. Controls what information is included based on depth level,
 * purpose mode, and token budget.
 *
 * The output follows a strict structure with optional sections that
 * are omitted (not sent as empty arrays) to save tokens. When content
 * exceeds the budget, categories are filled by purpose-weight priority
 * and truncated_categories lists what was cut.
 *
 * Used by: adapter/tools/get-context.ts.
 */

import type { Database } from 'better-sqlite3';

import { findEntityByName, findEntitiesByPath, searchEntities } from '../repository/entities.js';
import { findOutgoingEdges, findIncomingEdges } from '../repository/graph.js';
import { findKnowledgeByEntityId } from '../repository/knowledge.js';
import { findEvidenceByPath } from '../repository/evidence.js';
import { findLatestSnapshot } from '../repository/snapshots.js';
import { estimateTokens } from '../shared/utils.js';
import { PURPOSE_WEIGHTS, RESERVED_META_TOKENS } from '../shared/constants.js';
import type { DepthLevel, PurposeMode, EntityRecord } from '../shared/types.js';

interface ContextInput {
  target: string;
  depth: DepthLevel;
  purpose: PurposeMode;
  token_budget: number;
  session_id?: string;
  include?: Array<'knowledge' | 'evidence' | 'edges' | 'conventions' | 'gaps'>;
}

/**
 * Builds a progressive context response for the given target.
 *
 * Resolution order for `target`:
 * 1. Try as a file path — find entities at that path.
 * 2. Try as a qualified name — find entity by name.
 * 3. Try partial match on path and qualified name.
 * 4. Fall back to FTS search.
 */
export function getContext(
  db: Database,
  repositoryId: string,
  input: ContextInput,
): Record<string, unknown> {
  const snapshot = findLatestSnapshot(db, repositoryId);
  if (!snapshot) {
    return {
      error: 'No snapshot available. Run sync first.',
      meta: { tokens_used: 0 },
    };
  }

  const entities = resolveTarget(db, repositoryId, input.target);
  if (entities.length === 0) {
    return {
      error: `Target not found: "${input.target}". Run sync to index the project.`,
      meta: { tokens_used: 0 },
    };
  }

  const primaryEntity = entities[0]!;
  const weights = PURPOSE_WEIGHTS[input.purpose] ?? PURPOSE_WEIGHTS['understand']!;
  const totalBudget = input.token_budget - RESERVED_META_TOKENS;
  const response: Record<string, unknown> = {};
  const truncatedCategories: string[] = [];
  let tokensUsed = 0;

  // ── Target info (always present) ──────────────────────────────────
  response.target = {
    entity_id: primaryEntity.id,
    type: primaryEntity.entity_type,
    path: primaryEntity.path,
    language: primaryEntity.language,
    qualified_name: primaryEntity.qualified_name,
    display_name: primaryEntity.display_name,
  };
  tokensUsed += estimateTokens(JSON.stringify(response.target));

  const remainingBudget = totalBudget - tokensUsed;

  // ── Allocate budget by purpose weights ────────────────────────────
  const budgets: Record<string, number> = {};
  for (const [category, weight] of Object.entries(weights)) {
    budgets[category] = Math.floor(remainingBudget * weight);
  }

  // ── Symbols (depth >= structure) ──────────────────────────────────
  if (input.depth !== 'summary') {
    const symbolBudget = budgets['symbols'] ?? 0;
    const symbols = entities
      .filter((e) => e.entity_type !== 'file' && e.entity_type !== 'directory')
      .map((e) => ({
        id: e.id,
        type: e.entity_type,
        name: e.display_name,
        line_start: e.line_start,
        line_end: e.line_end,
        signature: e.signature,
      }));

    if (symbols.length > 0) {
      const { included, wasTruncated } = fitToBudget(symbols, symbolBudget);
      if (included.length > 0) {
        response.symbols = included;
        tokensUsed += estimateTokens(JSON.stringify(included));
      }
      if (wasTruncated) truncatedCategories.push('symbols');
    }
  }

  // ── Edges (depth >= structure or explicitly requested) ────────────
  const shouldIncludeEdges =
    input.include?.includes('edges') || input.depth !== 'summary';

  if (shouldIncludeEdges) {
    const edgeBudget = budgets['edges'] ?? 0;
    const outgoing = findOutgoingEdges(db, primaryEntity.id);
    const incoming = input.purpose === 'debug' || input.purpose === 'review'
      ? findIncomingEdges(db, primaryEntity.id)
      : [];

    const allEdges = [...outgoing, ...incoming];
    const edgeData = allEdges
      .sort((a, b) => b.weight - a.weight)
      .map((e) => ({
        type: e.edge_type,
        target_id: e.source_id === primaryEntity.id ? e.target_id : e.source_id,
        direction: e.source_id === primaryEntity.id ? 'outgoing' : 'incoming',
        weight: e.weight,
        resolution: e.resolution_status,
      }));

    // For debug purpose, include unresolved edges too
    if (input.purpose === 'debug') {
      const unresolvedOut = findOutgoingEdges(db, primaryEntity.id, undefined, true);
      const unresolved = unresolvedOut.filter(
        (e) => e.resolution_status === 'unresolved' || e.resolution_status === 'ambiguous',
      );
      for (const e of unresolved) {
        if (!edgeData.some((ed) => ed.target_id === e.target_id && ed.type === e.edge_type)) {
          edgeData.push({
            type: e.edge_type,
            target_id: e.target_id,
            direction: 'outgoing',
            weight: e.weight,
            resolution: e.resolution_status,
          });
        }
      }
    }

    if (edgeData.length > 0) {
      const { included, wasTruncated } = fitToBudget(edgeData, edgeBudget);
      if (included.length > 0) {
        response.edges = included;
        tokensUsed += estimateTokens(JSON.stringify(included));
      }
      if (wasTruncated) truncatedCategories.push('edges');
    }
  }

  // ── Knowledge (depth >= detail or explicitly requested) ───────────
  const shouldIncludeKnowledge =
    input.include?.includes('knowledge') ||
    input.depth === 'detail' ||
    input.depth === 'full';

  if (shouldIncludeKnowledge) {
    const knowledgeBudget = budgets['knowledge'] ?? 0;
    const knowledge = findKnowledgeByEntityId(db, primaryEntity.id);

    // For review purpose, include disputed records
    const filtered = input.purpose === 'review'
      ? knowledge
      : knowledge.filter((k) => k.validation_status !== 'disputed');

    const knowledgeData = filtered
      .sort((a, b) => b.confidence - a.confidence)
      .map((k) => ({
        id: k.id,
        type: k.knowledge_type,
        subject: k.subject,
        content: k.content,
        validation_status: k.validation_status,
        confidence: k.confidence,
        origin: k.origin,
      }));

    if (knowledgeData.length > 0) {
      const { included, wasTruncated } = fitToBudget(knowledgeData, knowledgeBudget);
      if (included.length > 0) {
        response.knowledge = included;
        tokensUsed += estimateTokens(JSON.stringify(included));
      }
      if (wasTruncated) truncatedCategories.push('knowledge');
    }
  }

  // ── Evidence (depth >= detail, explicitly requested) ──────────────
  const shouldIncludeEvidence =
    input.include?.includes('evidence') || input.depth === 'full';

  if (shouldIncludeEvidence && primaryEntity.path) {
    const evidence = findEvidenceByPath(db, repositoryId, primaryEntity.path);
    if (evidence.length > 0) {
      const evidenceData = evidence.map((e) => ({
        id: e.id,
        kind: e.source_kind,
        path: e.path,
        line_start: e.line_start,
        line_end: e.line_end,
        excerpt: e.excerpt?.slice(0, 200),
      }));

      const evidenceTokens = estimateTokens(JSON.stringify(evidenceData));
      if (tokensUsed + evidenceTokens < totalBudget) {
        response.evidence = evidenceData;
        tokensUsed += evidenceTokens;
      } else {
        truncatedCategories.push('evidence');
      }
    }
  }

  // ── Conventions (if requested or purpose is understand/plan) ──────
  const shouldIncludeConventions =
    input.include?.includes('conventions') ||
    input.purpose === 'understand' ||
    input.purpose === 'plan';

  if (shouldIncludeConventions) {
    const conventionBudget = budgets['conventions'] ?? 0;
    const conventions = findConventionsForEntity(db, repositoryId, primaryEntity);

    if (conventions.length > 0) {
      const { included, wasTruncated } = fitToBudget(conventions, conventionBudget);
      if (included.length > 0) {
        response.conventions = included;
        tokensUsed += estimateTokens(JSON.stringify(included));
      }
      if (wasTruncated) truncatedCategories.push('conventions');
    }
  }

  // ── Gaps & investigation plan ─────────────────────────────────────
  const shouldIncludeGaps =
    input.include?.includes('gaps') ||
    input.depth === 'detail' ||
    input.depth === 'full';

  if (shouldIncludeGaps) {
    const gapBudget = budgets['gaps'] ?? 0;
    const gaps = detectGaps(db, repositoryId, primaryEntity, entities);

    if (gaps.length > 0) {
      const { included, wasTruncated } = fitToBudget(gaps, gapBudget);
      if (included.length > 0) {
        response.gaps = included;
        tokensUsed += estimateTokens(JSON.stringify(included));
      }
      if (wasTruncated) truncatedCategories.push('gaps');

      // Build investigation plan for high-priority gaps
      if (input.purpose === 'debug' || input.purpose === 'review') {
        const plan = buildInvestigationPlan(included as GapInfo[]);
        if (plan.length > 0) {
          response.investigation_plan = plan;
          tokensUsed += estimateTokens(JSON.stringify(plan));
        }
      }
    }
  }

  // ── Meta (always present) ─────────────────────────────────────────
  response.meta = {
    tokens_used: tokensUsed + RESERVED_META_TOKENS,
    token_budget: input.token_budget,
    depth: input.depth,
    depth_effective: input.depth,
    purpose: input.purpose,
    coverage: 1.0,
    snapshot_id: snapshot.id,
    cached: false,
    truncated_categories: truncatedCategories.length > 0 ? truncatedCategories : undefined,
  };

  return response;
}

// ──────────────────────────────────────────────────────────────────────
// Target resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolves a target string to one or more entities.
 * Tries path → qualified name → partial match → FTS search.
 */
function resolveTarget(
  db: Database,
  repositoryId: string,
  target: string,
): EntityRecord[] {
  const byPath = findEntitiesByPath(db, repositoryId, target);
  if (byPath.length > 0) return byPath;

  const byName = findEntityByName(db, repositoryId, target);
  if (byName) return [byName];

  const partialPath = db
    .prepare('SELECT * FROM entities WHERE repository_id = ? AND path LIKE ? ORDER BY line_start')
    .all(repositoryId, `%${target}%`) as EntityRecord[];
  if (partialPath.length > 0) return partialPath;

  // FTS search fallback
  try {
    const ftsResults = searchEntities(db, `"${target}"`, { repository_id: repositoryId });
    if (ftsResults.length > 0) return ftsResults;
  } catch {
    // FTS query error — return empty
  }

  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Gap detection
// ──────────────────────────────────────────────────────────────────────

interface GapInfo {
  gap: string;
  priority: 'high' | 'medium' | 'low';
  candidates: Array<{ path: string | null; reason: string }>;
}

/**
 * Detects gaps — things the MCP doesn't know about this target.
 * Looks for: unresolved edges, entities without knowledge, missing docs.
 */
function detectGaps(
  db: Database,
  _repositoryId: string,
  primaryEntity: EntityRecord,
  allEntities: EntityRecord[],
): GapInfo[] {
  const gaps: GapInfo[] = [];

  // Gap 1: unresolved outgoing edges
  const unresolvedEdges = findOutgoingEdges(db, primaryEntity.id, undefined, true)
    .filter((e) => e.resolution_status === 'unresolved');

  for (const edge of unresolvedEdges) {
    gaps.push({
      gap: `Unresolved ${edge.edge_type} reference (target_id: ${edge.target_id})`,
      priority: 'medium',
      candidates: [{ path: primaryEntity.path, reason: `Edge declared at this file` }],
    });
  }

  // Gap 2: symbols without any knowledge
  const symbolEntities = allEntities.filter(
    (e) => e.entity_type !== 'file' && e.entity_type !== 'directory',
  );

  for (const entity of symbolEntities) {
    const knowledge = findKnowledgeByEntityId(db, entity.id);
    if (knowledge.length === 0) {
      gaps.push({
        gap: `No knowledge recorded for ${entity.entity_type} "${entity.display_name}"`,
        priority: 'low',
        candidates: [
          { path: entity.path, reason: `Definition at lines ${entity.line_start}-${entity.line_end}` },
        ],
      });
    }
  }

  // Gap 3: stale knowledge (needs_review)
  for (const entity of symbolEntities) {
    const knowledge = findKnowledgeByEntityId(db, entity.id);
    const stale = knowledge.filter((k) => k.validity === 'needs_review');
    for (const k of stale) {
      gaps.push({
        gap: `Knowledge "${k.subject}" needs review after code change`,
        priority: 'high',
        candidates: [
          { path: entity.path, reason: `Evidence may have changed` },
        ],
      });
    }
  }

  return gaps;
}

/**
 * Builds investigation plans from detected gaps.
 */
function buildInvestigationPlan(
  gaps: GapInfo[],
): Array<{ gap: string; priority: string; candidates: Array<{ path: string | null; reason: string }>; suggested_action: string }> {
  return gaps
    .filter((g) => g.priority === 'high' || g.priority === 'medium')
    .slice(0, 5)
    .map((g) => ({
      gap: g.gap,
      priority: g.priority,
      candidates: g.candidates,
      suggested_action: g.priority === 'high'
        ? `Read the referenced file and register findings via tool record`
        : `Investigate the unresolved reference and update via tool record`,
    }));
}

// ──────────────────────────────────────────────────────────────────────
// Conventions lookup
// ──────────────────────────────────────────────────────────────────────

/**
 * Finds conventions that apply to the target entity.
 */
function findConventionsForEntity(
  db: Database,
  repositoryId: string,
  _entity: EntityRecord,
): Array<{ category: string; description: string; confidence: number }> {
  const conventions = db.prepare(`
    SELECT category, description, confidence
    FROM conventions
    WHERE repository_id = ?
    ORDER BY confidence DESC
    LIMIT 10
  `).all(repositoryId) as Array<{ category: string; description: string; confidence: number }>;

  return conventions;
}

// ──────────────────────────────────────────────────────────────────────
// Token budget helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Takes items from an array until the token budget is exhausted.
 * Returns the included items and whether truncation happened.
 */
function fitToBudget<T>(
  items: T[],
  budget: number,
): { included: T[]; wasTruncated: boolean } {
  if (budget <= 0) return { included: [], wasTruncated: items.length > 0 };

  const included: T[] = [];
  let tokensUsed = 0;

  for (const item of items) {
    const itemTokens = estimateTokens(JSON.stringify(item));
    if (tokensUsed + itemTokens > budget) {
      return { included, wasTruncated: true };
    }
    included.push(item);
    tokensUsed += itemTokens;
  }

  return { included, wasTruncated: false };
}
