/**
 * Application-wide constants for the Project Map MCP server.
 *
 * All magic numbers and string literals live here. If a value appears
 * in more than one file, it belongs in this module.
 *
 * Used by: every layer of the application.
 */

// ──────────────────────────────────────────────────────────────────────
// Version & Identity
// ──────────────────────────────────────────────────────────────────────

export const ANALYZER_VERSION = '1.0.0';
export const MCP_SERVER_NAME = 'project-map-mcp';
export const MCP_SERVER_VERSION = '1.0.0';

// ──────────────────────────────────────────────────────────────────────
// File Size & Limits
// ──────────────────────────────────────────────────────────────────────

/** Maximum file size the analyzer will read (in bytes). Default: 2 MB. */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Maximum directory depth during recursive scan. */
export const MAX_DIRECTORY_DEPTH = 20;

/** Maximum files processed in a single incremental sync. */
export const MAX_FILES_PER_SYNC = 500;

/** Per-file parse timeout in milliseconds. */
export const PARSE_TIMEOUT_MS = 30_000;

/** Maximum SQLite database size in bytes. Default: 500 MB. */
export const MAX_DB_SIZE_BYTES = 500 * 1024 * 1024;

// ──────────────────────────────────────────────────────────────────────
// Input Validation
// ──────────────────────────────────────────────────────────────────────

/** Maximum length for a target path string. */
export const MAX_TARGET_LENGTH = 500;

/** Maximum length for a search query string. */
export const MAX_QUERY_LENGTH = 1000;

/** Maximum length for knowledge content text. */
export const MAX_CONTENT_LENGTH = 10_000;

/** Maximum token budget a client can request. */
export const MAX_TOKEN_BUDGET = 200_000;

/** Default token budget when none specified. */
export const DEFAULT_TOKEN_BUDGET = 2000;

/** Maximum traversal depth for graph queries. */
export const MAX_GRAPH_DEPTH = 10;

/** Maximum number of search results. */
export const MAX_SEARCH_LIMIT = 500;

/** Default number of search results. */
export const DEFAULT_SEARCH_LIMIT = 20;

// ──────────────────────────────────────────────────────────────────────
// Rate Limiting
// ──────────────────────────────────────────────────────────────────────

/** Default: 60 tool calls per minute. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

// ──────────────────────────────────────────────────────────────────────
// Edge Weights (coupling strength)
// ──────────────────────────────────────────────────────────────────────

export const EDGE_WEIGHTS: Record<string, number> = {
  extends: 0.9,
  implements: 0.9,
  uses_trait: 0.8,
  calls: 0.7,
  instantiates: 0.7,
  imports: 0.6,
  dispatches: 0.6,
  listens_to: 0.6,
  handles_route: 0.7,
  renders: 0.5,
  maps_to_table: 0.8,
  has_many: 0.6,
  belongs_to_model: 0.6,
  has_one: 0.5,
  many_to_many: 0.6,
  migrates: 0.7,
  foreign_key_to: 0.8,
  depends_on: 0.5,
  tests: 0.4,
  references: 0.3,
  belongs_to: 0.2,
};

// ──────────────────────────────────────────────────────────────────────
// Context Delivery
// ──────────────────────────────────────────────────────────────────────

/** Reserved tokens for the `meta` field in every response. */
export const RESERVED_META_TOKENS = 100;

/**
 * Content weight allocation by purpose mode.
 * Each purpose prioritizes different content types.
 * Weights must sum to 1.0 within each purpose.
 */
export const PURPOSE_WEIGHTS: Record<string, Record<string, number>> = {
  understand: {
    knowledge: 0.3,
    edges: 0.25,
    symbols: 0.25,
    gaps: 0.1,
    conventions: 0.1,
  },
  implement: {
    symbols: 0.3,
    edges: 0.3,
    knowledge: 0.2,
    gaps: 0.15,
    conventions: 0.05,
  },
  debug: {
    edges: 0.3,
    symbols: 0.25,
    knowledge: 0.2,
    gaps: 0.2,
    conventions: 0.05,
  },
  review: {
    knowledge: 0.35,
    gaps: 0.25,
    edges: 0.2,
    symbols: 0.15,
    conventions: 0.05,
  },
  plan: {
    edges: 0.3,
    knowledge: 0.25,
    symbols: 0.2,
    conventions: 0.15,
    gaps: 0.1,
  },
};

// ──────────────────────────────────────────────────────────────────────
// Sync
// ──────────────────────────────────────────────────────────────────────

/** After this many incremental snapshots, run a full reconciliation. */
export const DEFAULT_RECONCILIATION_INTERVAL = 10;

/** Max depth for staleness propagation through the dependency graph. */
export const DEFAULT_STALENESS_MAX_DEPTH = 3;

// ──────────────────────────────────────────────────────────────────────
// Convention Detection
// ──────────────────────────────────────────────────────────────────────

/** Minimum occurrences before a pattern is considered a convention. */
export const MIN_CONVENTION_OCCURRENCES = 3;

/** Minimum ratio of matching files for a convention to be detected. */
export const MIN_CONVENTION_RATIO = 0.6;

// ──────────────────────────────────────────────────────────────────────
// Audit Log
// ──────────────────────────────────────────────────────────────────────

/** Maximum audit log entries retained. */
export const MAX_AUDIT_LOG_ENTRIES = 10_000;

/** Maximum age of audit log entries in days. */
export const MAX_AUDIT_LOG_AGE_DAYS = 30;

// ──────────────────────────────────────────────────────────────────────
// File Extension Mappings
// ──────────────────────────────────────────────────────────────────────

export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.php': 'php',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

// ──────────────────────────────────────────────────────────────────────
// Security: Blocked Paths (defaults)
// ──────────────────────────────────────────────────────────────────────

export const DEFAULT_BLOCKED_PATTERNS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '.git/',
  'node_modules/.cache/',
];

// ──────────────────────────────────────────────────────────────────────
// Database Config (SQLite PRAGMAs)
// ──────────────────────────────────────────────────────────────────────

export const SQLITE_PRAGMAS = {
  journal_mode: 'WAL',
  foreign_keys: 'ON',
  busy_timeout: '5000',
  synchronous: 'NORMAL',
  cache_size: '-64000',
  temp_store: 'MEMORY',
} as const;
