#!/usr/bin/env node
/**
 * Main entry point for the Project Map MCP server.
 *
 * Reads environment variables, loads configuration, opens the database,
 * and starts the MCP server on STDIO transport.
 *
 * Environment variables:
 *   PROJECT_MAP_PROJECT_ROOT — Path to the project to analyze (required)
 *   PROJECT_MAP_DB_PATH      — Path to the SQLite database (optional)
 *
 * Used by: AI clients (Claude Desktop, Cursor, etc.) via STDIO.
 */

import path from 'node:path';
import fs from 'node:fs';

import { openDatabase, closeDatabase } from './repository/db.js';
import {
  findFirstProject,
  findRepositoryByProjectId,
  createProjectWithRepository,
} from './repository/projects.js';
import { startServer } from './adapter/server.js';
import { loadConfig } from './cli/config.js';

async function main(): Promise<void> {
  const projectRoot = process.env['PROJECT_MAP_PROJECT_ROOT'];
  if (!projectRoot) {
    console.error('PROJECT_MAP_PROJECT_ROOT environment variable is required');
    process.exit(1);
  }

  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot)) {
    console.error(`Project root does not exist: ${resolvedRoot}`);
    process.exit(1);
  }

  const config = loadConfig(resolvedRoot);
  const dbPath = process.env['PROJECT_MAP_DB_PATH']
    ?? path.resolve(resolvedRoot, config.database.path);

  const db = openDatabase(dbPath);

  // Auto-initialize project if not yet in the database.
  // The DB stores '.' as root_path — paths resolve at runtime.
  let project = findFirstProject(db);
  if (!project) {
    const { projectId } = createProjectWithRepository(
      db,
      path.basename(resolvedRoot),
      resolvedRoot,
      resolvedRoot,
    );
    project = {
      id: projectId,
      name: path.basename(resolvedRoot),
      root_path: '.',
      created_at: '',
      updated_at: '',
      config_json: '{}',
    };
  }

  const repo = findRepositoryByProjectId(db, project.id);
  if (!repo) {
    console.error('Failed to find repository for project');
    closeDatabase(db);
    process.exit(1);
  }

  // Graceful shutdown
  const cleanup = () => {
    closeDatabase(db);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await startServer({ db, config, repositoryId: repo.id, dbPath });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
