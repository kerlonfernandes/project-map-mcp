/**
 * Tool handler for `graph`.
 *
 * Delegates to the Graph application service for dependency
 * traversal and relationship exploration.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { queryGraph } from '../../services/graph.js';
import type { EdgeType } from '../../shared/types.js';

interface GraphArgs {
  entity_id: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  edge_types?: string[];
  max_depth?: number;
  include_unresolved?: boolean;
  token_budget?: number;
}

export function handleGraph(
  db: Database,
  repositoryId: string,
  args: GraphArgs,
) {
  const result = queryGraph(db, repositoryId, {
    entity_id: args.entity_id,
    direction: args.direction ?? 'both',
    edge_types: args.edge_types as EdgeType[],
    max_depth: args.max_depth ?? 2,
    include_unresolved: args.include_unresolved ?? false,
    token_budget: args.token_budget ?? 1500,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
