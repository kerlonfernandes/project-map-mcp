/**
 * Repository for session cache management.
 *
 * Session cache stores per-session copies of tool responses so that
 * repeated queries return delta responses instead of full payloads.
 * This dramatically reduces token consumption in long conversations.
 *
 * Cache entries are tied to a snapshot — when a new snapshot arrives,
 * stale cache entries for affected targets are invalidated.
 *
 * Used by: Context Delivery (services/context.ts).
 */

import type { Database } from 'better-sqlite3';

import type { SessionCacheRecord } from '../shared/types.js';
import { nowISO } from '../shared/utils.js';

/**
 * Stores a response in the session cache.
 * Overwrites any existing entry for the same (session_id, cache_key).
 */
export function setCache(
  db: Database,
  sessionId: string,
  cacheKey: string,
  content: string,
  tokenCount: number,
  snapshotId: string,
  ttlMinutes: number = 60,
): void {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO session_cache (session_id, cache_key, content, token_count, snapshot_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, cache_key) DO UPDATE SET
      content = excluded.content,
      token_count = excluded.token_count,
      snapshot_id = excluded.snapshot_id,
      created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      expires_at = excluded.expires_at
  `).run(sessionId, cacheKey, content, tokenCount, snapshotId, expiresAt);
}

/**
 * Retrieves a cached response if it exists and is not expired.
 * Returns null if no valid cache entry exists.
 */
export function getCache(
  db: Database,
  sessionId: string,
  cacheKey: string,
): SessionCacheRecord | null {
  const now = nowISO();

  const row = db.prepare(`
    SELECT * FROM session_cache
    WHERE session_id = ? AND cache_key = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(sessionId, cacheKey, now) as SessionCacheRecord | undefined;

  return row ?? null;
}

/** Invalidates all cache entries for a session that use a specific snapshot. */
export function invalidateCacheBySnapshot(
  db: Database,
  snapshotId: string,
): number {
  const result = db
    .prepare('DELETE FROM session_cache WHERE snapshot_id = ?')
    .run(snapshotId);
  return result.changes;
}

/** Removes all expired cache entries. */
export function cleanExpiredCache(db: Database): number {
  const result = db
    .prepare(`DELETE FROM session_cache WHERE expires_at < ?`)
    .run(nowISO());
  return result.changes;
}

/** Removes all cache entries for a session. */
export function clearSessionCache(db: Database, sessionId: string): number {
  const result = db
    .prepare('DELETE FROM session_cache WHERE session_id = ?')
    .run(sessionId);
  return result.changes;
}
