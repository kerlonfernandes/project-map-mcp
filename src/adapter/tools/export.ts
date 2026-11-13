/**
 * MCP tool handler for database export, import, and listing.
 *
 * Thin adapter: validates input, delegates to the export service,
 * and formats the response. No business logic here.
 *
 * Used by: adapter/server.ts (tool registration).
 */

import type { Database } from 'better-sqlite3';

import type { ProjectMapConfig, ExportInput } from '../../shared/types.js';
import { ValidationError } from '../../shared/errors.js';
import {
  exportDatabase,
  importDatabase,
  listExports,
} from '../../services/export.js';

/**
 * Routes export/import/list actions to the appropriate service function.
 */
export function handleExport(
  db: Database,
  _repositoryId: string,
  config: ProjectMapConfig,
  args: ExportInput,
  dbPath: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const projectRoot = config.project.root;

  switch (args.action) {
    case 'export': {
      const result = exportDatabase(db, projectRoot, args.label);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'exported',
            ...result,
            message: `Database exported successfully. Share the file at: ${result.export_path}`,
          }, null, 2),
        }],
      };
    }

    case 'import': {
      if (!args.path) {
        throw new ValidationError('Path is required for import action');
      }
      const result = importDatabase(db, projectRoot, args.path, dbPath);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'imported',
            ...result,
            message: `Database imported successfully from ${args.path}. Restart the MCP server to use the new data.`,
          }, null, 2),
        }],
      };
    }

    case 'list': {
      const exports = listExports(projectRoot);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            exports,
            total: exports.length,
            message: exports.length > 0
              ? `Found ${exports.length} export(s). Use import with the path to load one.`
              : 'No exports found. Use export action to create one.',
          }, null, 2),
        }],
      };
    }
  }
}
