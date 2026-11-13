/**
 * Utility functions shared across the Project Map MCP server.
 *
 * Pure functions only — no state, no I/O, no side effects.
 * Every function here must be independently testable.
 *
 * Used by: every layer of the application.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

import {
  PathTraversalError,
  SymlinkEscapeError,
  BlockedPathError,
  FileTooLargeError,
} from './errors.js';
import { DEFAULT_BLOCKED_PATTERNS, MAX_FILE_SIZE_BYTES, LANGUAGE_EXTENSIONS, MINIFIED_PATTERNS } from './constants.js';
import type { Language } from './types.js';

// ──────────────────────────────────────────────────────────────────────
// ID Generation
// ──────────────────────────────────────────────────────────────────────

/** Generates a prefixed UUID for readable identification. */
export function generateId(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Hashing
// ──────────────────────────────────────────────────────────────────────

/** SHA-256 hash of a string, returned as hex. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Hash for comparing parameters in audit log — truncated for space. */
export function hashParams(params: unknown): string {
  return sha256(JSON.stringify(params)).slice(0, 16);
}

// ──────────────────────────────────────────────────────────────────────
// Path Security
// ──────────────────────────────────────────────────────────────────────

/**
 * Validates that a file path stays within the project root.
 *
 * Three checks in sequence:
 * 1. Resolved path must start with the project root.
 * 2. Real path (following symlinks) must still be within root.
 * 3. Path must not match any blocked pattern.
 *
 * SECURITY: this is the sole gateway for all file access in the system.
 * Every file read, parse, or path reference must pass through here.
 *
 * @throws PathTraversalError if path escapes root
 * @throws SymlinkEscapeError if symlink resolves outside root
 * @throws BlockedPathError if path matches a blocked pattern
 * @returns The validated, resolved absolute path
 */
export function validatePath(
  requestedPath: string,
  projectRoot: string,
  blockedPatterns: string[] = DEFAULT_BLOCKED_PATTERNS,
): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolved = path.resolve(resolvedRoot, requestedPath);

  // SECURITY: check resolved path is within project root
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new PathTraversalError(requestedPath);
  }

  // SECURITY: follow symlinks and check real path is within root
  try {
    const realPath = fs.realpathSync(resolved);
    if (!realPath.startsWith(resolvedRoot + path.sep) && realPath !== resolvedRoot) {
      throw new SymlinkEscapeError(requestedPath);
    }
  } catch (error) {
    // If file doesn't exist yet, that's OK — only symlink escape is blocked
    if (error instanceof SymlinkEscapeError) throw error;
  }

  // SECURITY: check against blocked path patterns
  if (isBlockedPath(resolved, resolvedRoot, blockedPatterns)) {
    throw new BlockedPathError(requestedPath);
  }

  return resolved;
}

/**
 * Checks if a path matches any blocked pattern.
 * Patterns use simple glob matching: `*` = any chars, prefix match for dirs.
 */
export function isBlockedPath(
  absolutePath: string,
  projectRoot: string,
  patterns: string[] = DEFAULT_BLOCKED_PATTERNS,
): boolean {
  const relativePath = path.relative(projectRoot, absolutePath);

  return patterns.some((pattern) => {
    // Directory pattern (ends with /)
    if (pattern.endsWith('/')) {
      return relativePath.startsWith(pattern) || relativePath.includes(`/${pattern}`);
    }

    // Glob with *
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
      );
      return regex.test(relativePath) || regex.test(path.basename(relativePath));
    }

    // Exact match
    return relativePath === pattern || path.basename(relativePath) === pattern;
  });
}

/**
 * Validates file size before reading into memory.
 * @throws FileTooLargeError if file exceeds the limit
 */
export function validateFileSize(
  filePath: string,
  maxBytes: number = MAX_FILE_SIZE_BYTES,
): void {
  const stats = fs.statSync(filePath);
  if (stats.size > maxBytes) {
    throw new FileTooLargeError(filePath, stats.size, maxBytes);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Input Sanitization
// ──────────────────────────────────────────────────────────────────────

/**
 * Strips control characters and normalizes Unicode.
 * Used on all text inputs from MCP clients.
 */
export function sanitizeInput(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

/**
 * Validates that a path string contains only safe characters.
 * Allowed: alphanumeric, `/`, `.`, `-`, `_`, spaces.
 */
export function isValidPathChars(input: string): boolean {
  return /^[a-zA-Z0-9\/_.\-\s@:]+$/.test(input);
}

// ──────────────────────────────────────────────────────────────────────
// Language Detection
// ──────────────────────────────────────────────────────────────────────

/** Detects language from file extension. Returns null for unknown. */
export function detectLanguage(filePath: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  return (LANGUAGE_EXTENSIONS[ext] as Language) ?? null;
}

/** Returns true if the file extension is parseable by our analyzers. */
export function isParseableFile(filePath: string): boolean {
  if (isMinifiedFile(filePath)) return false;
  const lang = detectLanguage(filePath);
  return lang === 'php' || lang === 'javascript' || lang === 'typescript' || lang === 'python' || lang === 'css' || lang === 'html';
}

// ──────────────────────────────────────────────────────────────────────
// Token Estimation
// ──────────────────────────────────────────────────────────────────────

/**
 * Rough token count estimate.
 * Uses ~4 characters per token as a conservative approximation.
 * Accurate enough for budget enforcement; not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ──────────────────────────────────────────────────────────────────────
// Time Helpers
// ──────────────────────────────────────────────────────────────────────

/** Returns current time as ISO 8601 UTC string. */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ──────────────────────────────────────────────────────────────────────
// File Helpers
// ──────────────────────────────────────────────────────────────────────

/** Returns true if the file is a minified bundle (should be skipped). */
export function isMinifiedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return MINIFIED_PATTERNS.some((p) => lower.endsWith(p));
}

/** Returns true if the path points to a binary file (heuristic). */
export function isBinaryFile(filePath: string): boolean {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
    '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov', '.wav',
    '.db', '.sqlite', '.sqlite3',
    '.lock',
  ]);

  return binaryExtensions.has(path.extname(filePath).toLowerCase());
}

/**
 * Reads a file safely after validation.
 * @throws FileTooLargeError if file exceeds limit
 */
export function readFileSafe(
  filePath: string,
  projectRoot: string,
  maxBytes: number = MAX_FILE_SIZE_BYTES,
): string {
  const validated = validatePath(filePath, projectRoot);
  validateFileSize(validated, maxBytes);
  return fs.readFileSync(validated, 'utf-8');
}
