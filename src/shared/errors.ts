/**
 * Typed error hierarchy for the Project Map MCP server.
 *
 * Every error thrown in the application uses one of these classes so
 * that callers can distinguish categories (security, validation, not found)
 * without parsing error messages.
 *
 * The MCP adapter catches these and translates them to JSON-RPC errors
 * with safe, generic messages — internal details never leak to clients.
 *
 * Used by: every layer of the application.
 */

/**
 * Base class for all Project Map errors.
 * Carries a machine-readable `code` for programmatic handling.
 */
export class Project MapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'Project MapError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Security Errors
// ──────────────────────────────────────────────────────────────────────

/** Thrown when a path escapes the project root via traversal or symlink. */
export class PathTraversalError extends Project MapError {
  constructor(path: string) {
    super('PATH_TRAVERSAL', `Path traversal blocked: ${sanitizePath(path)}`);
    this.name = 'PathTraversalError';
  }
}

/** Thrown when a symlink resolves outside the project root. */
export class SymlinkEscapeError extends Project MapError {
  constructor(path: string) {
    super('SYMLINK_ESCAPE', `Symlink escape blocked: ${sanitizePath(path)}`);
    this.name = 'SymlinkEscapeError';
  }
}

/** Thrown when a file matches a blocked path pattern. */
export class BlockedPathError extends Project MapError {
  constructor(path: string) {
    super('BLOCKED_PATH', `Access to blocked path: ${sanitizePath(path)}`);
    this.name = 'BlockedPathError';
  }
}

/** Thrown when rate limit is exceeded. */
export class RateLimitError extends Project MapError {
  constructor(limit: number) {
    super('RATE_LIMIT', `Rate limit exceeded: ${limit} requests per minute`);
    this.name = 'RateLimitError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Validation Errors
// ──────────────────────────────────────────────────────────────────────

/** Thrown when tool input fails schema validation. */
export class ValidationError extends Project MapError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

/** Thrown when a file exceeds the configured size limit. */
export class FileTooLargeError extends Project MapError {
  constructor(path: string, sizeBytes: number, maxBytes: number) {
    super('FILE_TOO_LARGE', `File too large: ${sanitizePath(path)} (${sizeBytes} bytes, max ${maxBytes})`);
    this.name = 'FileTooLargeError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Not Found Errors
// ──────────────────────────────────────────────────────────────────────

/** Thrown when a requested entity does not exist. */
export class EntityNotFoundError extends Project MapError {
  constructor(identifier: string) {
    super('ENTITY_NOT_FOUND', `Entity not found: ${identifier}`);
    this.name = 'EntityNotFoundError';
  }
}

/** Thrown when a requested knowledge record does not exist. */
export class KnowledgeNotFoundError extends Project MapError {
  constructor(id: string) {
    super('KNOWLEDGE_NOT_FOUND', `Knowledge record not found: ${id}`);
    this.name = 'KnowledgeNotFoundError';
  }
}

/** Thrown when a requested work session does not exist. */
export class SessionNotFoundError extends Project MapError {
  constructor(id: string) {
    super('SESSION_NOT_FOUND', `Work session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

/** Thrown when no project is initialized in the target directory. */
export class ProjectNotFoundError extends Project MapError {
  constructor(path: string) {
    super('PROJECT_NOT_FOUND', `No Project Map project found at: ${sanitizePath(path)}`);
    this.name = 'ProjectNotFoundError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Database Errors
// ──────────────────────────────────────────────────────────────────────

/** Thrown when a database operation fails. */
export class DatabaseError extends Project MapError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DATABASE_ERROR', message, details);
    this.name = 'DatabaseError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Analysis Errors
// ──────────────────────────────────────────────────────────────────────

/** Thrown when a parser fails to process a file. */
export class ParseError extends Project MapError {
  constructor(path: string, reason: string) {
    super('PARSE_ERROR', `Failed to parse ${sanitizePath(path)}: ${reason}`);
    this.name = 'ParseError';
  }
}

/** Thrown when a Git operation fails. */
export class GitError extends Project MapError {
  constructor(message: string) {
    super('GIT_ERROR', message);
    this.name = 'GitError';
  }
}

/** Thrown when MySQL connection fails. */
export class MySqlConnectionError extends Project MapError {
  constructor(message: string) {
    super('MYSQL_CONNECTION_ERROR', `MySQL connection failed: ${message}`);
    this.name = 'MySqlConnectionError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

// SECURITY: strip potential control characters from path before logging
function sanitizePath(filePath: string): string {
  return filePath.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
}
