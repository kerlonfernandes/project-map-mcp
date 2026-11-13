/**
 * MCP Server adapter — the entry point for AI client communication.
 *
 * This module creates the McpServer instance, registers all six tools
 * with their Zod schemas, and wires each tool to its Application Service.
 * It is a thin adapter: no business logic lives here.
 *
 * The server communicates via STDIO (stdin/stdout JSON-RPC) per the
 * MCP specification.
 *
 * Used by: src/index.ts (the main entry point).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../shared/constants.js';
import { ProjectMapError, ValidationError, RateLimitError } from '../shared/errors.js';
import type { ProjectMapConfig } from '../shared/types.js';

import { handleGetContext } from './tools/get-context.js';
import { handleSearch } from './tools/search.js';
import { handleGraph } from './tools/graph.js';
import { handleImpact } from './tools/impact.js';
import { handleRecord } from './tools/record.js';
import { handleSync } from './tools/sync.js';
import { handleSession } from './tools/session.js';
import { handleExport } from './tools/export.js';

// ──────────────────────────────────────────────────────────────────────
// Rate Limiter (in-memory, per-process)
// ──────────────────────────────────────────────────────────────────────

interface RateLimiterState {
  timestamps: number[];
  maxPerMinute: number;
}

function checkRateLimit(state: RateLimiterState): void {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Remove timestamps older than 1 minute
  state.timestamps = state.timestamps.filter((t) => t > oneMinuteAgo);

  if (state.timestamps.length >= state.maxPerMinute) {
    throw new RateLimitError(state.maxPerMinute);
  }

  state.timestamps.push(now);
}

// ──────────────────────────────────────────────────────────────────────
// Server Setup
// ──────────────────────────────────────────────────────────────────────

export interface ServerDependencies {
  db: Database;
  config: ProjectMapConfig;
  repositoryId: string;
  dbPath?: string;
}

/**
 * Creates the MCP server, registers all tools, and returns it ready
 * to connect to a transport.
 */
