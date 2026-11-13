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
import type { ProjectMapConfig } from '../../shared/types.js';

interface SyncArgs {
  action: 'status' | 'incremental' | 'full' | 'analyze_file' | 'analyze_schema' | 'knowledge_export' | 'knowledge_import';
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

export async function handleSync(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  args: SyncArgs,
) {
  const result = await syncRepository(db, repositoryId, config, {
    action: args.action,
    path: args.path,
    connection: args.connection,
    force: args.force ?? false,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
