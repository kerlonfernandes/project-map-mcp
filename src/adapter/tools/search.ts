/**
 * Tool handler for `search`.
 *
 * Delegates to the Search application service for FTS5 queries
 * across entities, knowledge, and evidence.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { search } from '../../services/search.js';
import { sanitizeInput } from '../../shared/utils.js';

interface SearchArgs {
  query: string;
  scope?: 'entities' | 'knowledge' | 'evidence' | 'all';
  filters?: Record<string, string | undefined>;
  limit?: number;
  token_budget?: number;
}

export function handleSearch(
  db: Database,
  repositoryId: string,
  args: SearchArgs,
) {
  const result = search(db, repositoryId, {
    query: sanitizeInput(args.query),
    scope: args.scope ?? 'all',
    filters: args.filters,
    limit: args.limit ?? 20,
    token_budget: args.token_budget ?? 1500,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