export function createMcpServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const rateLimiter: RateLimiterState = {
    timestamps: [],
    maxPerMinute: deps.config.security.rate_limit.max_per_minute,
  };

  /**
   * Wraps a tool handler with rate limiting and error handling.
   * Catches ProjectMapError and returns safe JSON-RPC error responses.
   */
  function withGuards<T>(
    handler: () => T,
  ): T | { content: Array<{ type: 'text'; text: string }>; isError: true } {
    try {
      if (deps.config.security.rate_limit.enabled) {
        checkRateLimit(rateLimiter);
      }
      return handler();
    } catch (error) {
      // SECURITY: return generic messages to clients; log details internally
      if (error instanceof RateLimitError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded. Try again in a moment.' }) }],
          isError: true,
        };
      }
      if (error instanceof ValidationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Validation error: ${error.message}` }) }],
          isError: true,
        };
      }
      if (error instanceof ProjectMapError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, code: error.code }) }],
          isError: true,
        };
      }

      console.error('Unexpected error:', error);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Internal server error' }) }],
        isError: true,
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Tool Registration
  // ────────────────────────────────────────────────────────────────────

  server.tool(
    'get_context',
    'Delivers progressive context about any part of the project — files, classes, modules, routes. Supports depth levels (summary/structure/detail/full), purpose modes (understand/implement/debug/review/plan), and token budgets.',
    {
      target: z.string().describe('Path, entity name, or query (e.g., "src/controllers/", "UserService", "POST /api/users")'),
      depth: z.enum(['summary', 'structure', 'detail', 'full']).optional().describe('Level of detail. Default: structure'),
      purpose: z.enum(['understand', 'implement', 'debug', 'review', 'plan']).optional().describe('Adjusts which content types are prioritized. Default: understand'),
      token_budget: z.number().optional().describe('Maximum tokens in response. Default: 2000'),
      session_id: z.string().optional().describe('For delta responses across repeated queries'),
      include: z.array(z.enum(['knowledge', 'evidence', 'edges', 'conventions', 'gaps'])).optional().describe('Additional content sections to include'),
    },
    (args) => withGuards(() => handleGetContext(deps.db, deps.repositoryId, args)),
  );

  server.tool(
    'search',
    'Full-text and structural search across entities, knowledge records, and evidence. Returns ranked results with explainable scores.',
    {
      query: z.string().describe('Search text or structural pattern'),
      scope: z.enum(['entities', 'knowledge', 'evidence', 'all']).optional().describe('Where to search. Default: all'),
      filters: z.object({
        entity_type: z.string().optional(),
        language: z.string().optional(),
        path_prefix: z.string().optional(),
        knowledge_type: z.string().optional(),
        validation_status: z.string().optional(),
        origin: z.string().optional(),
      }).optional().describe('Narrow results by entity type, language, path, etc.'),
      limit: z.number().optional().describe('Max results. Default: 20'),
      token_budget: z.number().optional().describe('Max tokens in response. Default: 1500'),
    },
    (args) => withGuards(() => handleSearch(deps.db, deps.repositoryId, args)),
  );

  server.tool(
    'graph',
    'Navigates the dependency graph from a starting entity. Shows incoming/outgoing relationships with configurable depth and edge type filters.',
    {
      entity_id: z.string().describe('Starting entity ID'),
      direction: z.enum(['incoming', 'outgoing', 'both']).optional().describe('Traversal direction. Default: both'),
      edge_types: z.array(z.string()).optional().describe('Filter by relationship types (e.g., ["calls", "extends"])'),
      max_depth: z.number().optional().describe('Maximum traversal depth. Default: 2'),
      include_unresolved: z.boolean().optional().describe('Include unresolved edges. Default: false'),
      token_budget: z.number().optional().describe('Max tokens. Default: 1500'),
    },
    (args) => withGuards(() => handleGraph(deps.db, deps.repositoryId, args)),
  );

  server.tool(
    'impact',
    'Analyzes the impact of modifying, deleting, or renaming an entity. Shows affected components, tests, routes, and knowledge records.',
    {
      entity_id: z.string().describe('Entity that will be changed'),
      change_type: z.enum(['modify', 'delete', 'rename']).optional().describe('Type of change. Default: modify'),
      max_depth: z.number().optional().describe('Propagation depth. Default: 3'),
      include_tests: z.boolean().optional().describe('Include affected tests. Default: true'),
      token_budget: z.number().optional().describe('Max tokens. Default: 2000'),
    },
    (args) => withGuards(() => handleImpact(deps.db, deps.repositoryId, args)),
  );

  server.tool(
    'record',
    'Creates, updates, validates, invalidates, or disputes knowledge records. Each record is linked to evidence and entities for traceability.',
    {
      action: z.enum(['create', 'update', 'validate', 'invalidate', 'dispute']).describe('Operation to perform'),
      knowledge_type: z.string().optional().describe('Type: business_rule, architectural_decision, data_flow, api_contract, constraint, pattern, etc.'),
      subject: z.string().optional().describe('Subject entity or area'),
      content: z.string().optional().describe('The assertion/knowledge content'),
      evidence: z.array(z.object({
        path: z.string(),
        line_start: z.number().optional(),
        line_end: z.number().optional(),
        excerpt: z.string().optional(),
        source_kind: z.string(),
      })).optional().describe('Evidence backing the assertion'),
      entity_ids: z.array(z.string()).optional().describe('Linked entity IDs'),
      knowledge_id: z.string().optional().describe('ID of existing record (for update/validate/invalidate/dispute)'),
      validation_status: z.string().optional().describe('New validation status'),
      confidence: z.number().optional().describe('Confidence score 0.0-1.0'),
    },
    (args) => withGuards(() => handleRecord(deps.db, deps.repositoryId, deps.config, args)),
  );

  server.tool(
    'sync',
    'Controls repository synchronization. Actions: status (show current state), incremental (process changes), full (complete re-index), analyze_file (single file), analyze_schema (MySQL).',
    {
      action: z.enum(['status', 'incremental', 'full', 'analyze_file', 'analyze_schema']).describe('Sync operation'),
      path: z.string().optional().describe('File path (for analyze_file)'),
      connection: z.object({
        host: z.string(),
        port: z.number(),
        user: z.string(),
        password: z.string(),
        database: z.string(),
      }).optional().describe('MySQL connection (for analyze_schema)'),
      force: z.boolean().optional().describe('Force re-analysis even without changes. Default: false'),
    },
    (args) => withGuards(() => handleSync(deps.db, deps.repositoryId, deps.config, args)),
  );

  server.tool(
    'session',
    'Manages work session continuity across AI chat sessions. Saves checkpoints of task progress so another AI (or the same one in a new chat) can resume exactly where work left off.',
    {
      action: z.enum(['checkpoint', 'resume', 'list', 'close']).describe('Operation: checkpoint (save progress), resume (load state), list (find sessions), close (mark done)'),
      session_name: z.string().optional().describe('Human-readable session identifier (e.g., "refactoring-auth-module"). Required for checkpoint.'),
      task_description: z.string().optional().describe('Natural language description of the task being worked on. Required for checkpoint.'),
      current_status: z.string().optional().describe('What is being done right now (checkpoint only)'),
      completed_steps: z.array(z.string()).optional().describe('Steps already finished (checkpoint only)'),
      pending_steps: z.array(z.string()).optional().describe('Steps still to do (checkpoint only)'),
      files_involved: z.array(z.string()).optional().describe('Files being modified or analyzed (checkpoint only)'),
      notes: z.string().optional().describe('Free-form notes — decisions made, problems found, relevant context (checkpoint only)'),
      session_id: z.string().optional().describe('Session ID to resume or close (required for resume/close)'),
    },
    (args) => withGuards(() => handleSession(deps.db, deps.repositoryId, deps.config, args)),
  );

  server.tool(
    'export',
    'Manages portable database sharing. Actions: export (create a shareable .pmap.db file), import (load a shared database), list (show available exports). Enables team members to share indexed project knowledge without re-analyzing.',
    {
      action: z.enum(['export', 'import', 'list']).describe('Operation: export (create shareable file), import (load shared DB), list (show exports)'),
      label: z.string().optional().describe('Human-readable label for the export (e.g., "sprint-42-complete"). Used in filename.'),
      path: z.string().optional().describe('Path to the .pmap.db file to import (required for import action)'),
    },
    (args) => withGuards(() => handleExport(deps.db, deps.repositoryId, deps.config, args, deps.dbPath ?? '')),
  );

  return server;
}

/**
 * Starts the MCP server on STDIO transport.
 * This is the main entry point called from src/index.ts.
 */
export async function startServer(deps: ServerDependencies): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
