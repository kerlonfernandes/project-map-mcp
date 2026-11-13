/**
 * CLI entry point for Ondbay MCP.
 *
 * Provides commands for project initialization, synchronization,
 * status checking, and search — independent of the MCP protocol.
 * Uses the same Application Services as the MCP adapter.
 *
 * Usage:
 *   ondbay init [path]       — Initialize a new project
 *   ondbay sync [--full]     — Synchronize (index) the project
 *   ondbay status            — Show project and snapshot status
 *   ondbay search <query>    — Search entities and knowledge
 *
 * Used by: end users via command line.
 */

import path from 'node:path';
import fs from 'node:fs';

import { openDatabase, closeDatabase } from '../repository/db.js';
import { createProjectWithRepository, findProjectByPath, findRepositoryByProjectId } from '../repository/projects.js';
import { syncRepository } from '../services/sync.js';
import { search } from '../services/search.js';
import { loadConfig } from './config.js';
import type { OndbayConfig } from '../shared/types.js';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case 'init':
      return handleInit(args[1]);
    case 'sync':
      return handleSync(args.includes('--full'));
    case 'status':
      return handleStatus();
    case 'search':
      return handleSearch(args.slice(1).join(' '));
    case '--help':
    case '-h':
    case undefined:
      return printHelp();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function handleInit(targetPath?: string): Promise<void> {
  const projectRoot = path.resolve(targetPath ?? '.');
  const ondbayDir = path.join(projectRoot, '.ondbay');
  const dbPath = path.join(ondbayDir, 'knowledge.db');
  const configPath = path.join(projectRoot, 'ondbay.config.json');

  if (fs.existsSync(dbPath)) {
    console.error(`Project already initialized at ${projectRoot}`);
    process.exit(1);
  }

  // Create .ondbay directory
  fs.mkdirSync(ondbayDir, { recursive: true });

  // Create default config if not present
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      project: {
        name: path.basename(projectRoot),
        root: '.',
      },
      analysis: {
        languages: ['php', 'javascript'],
        frameworks: ['laravel', 'express'],
        exclude_patterns: [
          'node_modules/**', 'vendor/**', 'dist/**', 'build/**',
          '.git/**', 'storage/**', 'public/build/**',
        ],
        max_file_size_mb: 2,
        max_directory_depth: 20,
        max_files_per_sync: 500,
        parse_timeout_ms: 30000,
      },
      database: {
        path: '.ondbay/knowledge.db',
        max_size_mb: 500,
        cache_size_mb: 64,
      },
      security: {
        blocked_paths: ['.env*', '*.pem', '*.key'],
        mysql: {
          allow_connection: true,
          allowed_hosts: ['localhost', '127.0.0.1'],
          blocked_schemas: ['mysql', 'performance_schema', 'sys'],
        },
        rate_limit: {
          enabled: true,
          max_per_minute: 60,
        },
      },
      sync: {
        reconciliation_interval: 10,
        staleness_max_depth: 3,
      },
      context: {
        default_depth: 'structure',
        default_purpose: 'understand',
        default_token_budget: 2000,
        max_token_budget: 200000,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  // Initialize database
  const db = openDatabase(dbPath);

  // Detect git remote
  let remoteUrl: string | undefined;
  try {
    const { execSync } = await import('node:child_process') as typeof import('node:child_process');
    remoteUrl = execSync('git remote get-url origin', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch { /* not a git repo or no remote */ }

  const { projectId, repositoryId } = createProjectWithRepository(
    db,
    path.basename(projectRoot),
    projectRoot,
    projectRoot,
    remoteUrl,
  );

  closeDatabase(db);

  // Add .ondbay to .gitignore if not already there
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.ondbay')) {
      fs.appendFileSync(gitignorePath, '\n# Ondbay MCP data\n.ondbay/\n');
    }
  }

  console.log(`Ondbay initialized at ${projectRoot}`);
  console.log(`  Project ID: ${projectId}`);
  console.log(`  Repository ID: ${repositoryId}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Config: ${configPath}`);
  console.log('\nRun "ondbay sync" to index the project.');
}

function handleSync(full: boolean): void {
  const { db, repositoryId, config } = openProject();

  const result = syncRepository(db, repositoryId, config, {
    action: full ? 'full' : 'incremental',
    force: false,
  });

  closeDatabase(db);

  console.log(JSON.stringify(result, null, 2));
}

function handleStatus(): void {
  const { db, repositoryId, config } = openProject();

  const result = syncRepository(db, repositoryId, config, {
    action: 'status',
    force: false,
  });

  closeDatabase(db);

  console.log(JSON.stringify(result, null, 2));
}

function handleSearch(query: string): void {
  if (!query.trim()) {
    console.error('Usage: ondbay search <query>');
    process.exit(1);
  }

  const { db, repositoryId } = openProject();

  const result = search(db, repositoryId, {
    query,
    scope: 'all',
    limit: 20,
    token_budget: 5000,
  });

  closeDatabase(db);

  console.log(JSON.stringify(result, null, 2));
}

function printHelp(): void {
  console.log(`
Ondbay Project Intelligence MCP — CLI

Usage:
  ondbay init [path]       Initialize a new project
  ondbay sync [--full]     Synchronize (index) the project
  ondbay status            Show project and snapshot status
  ondbay search <query>    Search entities and knowledge
  ondbay --help            Show this help

Environment:
  ONDBAY_PROJECT_ROOT      Project root directory (default: cwd)
  ONDBAY_DB_PATH           Database path (default: .ondbay/knowledge.db)
`);
}

/**
 * Opens an existing Ondbay project from the current directory.
 * Resolves config, database, and repository ID.
 */
function openProject(): {
  db: ReturnType<typeof openDatabase>;
  repositoryId: string;
  config: OndbayConfig;
} {
  const projectRoot = process.env['ONDBAY_PROJECT_ROOT'] ?? process.cwd();
  const config = loadConfig(projectRoot);
  const dbPath = process.env['ONDBAY_DB_PATH'] ?? path.resolve(projectRoot, config.database.path);

  if (!fs.existsSync(dbPath)) {
    console.error(`No Ondbay project found. Run "ondbay init" first.`);
    process.exit(1);
  }

  const db = openDatabase(dbPath);

  const project = findProjectByPath(db, projectRoot);
  if (!project) {
    console.error(`Project not found in database for: ${projectRoot}`);
    closeDatabase(db);
    process.exit(1);
  }

  const repo = findRepositoryByProjectId(db, project.id);
  if (!repo) {
    console.error(`Repository not found for project: ${project.id}`);
    closeDatabase(db);
    process.exit(1);
  }

  return { db, repositoryId: repo.id, config };
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
