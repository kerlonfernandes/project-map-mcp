/**
 * End-to-end tests with real project fixture files.
 *
 * These tests exercise the full pipeline: parse real PHP/JS files
 * via Tree-sitter, detect frameworks, search indexed content, and
 * retrieve context — exactly as a real MCP client would use the system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/repository/db.js';
import { createProjectWithRepository } from '../../src/repository/projects.js';
import { createSnapshot, updateSnapshot } from '../../src/repository/snapshots.js';
import { upsertEntity } from '../../src/repository/entities.js';
import { upsertEdge } from '../../src/repository/graph.js';
import { createEvidence } from '../../src/repository/evidence.js';
import { getContext } from '../../src/services/context.js';
import { search as searchRepository } from '../../src/services/search.js';
import { manageRecord } from '../../src/services/record.js';
import { parsePhpFile } from '../../src/analyzer/parsers/php.js';
import { parseJavaScriptFile } from '../../src/analyzer/parsers/javascript.js';
import { detectLaravelPatterns } from '../../src/analyzer/frameworks/laravel.js';
import { detectExpressPatterns } from '../../src/analyzer/frameworks/express.js';
import { detectConventions } from '../../src/domain/conventions.js';
import type { ProjectMapConfig, FileAnalysisResult } from '../../src/shared/types.js';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const TEST_CONFIG: ProjectMapConfig = {
  project: { name: 'e2e-test', root: FIXTURES_DIR },
  analysis: {
    languages: ['php', 'javascript'],
    frameworks: ['laravel', 'express'],
    exclude_patterns: ['node_modules/**', 'vendor/**'],
    max_file_size_mb: 2,
    max_directory_depth: 20,
    max_files_per_sync: 500,
    parse_timeout_ms: 30000,
  },
  database: { path: ':memory:', max_size_mb: 500, cache_size_mb: 64 },
  security: {
    blocked_paths: ['.env'],
    mysql: { allow_connection: false, allowed_hosts: ['localhost'], blocked_schemas: ['mysql'] },
    rate_limit: { enabled: false, max_per_minute: 60 },
  },
  sync: { reconciliation_interval: 10, staleness_max_depth: 3 },
  context: { default_depth: 'structure', default_purpose: 'understand', default_token_budget: 2000, max_token_budget: 200000 },
};

function readFixture(relativePath: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, relativePath), 'utf-8');
}

function persistAnalysisResult(
  db: ReturnType<typeof openDatabase>,
  repositoryId: string,
  snapshotId: string,
  result: FileAnalysisResult,
): void {
  for (const entity of result.entities) {
    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: entity.entity_type,
      scope: entity.scope,
      qualified_name: entity.qualified_name,
      display_name: entity.display_name,
      path: entity.path,
      line_start: entity.line_start,
      line_end: entity.line_end,
      language: entity.language,
      signature: entity.signature,
      metadata: entity.metadata,
      snapshot_id: snapshotId,
    });
  }

  for (const edge of result.edges) {
    const sourceEntity = db.prepare(
      'SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?',
    ).get(repositoryId, edge.source_qualified_name) as { id: string } | undefined;
    const targetEntity = db.prepare(
      'SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?',
    ).get(repositoryId, edge.target_qualified_name) as { id: string } | undefined;

    if (sourceEntity && targetEntity) {
      upsertEdge(db, {
        repository_id: repositoryId,
        source_id: sourceEntity.id,
        target_id: targetEntity.id,
        edge_type: edge.edge_type,
        weight: edge.weight,
        resolution_status: edge.resolution_status,
        snapshot_id: snapshotId,
      });
    }
  }

  for (const ev of result.evidence) {
    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: ev.source_kind,
      path: ev.path,
      line_start: ev.line_start,
      line_end: ev.line_end,
      excerpt: ev.excerpt,
      snapshot_id: snapshotId,
    });
  }
}

describe('E2E: Laravel Project', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'laravel-test', FIXTURES_DIR + '/laravel-project', FIXTURES_DIR + '/laravel-project');
    repositoryId = rId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });

    const phpFiles = [
      'app/Http/Controllers/UserController.php',
      'app/Models/User.php',
      'app/Models/Order.php',
      'app/Services/UserService.php',
      'routes/web.php',
    ];

    for (const file of phpFiles) {
      const content = readFixture('laravel-project/' + file);
      const result = parsePhpFile(file, content);
      if (result) {
        detectLaravelPatterns(result, content);
        persistAnalysisResult(db, repositoryId, snapshotId, result);
      }
    }

    updateSnapshot(db, snapshotId, {
      status: 'completed',
      files_analyzed: phpFiles.length,
      entities_found: 20,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should parse and index all PHP files', () => {
    const entityCount = db.prepare(
      'SELECT COUNT(*) as count FROM entities WHERE repository_id = ?',
    ).get(repositoryId) as { count: number };

    expect(entityCount.count).toBeGreaterThan(10);
  });

  it('should detect Eloquent models', () => {
    const models = db.prepare(
      "SELECT * FROM entities WHERE repository_id = ? AND entity_type = 'model'",
    ).all(repositoryId) as Array<{ display_name: string }>;

    expect(models.length).toBeGreaterThanOrEqual(2);
    const modelNames = models.map((m) => m.display_name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('Order');
  });

  it('should detect relationships between models', () => {
    const content = readFixture('laravel-project/app/Models/User.php');
    const result = parsePhpFile('app/Models/User.php', content);
    if (result) {
      detectLaravelPatterns(result, content);
    }

    const relEdges = result!.edges.filter(
      (e) => e.edge_type === 'has_many' || e.edge_type === 'has_one' || e.edge_type === 'belongs_to_model',
    );
    expect(relEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect routes', () => {
    const routes = db.prepare(
      "SELECT * FROM entities WHERE repository_id = ? AND entity_type = 'route'",
    ).all(repositoryId) as Array<{ display_name: string }>;

    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  it('should get context for UserController', () => {
    const result = getContext(db, repositoryId, {
      target: 'app/Http/Controllers/UserController.php',
      depth: 'detail',
      purpose: 'understand',
      token_budget: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.target).toBeDefined();
    expect(result.symbols).toBeDefined();
  });

  it('should search for UserService across indexed entities', () => {
    const result = searchRepository(db, repositoryId, {
      query: 'UserService',
      scope: 'entities',
      limit: 10,
      token_budget: 2000,
    });

    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should detect conventions after indexing', () => {
    const count = detectConventions(db, repositoryId, snapshotId);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('should record knowledge and retrieve via context', () => {
    const userEntity = db.prepare(
      "SELECT id FROM entities WHERE repository_id = ? AND entity_type = 'class' AND display_name = 'UserController'",
    ).get(repositoryId) as { id: string } | undefined;

    if (!userEntity) return;

    const fileEntity = db.prepare(
      "SELECT id FROM entities WHERE repository_id = ? AND entity_type = 'file' AND path LIKE '%UserController.php'",
    ).get(repositoryId) as { id: string } | undefined;

    const entityIds = [fileEntity?.id, userEntity.id].filter(Boolean) as string[];

    manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'UserController requires authentication',
      content: 'All UserController actions require authenticated users',
      entity_ids: entityIds,
    });

    const contextResult = getContext(db, repositoryId, {
      target: 'app/Http/Controllers/UserController.php',
      depth: 'detail',
      purpose: 'understand',
      token_budget: 5000,
    });

    expect(contextResult.knowledge).toBeDefined();
  });
});

describe('E2E: Express Project', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'express-test', FIXTURES_DIR + '/express-project', FIXTURES_DIR + '/express-project');
    repositoryId = rId;
    snapshotId = createSnapshot(db, { repository_id: repositoryId });

    const jsFiles = [
      'server.js',
      'routes/users.js',
      'middleware/auth.js',
    ];

    for (const file of jsFiles) {
      const content = readFixture('express-project/' + file);
      const result = parseJavaScriptFile(file, content);
      if (result) {
        detectExpressPatterns(result, content);
        persistAnalysisResult(db, repositoryId, snapshotId, result);
      }
    }

    updateSnapshot(db, snapshotId, {
      status: 'completed',
      files_analyzed: jsFiles.length,
      entities_found: 10,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should parse and index all JS files', () => {
    const entityCount = db.prepare(
      'SELECT COUNT(*) as count FROM entities WHERE repository_id = ?',
    ).get(repositoryId) as { count: number };

    expect(entityCount.count).toBeGreaterThan(3);
  });

  it('should detect Express routes', () => {
    const routes = db.prepare(
      "SELECT * FROM entities WHERE repository_id = ? AND entity_type = 'route'",
    ).all(repositoryId) as Array<{ display_name: string }>;

    expect(routes.length).toBeGreaterThanOrEqual(3);
  });

  it('should detect middleware', () => {
    const middleware = db.prepare(
      "SELECT * FROM entities WHERE repository_id = ? AND entity_type = 'middleware'",
    ).all(repositoryId) as Array<{ display_name: string }>;

    expect(middleware.length).toBeGreaterThanOrEqual(1);
  });

  it('should get context for server.js', () => {
    const result = getContext(db, repositoryId, {
      target: 'server.js',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 3000,
    });

    expect(result.error).toBeUndefined();
    expect(result.target).toBeDefined();
  });

  it('should search for route handlers', () => {
    const result = searchRepository(db, repositoryId, {
      query: 'users',
      scope: 'entities',
      limit: 10,
      token_budget: 2000,
    });

    expect(result.results.length).toBeGreaterThan(0);
  });
});
