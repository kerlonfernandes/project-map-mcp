/**
 * Configuration loader for the Project Map MCP server.
 *
 * Loads and merges project config from project-map.config.json with
 * sensible defaults. Resolves relative paths against the project root.
 *
 * Used by: cli/index.ts, src/index.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ProjectMapConfig } from '../shared/types.js';

const DEFAULT_CONFIG: ProjectMapConfig = {
  project: {
    name: 'unknown',
    root: '.',
  },
  analysis: {
    languages: ['php', 'javascript'],
    frameworks: ['laravel', 'express'],
    exclude_patterns: [
      'node_modules/**',
      'vendor/**',
      'dist/**',
      'build/**',
      '.git/**',
    ],
    max_file_size_mb: 2,
    max_directory_depth: 20,
    max_files_per_sync: 500,
    parse_timeout_ms: 30000,
  },
  database: {
    path: '.project-map/knowledge.db',
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

/**
 * Loads project configuration from project-map.config.json.
 * Falls back to defaults for any missing values.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Merged configuration.
 */
export function loadConfig(projectRoot: string): ProjectMapConfig {
  const configPath = path.join(projectRoot, 'project-map.config.json');

  let userConfig: Partial<ProjectMapConfig> = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    userConfig = JSON.parse(raw) as Partial<ProjectMapConfig>;
  }

  // Deep merge user config over defaults
  const merged: ProjectMapConfig = {
    project: {
      ...DEFAULT_CONFIG.project,
      ...userConfig.project,
      root: path.resolve(projectRoot, userConfig.project?.root ?? '.'),
    },
    analysis: { ...DEFAULT_CONFIG.analysis, ...userConfig.analysis },
    database: { ...DEFAULT_CONFIG.database, ...userConfig.database },
    security: {
      ...DEFAULT_CONFIG.security,
      ...userConfig.security,
      mysql: {
        ...DEFAULT_CONFIG.security.mysql,
        ...userConfig.security?.mysql,
      },
      rate_limit: {
        ...DEFAULT_CONFIG.security.rate_limit,
        ...userConfig.security?.rate_limit,
      },
    },
    sync: { ...DEFAULT_CONFIG.sync, ...userConfig.sync },
    context: { ...DEFAULT_CONFIG.context, ...userConfig.context },
  };

  return merged;
}
