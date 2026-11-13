/**
 * Zod validation schemas for all MCP tool inputs.
 *
 * Every tool parameter is validated here before reaching Application Services.
 * This is the first line of defense against malformed input from clients.
 *
 * Used by: adapter/tools/ handlers.
 */

import { z } from 'zod';
import {
  ENTITY_TYPES,
  LANGUAGES,
  EDGE_TYPES,
  KNOWLEDGE_TYPES,
  KNOWLEDGE_ORIGINS,
  VALIDATION_STATUSES,
  SOURCE_KINDS,
  DEPTH_LEVELS,
  PURPOSE_MODES,
} from './types.js';
import {
  MAX_TARGET_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_TOKEN_BUDGET,
  MAX_GRAPH_DEPTH,
  MAX_SEARCH_LIMIT,
} from './constants.js';

// ──────────────────────────────────────────────────────────────────────
// get_context
// ──────────────────────────────────────────────────────────────────────

export const GetContextSchema = z.object({
  target: z.string().min(1).max(MAX_TARGET_LENGTH),
  depth: z.enum(DEPTH_LEVELS).optional(),
  purpose: z.enum(PURPOSE_MODES).optional(),
  token_budget: z.number().int().positive().max(MAX_TOKEN_BUDGET).optional(),
  session_id: z.string().max(100).optional(),
  include: z
    .array(z.enum(['knowledge', 'evidence', 'edges', 'conventions', 'gaps']))
    .optional(),
});

// ──────────────────────────────────────────────────────────────────────
// search
// ──────────────────────────────────────────────────────────────────────

export const SearchSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  scope: z.enum(['entities', 'knowledge', 'evidence', 'all']).optional(),
  filters: z
    .object({
      entity_type: z.enum(ENTITY_TYPES).optional(),
      language: z.enum(LANGUAGES).optional(),
      path_prefix: z.string().max(MAX_TARGET_LENGTH).optional(),
      knowledge_type: z.enum(KNOWLEDGE_TYPES).optional(),
      validation_status: z.enum(VALIDATION_STATUSES).optional(),
      origin: z.enum(KNOWLEDGE_ORIGINS).optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
  token_budget: z.number().int().positive().max(MAX_TOKEN_BUDGET).optional(),
});

// ──────────────────────────────────────────────────────────────────────
// graph
// ──────────────────────────────────────────────────────────────────────

export const GraphSchema = z.object({
  entity_id: z.string().min(1).max(50),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
  edge_types: z.array(z.enum(EDGE_TYPES)).optional(),
  max_depth: z.number().int().positive().max(MAX_GRAPH_DEPTH).optional(),
  include_unresolved: z.boolean().optional(),
  token_budget: z.number().int().positive().max(MAX_TOKEN_BUDGET).optional(),
});

// ──────────────────────────────────────────────────────────────────────
// impact
// ──────────────────────────────────────────────────────────────────────

export const ImpactSchema = z.object({
  entity_id: z.string().min(1).max(50),
  change_type: z.enum(['modify', 'delete', 'rename']).optional(),
  max_depth: z.number().int().positive().max(MAX_GRAPH_DEPTH).optional(),
  include_tests: z.boolean().optional(),
  token_budget: z.number().int().positive().max(MAX_TOKEN_BUDGET).optional(),
});

// ──────────────────────────────────────────────────────────────────────
// record
// ──────────────────────────────────────────────────────────────────────

const EvidenceInputSchema = z.object({
  path: z.string().min(1).max(MAX_TARGET_LENGTH),
  line_start: z.number().int().nonnegative().optional(),
  line_end: z.number().int().nonnegative().optional(),
  excerpt: z.string().max(MAX_CONTENT_LENGTH).optional(),
  source_kind: z.enum(SOURCE_KINDS),
});

export const RecordSchema = z
  .object({
    action: z.enum(['create', 'update', 'validate', 'invalidate', 'dispute']),
    knowledge_type: z.enum(KNOWLEDGE_TYPES).optional(),
    subject: z.string().min(1).max(MAX_TARGET_LENGTH).optional(),
    content: z.string().min(1).max(MAX_CONTENT_LENGTH).optional(),
    evidence: z.array(EvidenceInputSchema).optional(),
    entity_ids: z.array(z.string().max(50)).optional(),
    knowledge_id: z.string().max(50).optional(),
    validation_status: z.enum(VALIDATION_STATUSES).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine(
    (data) => {
      if (data.action === 'create') {
        return !!data.knowledge_type && !!data.subject && !!data.content;
      }
      return true;
    },
    { message: 'create action requires knowledge_type, subject, and content' },
  )
  .refine(
    (data) => {
      if (['update', 'validate', 'invalidate', 'dispute'].includes(data.action)) {
        return !!data.knowledge_id;
      }
      return true;
    },
    { message: 'update/validate/invalidate/dispute actions require knowledge_id' },
  );

// ──────────────────────────────────────────────────────────────────────
// sync
// ──────────────────────────────────────────────────────────────────────

export const SyncSchema = z
  .object({
    action: z.enum(['status', 'incremental', 'full', 'analyze_file', 'analyze_schema', 'knowledge_export', 'knowledge_import']),
    path: z.string().max(MAX_TARGET_LENGTH).optional(),
    connection: z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        user: z.string().min(1).max(100),
        password: z.string().max(500),
        database: z.string().min(1).max(100),
      })
      .optional(),
    force: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.action === 'analyze_file') return !!data.path;
      return true;
    },
    { message: 'analyze_file action requires path' },
  )
  .refine(
    (data) => {
      if (data.action === 'analyze_schema') return !!data.connection;
      return true;
    },
    { message: 'analyze_schema action requires connection' },
  );

// ──────────────────────────────────────────────────────────────────────
// session
// ──────────────────────────────────────────────────────────────────────

export const SessionSchema = z
  .object({
    action: z.enum(['checkpoint', 'resume', 'list', 'close']),
    session_name: z.string().min(1).max(200).optional(),
    task_description: z.string().min(1).max(MAX_CONTENT_LENGTH).optional(),
    current_status: z.string().max(MAX_CONTENT_LENGTH).optional(),
    completed_steps: z.array(z.string().max(MAX_CONTENT_LENGTH)).optional(),
    pending_steps: z.array(z.string().max(MAX_CONTENT_LENGTH)).optional(),
    files_involved: z.array(z.string().max(MAX_TARGET_LENGTH)).optional(),
    notes: z.string().max(MAX_CONTENT_LENGTH).optional(),
    session_id: z.string().max(50).optional(),
  })
  .refine(
    (data) => {
      if (data.action === 'checkpoint') {
        return !!data.session_name && !!data.task_description;
      }
      return true;
    },
    { message: 'checkpoint action requires session_name and task_description' },
  )
  .refine(
    (data) => {
      if (data.action === 'resume' || data.action === 'close') {
        return !!data.session_id;
      }
      return true;
    },
    { message: 'resume/close actions require session_id' },
  );
