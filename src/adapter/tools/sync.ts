/**
 * Tool handler for `sync`.
 *
 * Delegates to the Sync application service for repository
 * synchronization, re-indexing, and MySQL schema analysis.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import { syncRepository } from '../../services/sync.js';
import type { OndbayConfig } from '../../shared/types.js';

interface SyncArgs {
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

export function handleSync(
  db: Database,
  repositoryId: string,
  config: OndbayConfig,
  args: SyncArgs,
) {
  const result = syncRepository(db, repositoryId, config, {
    action: args.action,
    path: args.path,
    connection: args.connection,
    force: args.force ?? false,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
