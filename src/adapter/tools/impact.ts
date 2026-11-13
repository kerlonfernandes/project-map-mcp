/**
 * Tool handler for `impact`.
 *
 * Delegates to the Impact Analysis application service for
 * change propagation analysis through the dependency graph.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { analyzeImpact } from '../../services/impact.js';

interface ImpactArgs {
  entity_id: string;
  change_type?: 'modify' | 'delete' | 'rename';
  max_depth?: number;
  include_tests?: boolean;
  token_budget?: number;
}

export function handleImpact(
  db: Database,
  repositoryId: string,
  args: ImpactArgs,
) {
  const result = analyzeImpact(db, repositoryId, {
    entity_id: args.entity_id,
    change_type: args.change_type ?? 'modify',
    max_depth: args.max_depth ?? 3,
    include_tests: args.include_tests ?? true,
    token_budget: args.token_budget ?? 2000,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
