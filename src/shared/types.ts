/**
 * Core type definitions for the Project Map MCP knowledge model.
 *
 * Every entity, relationship, evidence, and knowledge record in the system
 * conforms to these types. They mirror the SQLite schema and serve as the
 * single source of truth for data shape across all layers.
 *
 * Used by: every module in the project.
 */

// ──────────────────────────────────────────────────────────────────────
// Entity Scopes & Types
// ──────────────────────────────────────────────────────────────────────

export const ENTITY_SCOPES = [
  'project',
  'module',
  'file',
  'symbol',
  'database',
  'external',
] as const;

export type EntityScope = (typeof ENTITY_SCOPES)[number];

export const ENTITY_TYPES = [
  'file',
  'directory',
  'class',
  'function',
  'interface',
  'trait',
  'constant',
  'variable',
  'route',
  'middleware',
  'migration',
  'model',
  'view',
  'event',
  'listener',
  'job',
  'command',
  'config',
  'table',
  'column',
  'index',
  'foreign_key',
  'package',
  'test',
  'factory',
  'seeder',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const LANGUAGES = [
  'php',
  'javascript',
  'sql',
  'json',
  'yaml',
  'markdown',
  'other',
] as const;

export type Language = (typeof LANGUAGES)[number];

// ──────────────────────────────────────────────────────────────────────
// Relationships (Edges)
// ──────────────────────────────────────────────────────────────────────

export const EDGE_TYPES = [
  'imports',
  'extends',
  'implements',
  'uses_trait',
  'calls',
  'instantiates',
  'references',
  'belongs_to',
  'has_many',
  'belongs_to_model',
  'has_one',
  'many_to_many',
  'maps_to_table',
  'handles_route',
  'dispatches',
  'listens_to',
  'renders',
  'migrates',
  'foreign_key_to',
  'depends_on',
  'tests',
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const RESOLUTION_STATUSES = ['resolved', 'ambiguous', 'unresolved'] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

// ──────────────────────────────────────────────────────────────────────
// Evidence
// ──────────────────────────────────────────────────────────────────────

export const SOURCE_KINDS = [
  'code',
  'comment',
  'docblock',
  'config',
  'migration',
  'test',
  'git_log',
  'manual',
  'schema',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

// ──────────────────────────────────────────────────────────────────────
// Knowledge
// ──────────────────────────────────────────────────────────────────────

export const KNOWLEDGE_TYPES = [
  'business_rule',
  'architectural_decision',
  'data_flow',
  'api_contract',
  'constraint',
  'pattern',
  'dependency_note',
  'security_note',
  'performance_note',
  'todo',
  'explanation',
  'convention',
] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_ORIGINS = [
  'deterministic',
  'heuristic',
  'ai_generated',
  'human_provided',
] as const;

export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];

export const VALIDATION_STATUSES = [
  'unverified',
  'supported_by_code',
  'supported_by_tests',
  'human_confirmed',
  'disputed',
  'superseded',
  'invalidated',
] as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const VALIDITY_STATES = ['current', 'needs_review', 'stale', 'archived'] as const;

export type ValidityState = (typeof VALIDITY_STATES)[number];

// ──────────────────────────────────────────────────────────────────────
// Snapshots
// ──────────────────────────────────────────────────────────────────────

export const SNAPSHOT_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'partial',
] as const;

export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

// ──────────────────────────────────────────────────────────────────────
// Conventions
// ──────────────────────────────────────────────────────────────────────

export const CONVENTION_CATEGORIES = [
  'naming',
  'structure',
  'pattern',
  'config',
  'testing',
  'documentation',
] as const;

export type ConventionCategory = (typeof CONVENTION_CATEGORIES)[number];

// ──────────────────────────────────────────────────────────────────────
// Context Delivery
// ──────────────────────────────────────────────────────────────────────

export const DEPTH_LEVELS = ['summary', 'structure', 'detail', 'full'] as const;

export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export const PURPOSE_MODES = ['understand', 'implement', 'debug', 'review', 'plan'] as const;

export type PurposeMode = (typeof PURPOSE_MODES)[number];

// ──────────────────────────────────────────────────────────────────────
// Data Records (row shapes from SQLite)
// ──────────────────────────────────────────────────────────────────────

export interface ProjectRecord {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
  config_json: string;
}

export interface RepositoryRecord {
  id: string;
  project_id: string;
  path: string;
  remote_url: string | null;
  default_branch: string;
  created_at: string;
}

export interface SnapshotRecord {
  id: string;
  repository_id: string;
  branch_name: string | null;
  head_commit: string | null;
  index_tree_hash: string | null;
  working_tree_hash: string | null;
  analyzer_version: string;
  status: SnapshotStatus;
  files_analyzed: number;
  files_total: number;
  entities_found: number;
  edges_found: number;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface EntityRecord {
  id: string;
  repository_id: string;
  entity_type: EntityType;
  scope: EntityScope;
  qualified_name: string;
  display_name: string;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  language: Language | null;
  signature: string | null;
  metadata_json: string;
  snapshot_id: string;
  created_at: string;
}

export interface EvidenceRecord {
  id: string;
  repository_id: string;
  source_kind: SourceKind;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  symbol_id: string | null;
  content_hash: string | null;
  snapshot_id: string | null;
  commit_sha: string | null;
  excerpt: string | null;
  created_at: string;
}

export interface EdgeRecord {
  id: string;
  repository_id: string;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  weight: number;
  resolution_status: ResolutionStatus;
  evidence_id: string | null;
  snapshot_id: string;
  metadata_json: string;
}

export interface KnowledgeRecord {
  id: string;
  repository_id: string;
  subject: string;
  knowledge_type: KnowledgeType;
  content: string;
  origin: KnowledgeOrigin;
  validation_status: ValidationStatus;
  confidence: number;
  validity: ValidityState;
  snapshot_id: string | null;
  supersedes_id: string | null;
  created_at: string;
  validated_at: string | null;
}

export interface ConventionRecord {
  id: string;
  repository_id: string;
  category: ConventionCategory;
  description: string;
  regex_pattern: string | null;
  confidence: number;
  occurrences: number;
  snapshot_id: string | null;
  created_at: string;
}

export interface SummaryRecord {
  id: string;
  repository_id: string;
  scope: 'project' | 'module' | 'file';
  target_path: string;
  depth: DepthLevel;
  content: string;
  token_count: number;
  dependency_fingerprint: string | null;
  snapshot_id: string;
  created_at: string;
}

export interface SessionCacheRecord {
  session_id: string;
  cache_key: string;
  content: string;
  token_count: number;
  snapshot_id: string;
  created_at: string;
  expires_at: string | null;
}

export interface AuditLogRecord {
  id: number;
  timestamp: string;
  operation: string;
  tool_name: string;
  parameters_hash: string;
  result_summary: string | null;
  entities_affected: number;
  duration_ms: number | null;
}

// ──────────────────────────────────────────────────────────────────────
// Work Sessions
// ──────────────────────────────────────────────────────────────────────

export const WORK_SESSION_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;

export type WorkSessionStatus = (typeof WORK_SESSION_STATUSES)[number];

export interface WorkSessionRecord {
  id: string;
  repository_id: string;
  session_name: string;
  status: WorkSessionStatus;
  task_description: string;
  current_status: string | null;
  completed_steps: string;
  pending_steps: string;
  files_involved: string;
  notes: string | null;
  checkpoints_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface WorkSessionCheckpointRecord {
  id: number;
  session_id: string;
  checkpoint_number: number;
  current_status: string | null;
  completed_steps: string;
  pending_steps: string;
  files_involved: string;
  notes: string | null;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────────────
// Tool Input/Output Types
// ──────────────────────────────────────────────────────────────────────

export interface GetContextInput {
  target: string;
  depth?: DepthLevel;
  purpose?: PurposeMode;
  token_budget?: number;
  session_id?: string;
  include?: Array<'knowledge' | 'evidence' | 'edges' | 'conventions' | 'gaps'>;
}

export interface SearchInput {
  query: string;
  scope?: 'entities' | 'knowledge' | 'evidence' | 'all';
  filters?: {
    entity_type?: EntityType;
    language?: Language;
    path_prefix?: string;
    knowledge_type?: KnowledgeType;
    validation_status?: ValidationStatus;
    origin?: KnowledgeOrigin;
  };
  limit?: number;
  token_budget?: number;
}

export interface GraphInput {
  entity_id: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  edge_types?: EdgeType[];
  max_depth?: number;
  include_unresolved?: boolean;
  token_budget?: number;
}

export interface ImpactInput {
  entity_id: string;
  change_type?: 'modify' | 'delete' | 'rename';
  max_depth?: number;
  include_tests?: boolean;
  token_budget?: number;
}

export interface RecordInput {
  action: 'create' | 'update' | 'validate' | 'invalidate' | 'dispute';
  knowledge_type?: KnowledgeType;
  subject?: string;
  content?: string;
  evidence?: Array<{
    path: string;
    line_start?: number;
    line_end?: number;
    excerpt?: string;
    source_kind: SourceKind;
  }>;
  entity_ids?: string[];
  knowledge_id?: string;
  validation_status?: ValidationStatus;
  confidence?: number;
}

export interface SessionInput {
  action: 'checkpoint' | 'resume' | 'list' | 'close';
  session_name?: string;
  task_description?: string;
  current_status?: string;
  completed_steps?: string[];
  pending_steps?: string[];
  files_involved?: string[];
  notes?: string;
  session_id?: string;
}

export interface SyncInput {
  action: 'status' | 'incremental' | 'full' | 'analyze_file' | 'analyze_schema';
  path?: string;
  connection?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  force?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Response Meta (included in every tool response)
// ──────────────────────────────────────────────────────────────────────

export interface ResponseMeta {
  tokens_used: number;
  token_budget?: number;
  depth?: DepthLevel;
  depth_effective?: DepthLevel;
  purpose?: PurposeMode;
  coverage?: number;
  snapshot_id?: string;
  cached?: boolean;
  truncated_categories?: string[];
  unresolved_references?: number;
  duration_ms?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────

export interface ProjectMapConfig {
  project: {
    name: string;
    root: string;
  };
  analysis: {
    languages: Language[];
    frameworks: string[];
    exclude_patterns: string[];
    max_file_size_mb: number;
    max_directory_depth: number;
    max_files_per_sync: number;
    parse_timeout_ms: number;
  };
  database: {
    path: string;
    max_size_mb: number;
    cache_size_mb: number;
  };
  security: {
    blocked_paths: string[];
    mysql: {
      allow_connection: boolean;
      allowed_hosts: string[];
      blocked_schemas: string[];
    };
    rate_limit: {
      enabled: boolean;
      max_per_minute: number;
    };
  };
  sync: {
    reconciliation_interval: number;
    staleness_max_depth: number;
  };
  context: {
    default_depth: DepthLevel;
    default_purpose: PurposeMode;
    default_token_budget: number;
    max_token_budget: number;
  };
}

// ──────────────────────────────────────────────────────────────────────
// Analyzer Output (what parsers return, never persisted directly)
// ──────────────────────────────────────────────────────────────────────

export interface ParsedEntity {
  entity_type: EntityType;
  scope: EntityScope;
  qualified_name: string;
  display_name: string;
  path: string;
  line_start: number;
  line_end: number;
  language: Language;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedEdge {
  source_qualified_name: string;
  target_qualified_name: string;
  edge_type: EdgeType;
  weight: number;
  resolution_status: ResolutionStatus;
  line?: number;
}

export interface ParsedEvidence {
  source_kind: SourceKind;
  path: string;
  line_start: number;
  line_end: number;
  excerpt: string;
  content_hash: string;
}

export interface FileAnalysisResult {
  path: string;
  language: Language;
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
}
