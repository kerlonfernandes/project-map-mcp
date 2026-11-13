/**
 * Tool handler for `get_context`.
 *
 * Thin adapter that validates input and delegates to the Context
 * Delivery application service. Returns MCP-formatted response.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { getContext } from '../../services/context.js';
import { sanitizeInput } from '../../shared/utils.js';

interface GetContextArgs {
  target: string;
  depth?: 'summary' | 'structure' | 'detail' | 'full';
  purpose?: 'understand' | 'implement' | 'debug' | 'review' | 'plan';
  token_budget?: number;
  session_id?: string;
  include?: string[];
}

export function handleGetContext(
  db: Database,
  repositoryId: string,
  args: GetContextArgs,
) {
  const result = getContext(db, repositoryId, {
    target: sanitizeInput(args.target),
    depth: args.depth ?? 'structure',
    purpose: args.purpose ?? 'understand',
    token_budget: args.token_budget ?? 2000,
    session_id: args.session_id,
    include: args.include as Array<'knowledge' | 'evidence' | 'edges' | 'conventions' | 'gaps'>,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
