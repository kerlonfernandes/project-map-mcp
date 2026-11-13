/**
 * Graph query application service.
 *
 * Navigates the dependency graph from a starting entity. Uses BFS
 * traversal with configurable depth, direction, and edge type filters.
 * Returns nodes and edges in a format ready for visualization or analysis.
 *
 * Used by: adapter/tools/graph.ts.
 */

import type { Database } from 'better-sqlite3';

import { findEntityById } from '../repository/entities.js';
import { traverseGraph } from '../repository/graph.js';
import { EntityNotFoundError } from '../shared/errors.js';
import { estimateTokens } from '../shared/utils.js';
import type { EdgeType } from '../shared/types.js';

interface GraphQueryInput {
  entity_id: string;
  direction: 'incoming' | 'outgoing' | 'both';
  edge_types?: EdgeType[];
  max_depth: number;
  include_unresolved: boolean;
  token_budget: number;
}

/**
 * Queries the relationship graph starting from an entity.
 * @throws EntityNotFoundError if the starting entity doesn't exist.
 */
export function queryGraph(
  db: Database,
  _repositoryId: string,
  input: GraphQueryInput,
): Record<string, unknown> {
  const rootEntity = findEntityById(db, input.entity_id);
  if (!rootEntity) {
    throw new EntityNotFoundError(input.entity_id);
  }

  const { nodeIds, edges } = traverseGraph(
    db,
    input.entity_id,
    input.direction,
    input.max_depth,
    input.edge_types,
    input.include_unresolved,
  );

  // Fetch entity details for all discovered nodes
  const nodes: Array<Record<string, unknown>> = [];
  for (const nodeId of nodeIds) {
    if (nodeId === input.entity_id) continue;

    const entity = findEntityById(db, nodeId);
    if (entity) {
      nodes.push({
        id: entity.id,
        name: entity.display_name,
        type: entity.entity_type,
        path: entity.path,
      });
    }
  }

  const edgeData = edges.map((e) => ({
    source: e.source_id,
    target: e.target_id,
    type: e.edge_type,
    weight: e.weight,
    resolution: e.resolution_status,
  }));

  const response = {
    root: {
      id: rootEntity.id,
      name: rootEntity.display_name,
      type: rootEntity.entity_type,
    },
    nodes,
    edges: edgeData,
    meta: {
      depth_reached: input.max_depth,
      nodes_total: nodeIds.size,
      edges_total: edges.length,
      tokens_used: 0,
    },
  };

  response.meta.tokens_used = estimateTokens(JSON.stringify(response));

  return response;
}
