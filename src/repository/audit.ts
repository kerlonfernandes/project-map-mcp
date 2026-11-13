/**
 * Repository for the audit log.
 *
 * Every write operation on the knowledge base is logged here for
 * traceability. The log is bounded by entry count and age — old
 * entries are cleaned up automatically.
 *
 * Used by: Application Services (after every write operation).
 */

import type { Database } from 'better-sqlite3';

import type { AuditLogRecord } from '../shared/types.js';
import { MAX_AUDIT_LOG_ENTRIES, MAX_AUDIT_LOG_AGE_DAYS } from '../shared/constants.js';

export interface AuditEntry {
  operation: string;
  tool_name: string;
  parameters_hash: string;
  result_summary?: string;
  entities_affected?: number;
  duration_ms?: number;
}

/** Inserts an audit log entry. */
export function logAudit(db: Database, entry: AuditEntry): void {
  db.prepare(`
    INSERT INTO audit_log (operation, tool_name, parameters_hash, result_summary, entities_affected, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entry.operation,
    entry.tool_name,
    entry.parameters_hash,
    entry.result_summary ?? null,
    entry.entities_affected ?? 0,
    entry.duration_ms ?? null,
  );
}

/**
 * Cleans up old audit log entries.
 * Keeps at most MAX_AUDIT_LOG_ENTRIES entries and removes anything
 * older than MAX_AUDIT_LOG_AGE_DAYS.
 */
export function cleanAuditLog(db: Database): number {
  const cutoffDate = new Date(
    Date.now() - MAX_AUDIT_LOG_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Delete by age
  const byAge = db
    .prepare('DELETE FROM audit_log WHERE timestamp < ?')
    .run(cutoffDate);

  // Delete by count (keep newest MAX_AUDIT_LOG_ENTRIES)
  const byCount = db.prepare(`
    DELETE FROM audit_log
    WHERE id NOT IN (
      SELECT id FROM audit_log ORDER BY timestamp DESC LIMIT ?
    )
  `).run(MAX_AUDIT_LOG_ENTRIES);

  return byAge.changes + byCount.changes;
}

/** Retrieves recent audit log entries. */
export function getRecentAuditEntries(
  db: Database,
  limit: number = 50,
): AuditLogRecord[] {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as AuditLogRecord[];
}
