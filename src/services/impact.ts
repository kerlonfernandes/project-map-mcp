/**
 * Impact Analysis application service.
 *
 * Analyzes the ripple effect of changing an entity by traversing the
 * dependency graph in reverse (who depends on this entity?). Reports
 * directly affected components, indirectly affected ones, related tests,
 * and knowledge records that may need review.
 *
 * Used by: adapter/tools/impact.ts.
 */

import type { Database } from 'better-sqlite3';

import { findEntityById } from '../repository/entities.js';
import { findIncomingEdges } from '../repository/graph.js';
import { findKnowledgeByEntityId } from '../repository/knowledge.js';
import { EntityNotFoundError } from '../shared/errors.js';
import { estimateTokens } from '../shared/utils.js';

interface ImpactInput {
  entity_id: string;
  change_type: 'modify' | 'delete' | 'rename';
  max_depth: number;
  include_tests: boolean;
  token_budget: number;
}

/**
 * Analyzes the impact of changing the specified entity.
 * @throws EntityNotFoundError if the entity doesn't exist.
 */
export function analyzeImpact(
  db: Database,
  _repositoryId: string,
  input: ImpactInput,
): Record<string, unknown> {
  const targetEntity = findEntityById(db, input.entity_id);
  if (!targetEntity) {
    throw new EntityNotFoundError(input.entity_id);
  }

  const directImpact: Array<Record<string, unknown>> = [];
  const indirectImpact: Array<Record<string, unknown>> = [];
  const testsAffected: Array<Record<string, unknown>> = [];
  const knowledgeAffected: Array<Record<string, unknown>> = [];

  // BFS: collect all dependents up to max_depth
  const visited = new Set<string>([input.entity_id]);
  let frontier = [input.entity_id];

  for (let depth = 1; depth <= input.max_depth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const incomingEdges = findIncomingEdges(db, nodeId);

      for (const edge of incomingEdges) {
        if (visited.has(edge.source_id)) continue;
        visited.add(edge.source_id);

        const entity = findEntityById(db, edge.source_id);
        if (!entity) continue;

        const record = {
          id: entity.id,
          name: entity.display_name,
          type: entity.entity_type,
          path: entity.path,
          edge: edge.edge_type,
          weight: edge.weight,
          depth,
        };

        // Classify: test vs direct vs indirect
        if (entity.entity_type === 'test') {
          if (input.include_tests) {
            testsAffected.push(record);
          }
        } else if (depth === 1) {
          directImpact.push(record);
        } else {
          indirectImpact.push(record);
        }

        nextFrontier.push(edge.source_id);
      }
    }

    frontier = nextFrontier;
  }

  // Knowledge affected by this entity
  const knowledge = findKnowledgeByEntityId(db, input.entity_id);
  for (const k of knowledge) {
    knowledgeAffected.push({
      id: k.id,
      type: k.knowledge_type,
      subject: k.subject,
      validity: k.validity,
    });
  }

  const totalAffected =
    directImpact.length + indirectImpact.length + testsAffected.length;

  const summaryParts: string[] = [];
  if (directImpact.length > 0)
    summaryParts.push(`${directImpact.length} direct dependent(s)`);
  if (indirectImpact.length > 0)
    summaryParts.push(`${indirectImpact.length} indirect`);
  if (testsAffected.length > 0)
    summaryParts.push(`${testsAffected.length} test(s)`);
  if (knowledgeAffected.length > 0)
    summaryParts.push(`${knowledgeAffected.length} knowledge record(s)`);

  const response: Record<string, unknown> = {
    target: {
      id: targetEntity.id,
      name: targetEntity.display_name,
      type: targetEntity.entity_type,
    },
    impact: {
      direct: directImpact,
      indirect: indirectImpact,
    },
    summary: `${input.change_type} affects ${summaryParts.join(', ') || 'nothing detected'}.`,
  };

  if (input.include_tests && testsAffected.length > 0) {
    (response.impact as Record<string, unknown>).tests = testsAffected;
  }

  if (knowledgeAffected.length > 0) {
    (response.impact as Record<string, unknown>).knowledge_affected = knowledgeAffected;
  }

  response.meta = {
    depth_reached: input.max_depth,
    entities_affected: totalAffected,
    tokens_used: estimateTokens(JSON.stringify(response)),
  };

  return response;
}
