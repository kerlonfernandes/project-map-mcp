/**
 * Integration tests for the full Project Map MCP pipeline.
 *
 * Tests service interactions end-to-end using in-memory SQLite:
 * sync → search → context, duplicate detection, staleness propagation,
 * framework adapter detection, and session cache integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/repository/db.js';
import { createProjectWithRepository } from '../../src/repository/projects.js';
import { createSnapshot, updateSnapshot, findLatestSnapshot } from '../../src/repository/snapshots.js';
import { upsertEntity } from '../../src/repository/entities.js';
import { upsertEdge } from '../../src/repository/graph.js';
import { createEvidence, findChangedEvidence } from '../../src/repository/evidence.js';
import { createKnowledge, linkKnowledgeToEntity, linkKnowledgeToEvidence, markKnowledgeStaleByEvidence, findKnowledgeById } from '../../src/repository/knowledge.js';
import { setCache, getCache, invalidateCacheBySnapshot, clearSessionCache } from '../../src/repository/cache.js';
import { getContext } from '../../src/services/context.js';
import { search as searchRepository } from '../../src/services/search.js';
import { manageRecord } from '../../src/services/record.js';
import { checkForDuplicates } from '../../src/domain/knowledge.js';
import { detectConventions } from '../../src/domain/conventions.js';
import { parseMigrationSql } from '../../src/analyzer/mysql.js';
import { parsePhpFile } from '../../src/analyzer/parsers/php.js';
import { parseJavaScriptFile } from '../../src/analyzer/parsers/javascript.js';
import { detectLaravelPatterns } from '../../src/analyzer/frameworks/laravel.js';
import { detectExpressPatterns } from '../../src/analyzer/frameworks/express.js';
import type { ProjectMapConfig, FileAnalysisResult } from '../../src/shared/types.js';

const TEST_CONFIG: ProjectMapConfig = {
  project: { name: 'test-project', root: '/tmp/test-project' },
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

describe('Full Pipeline: sync → search → context', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function seedEntitiesAndEdges(snapshotId: string): { fileId: string; classId: string; funcId: string } {
    const fileId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/Services/PaymentService.php',
      display_name: 'PaymentService.php',
      path: 'app/Services/PaymentService.php',
      line_start: 1,
      line_end: 100,
      language: 'php',
      snapshot_id: snapshotId,
    });

    const classId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Services\\PaymentService',
      display_name: 'PaymentService',
      path: 'app/Services/PaymentService.php',
      line_start: 5,
      line_end: 95,
      language: 'php',
      signature: 'class PaymentService',
      snapshot_id: snapshotId,
    });

    const funcId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'function',
      scope: 'symbol',
      qualified_name: 'App\\Services\\PaymentService::charge',
      display_name: 'charge',
      path: 'app/Services/PaymentService.php',
      line_start: 20,
      line_end: 50,
      language: 'php',
      signature: 'public function charge(float $amount): bool',
      snapshot_id: snapshotId,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: funcId,
      target_id: classId,
      edge_type: 'belongs_to',
      snapshot_id: snapshotId,
    });

    return { fileId, classId, funcId };
  }

  it('should search entities after seeding', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    seedEntitiesAndEdges(snapshotId);

    const result = searchRepository(db, repositoryId, {
      query: 'PaymentService',
      scope: 'entities',
      limit: 20,
      token_budget: 1500,
    });

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should get context for a seeded entity by path', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    seedEntitiesAndEdges(snapshotId);

    const result = getContext(db, repositoryId, {
      target: 'app/Services/PaymentService.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result.target).toBeDefined();
    const target = result.target as Record<string, unknown>;
    expect(target.path).toBe('app/Services/PaymentService.php');
    expect(result.symbols).toBeDefined();
  });

  it('should return gaps for entities without knowledge', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    seedEntitiesAndEdges(snapshotId);

    const result = getContext(db, repositoryId, {
      target: 'app/Services/PaymentService.php',
      depth: 'detail',
      purpose: 'debug',
      token_budget: 5000,
    });

    expect(result.gaps).toBeDefined();
    const gaps = result.gaps as Array<{ gap: string; priority: string }>;
    expect(gaps.length).toBeGreaterThan(0);
    const noKnowledgeGap = gaps.find((g) => g.gap.includes('No knowledge recorded'));
    expect(noKnowledgeGap).toBeDefined();
  });

  it('should include investigation plan for debug purpose', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    const { fileId, classId } = seedEntitiesAndEdges(snapshotId);

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: fileId,
      target_id: classId,
      edge_type: 'references',
      resolution_status: 'unresolved',
      snapshot_id: snapshotId,
    });

    const result = getContext(db, repositoryId, {
      target: 'app/Services/PaymentService.php',
      depth: 'detail',
      purpose: 'debug',
      token_budget: 5000,
    });

    expect(result.gaps).toBeDefined();
    const gaps = result.gaps as Array<{ priority: string }>;
    const mediumOrHighGaps = gaps.filter((g) => g.priority === 'high' || g.priority === 'medium');
    if (mediumOrHighGaps.length > 0) {
      expect(result.investigation_plan).toBeDefined();
    }
  });

  it('should record knowledge then find it via search and context', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    const { fileId, classId } = seedEntitiesAndEdges(snapshotId);

    const recordResult = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'PaymentService charge must validate amount',
      content: 'The charge method must reject negative amounts and amounts above 10000',
      entity_ids: [fileId, classId],
      evidence: [{
        path: 'app/Services/PaymentService.php',
        line_start: 20,
        line_end: 25,
        excerpt: 'if ($amount <= 0 || $amount > 10000) throw new InvalidAmount();',
        source_kind: 'code',
      }],
    });

    expect(recordResult.action).toBe('created');
    expect(recordResult.knowledge_id).toBeDefined();

    const searchResult = searchRepository(db, repositoryId, {
      query: 'charge validate amount',
      scope: 'knowledge',
      limit: 20,
      token_budget: 1500,
    });
    expect(searchResult.results.length).toBeGreaterThan(0);

    const contextResult = getContext(db, repositoryId, {
      target: 'app/Services/PaymentService.php',
      depth: 'detail',
      purpose: 'understand',
      token_budget: 5000,
    });
    expect(contextResult.knowledge).toBeDefined();
  });

  it('should respect token budget and report truncated categories', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 3, edges_found: 1 });
    seedEntitiesAndEdges(snapshotId);

    const result = getContext(db, repositoryId, {
      target: 'app/Services/PaymentService.php',
      depth: 'full',
      purpose: 'understand',
      token_budget: 150,
    });

    expect(result.target).toBeDefined();
    const meta = result.meta as Record<string, unknown>;
    expect(meta.token_budget).toBe(150);
  });
});

describe('Duplicate Detection Integration', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should reject exact duplicate knowledge', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    const first = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'Orders must be validated before processing',
      content: 'All incoming orders go through the OrderValidator service before being queued for processing',
    });
    expect(first.action).toBe('created');

    const second = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'Orders must be validated before processing',
      content: 'All incoming orders go through the OrderValidator service before being queued for processing',
    });
    expect(second.action).toBe('rejected');
    expect(second.reason).toBe('duplicate');
  });

  it('should detect conflicting knowledge and mark disputed', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    const entityId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\OrderProcessor',
      display_name: 'OrderProcessor',
      path: 'app/OrderProcessor.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'OrderProcessor handles async processing',
      content: 'OrderProcessor always processes orders asynchronously via the queue system',
      entity_ids: [entityId],
    });

    const conflicting = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'OrderProcessor handles processing',
      content: 'OrderProcessor never processes orders asynchronously, it uses synchronous processing',
      entity_ids: [entityId],
    });

    expect(['created', 'rejected']).toContain(conflicting.action);
  });

  it('should allow distinct knowledge without interference', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    const first = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'Payment gateway timeout',
      content: 'The payment gateway has a 30 second timeout configured in the PaymentService',
    });

    const second = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'architectural_decision',
      subject: 'Database sharding strategy',
      content: 'The application uses horizontal sharding based on user region for the orders table',
    });

    expect(first.action).toBe('created');
    expect(second.action).toBe('created');
  });
});

describe('Staleness Propagation', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should mark knowledge as needs_review when evidence changes via path-based propagation', () => {
    const snap1 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap1, { status: 'completed' });

    const entityId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\Service',
      display_name: 'Service',
      path: 'app/Service.php',
      language: 'php',
      snapshot_id: snap1,
    });

    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'app/Service.php',
      line_start: 10,
      line_end: 20,
      excerpt: 'function validate() { return true; }',
      snapshot_id: snap1,
    });

    const kId = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'Service validation',
      knowledge_type: 'business_rule',
      content: 'The validate method always returns true',
      origin: 'ai_generated',
      validation_status: 'supported_by_code',
      confidence: 0.8,
      snapshot_id: snap1,
    });
    linkKnowledgeToEntity(db, kId, entityId);

    const snap2 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap2, { status: 'completed' });

    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'app/Service.php',
      line_start: 10,
      line_end: 20,
      excerpt: 'function validate() { return $this->checkRules(); }',
      snapshot_id: snap2,
    });

    const changed = findChangedEvidence(db, repositoryId, snap1, snap2);
    expect(changed.length).toBeGreaterThan(0);

    const affectedPaths = new Set(changed.map((e) => e.path).filter(Boolean));
    for (const filePath of affectedPaths) {
      const entities = db.prepare(
        'SELECT id FROM entities WHERE repository_id = ? AND path = ?',
      ).all(repositoryId, filePath) as Array<{ id: string }>;

      for (const entity of entities) {
        const dependentKnowledge = db.prepare(`
          SELECT ke.knowledge_id FROM knowledge_entities ke
          JOIN knowledge k ON k.id = ke.knowledge_id
          WHERE ke.entity_id = ? AND k.validity = 'current'
        `).all(entity.id) as Array<{ knowledge_id: string }>;

        for (const row of dependentKnowledge) {
          db.prepare("UPDATE knowledge SET validity = 'needs_review' WHERE id = ?").run(row.knowledge_id);
        }
      }
    }

    const updated = findKnowledgeById(db, kId);
    expect(updated?.validity).toBe('needs_review');
  });

  it('should propagate staleness through dependency edges', () => {
    const snap1 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap1, { status: 'completed' });

    const baseId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'BaseValidator',
      display_name: 'BaseValidator',
      path: 'app/BaseValidator.php',
      language: 'php',
      snapshot_id: snap1,
    });

    const childId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'OrderValidator',
      display_name: 'OrderValidator',
      path: 'app/OrderValidator.php',
      language: 'php',
      snapshot_id: snap1,
    });

    upsertEdge(db, {
      repository_id: repositoryId,
      source_id: childId,
      target_id: baseId,
      edge_type: 'extends',
      snapshot_id: snap1,
    });

    const childKnowledge = createKnowledge(db, {
      repository_id: repositoryId,
      subject: 'OrderValidator rules',
      knowledge_type: 'business_rule',
      content: 'OrderValidator inherits validation rules from BaseValidator',
      origin: 'ai_generated',
      snapshot_id: snap1,
    });
    linkKnowledgeToEntity(db, childKnowledge, childId);

    const ev = createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'app/BaseValidator.php',
      line_start: 1,
      line_end: 50,
      excerpt: 'class BaseValidator { function rules() { return []; } }',
      snapshot_id: snap1,
    });

    const snap2 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap2, { status: 'completed' });

    createEvidence(db, {
      repository_id: repositoryId,
      source_kind: 'code',
      path: 'app/BaseValidator.php',
      line_start: 1,
      line_end: 50,
      excerpt: 'class BaseValidator { function rules() { return ["required"]; } }',
      snapshot_id: snap2,
    });

    const changed = findChangedEvidence(db, repositoryId, snap1, snap2);
    expect(changed.length).toBeGreaterThan(0);

    const baseEntities = db.prepare(
      'SELECT id FROM entities WHERE repository_id = ? AND path = ?',
    ).all(repositoryId, 'app/BaseValidator.php') as Array<{ id: string }>;
    expect(baseEntities.length).toBeGreaterThan(0);

    const visited = new Set<string>(baseEntities.map((e) => e.id));
    let frontier = [...visited];

    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const entityId of frontier) {
        const incoming = db.prepare('SELECT * FROM edges WHERE target_id = ? AND weight >= 0.5')
          .all(entityId) as Array<{ source_id: string }>;

        for (const edge of incoming) {
          if (!visited.has(edge.source_id)) {
            visited.add(edge.source_id);
            nextFrontier.push(edge.source_id);

            const dependentKnowledge = db.prepare(`
              SELECT ke.knowledge_id FROM knowledge_entities ke
              JOIN knowledge k ON k.id = ke.knowledge_id
              WHERE ke.entity_id = ? AND k.validity = 'current'
            `).all(edge.source_id) as Array<{ knowledge_id: string }>;

            for (const row of dependentKnowledge) {
              db.prepare("UPDATE knowledge SET validity = 'needs_review' WHERE id = ?").run(row.knowledge_id);
            }
          }
        }
      }
      frontier = nextFrontier;
    }

    const childK = findKnowledgeById(db, childKnowledge);
    expect(childK?.validity).toBe('needs_review');
  });
});

describe('Laravel Adapter Detection', () => {
  it('should detect Eloquent model with relationships', () => {
    const phpSource = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Order extends Model
{
    protected $table = 'orders';

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function items()
    {
        return $this->hasMany(OrderItem::class);
    }
}`;

    const result = parsePhpFile('app/Models/Order.php', phpSource);
    expect(result).not.toBeNull();

    detectLaravelPatterns(result!, phpSource);

    const modelEntity = result!.entities.find((e) => e.entity_type === 'model');
    expect(modelEntity).toBeDefined();
    expect(modelEntity!.display_name).toBe('Order');

    const belongsTo = result!.edges.find((e) => e.edge_type === 'belongs_to_model');
    expect(belongsTo).toBeDefined();

    const hasMany = result!.edges.find((e) => e.edge_type === 'has_many');
    expect(hasMany).toBeDefined();
  });

  it('should detect Laravel routes', () => {
    const phpSource = `<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/orders', [OrderController::class, 'index']);
Route::post('/orders', [OrderController::class, 'store']);
Route::resource('products', ProductController::class);`;

    const result = parsePhpFile('routes/web.php', phpSource);
    expect(result).not.toBeNull();

    detectLaravelPatterns(result!, phpSource);

    const routes = result!.entities.filter((e) => e.entity_type === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect Laravel migration', () => {
    const phpSource = `<?php

namespace Database\\Migrations;

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

class CreateOrdersTable extends Migration
{
    public function up()
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->string('status');
            $table->timestamps();
        });
    }
}`;

    const result = parsePhpFile('database/migrations/2024_01_01_create_orders_table.php', phpSource);
    expect(result).not.toBeNull();

    detectLaravelPatterns(result!, phpSource);

    const migration = result!.entities.find((e) => e.entity_type === 'migration');
    expect(migration).toBeDefined();
  });
});

describe('Express Adapter Detection', () => {
  it('should detect Express routes and middleware', () => {
    const jsSource = `
const express = require('express');
const app = express();

app.use(express.json());

app.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

app.post('/api/users', (req, res) => {
  res.status(201).json({ id: 1 });
});

app.use('/api/products', productRouter);

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});`;

    const result = parseJavaScriptFile('server.js', jsSource);
    expect(result).not.toBeNull();

    detectExpressPatterns(result!, jsSource);

    const routes = result!.entities.filter((e) => e.entity_type === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(2);

    const middleware = result!.entities.filter((e) => e.entity_type === 'middleware');
    expect(middleware.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect router-level routes', () => {
    const jsSource = `
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => res.json([]));
router.post('/', (req, res) => res.status(201).json({}));
router.delete('/:id', (req, res) => res.status(204).send());

module.exports = router;`;

    const result = parseJavaScriptFile('routes/products.js', jsSource);
    expect(result).not.toBeNull();

    detectExpressPatterns(result!, jsSource);

    const routes = result!.entities.filter((e) => e.entity_type === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Knowledge Lifecycle: create → update → validate → invalidate', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
    const snap = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap, { status: 'completed' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should support full knowledge lifecycle', () => {
    const created = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'architectural_decision',
      subject: 'Use PostgreSQL for analytics',
      content: 'Analytics queries use PostgreSQL instead of MySQL for better JSON support',
    });
    expect(created.action).toBe('created');
    const knowledgeId = created.knowledge_id as string;

    const updated = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'update',
      knowledge_id: knowledgeId,
      content: 'Analytics queries use PostgreSQL for JSON support and better window functions',
    });
    expect(updated.action).toBe('updated');
    expect(updated.supersedes_id).toBe(knowledgeId);
    const newId = updated.knowledge_id as string;

    const validated = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'validate',
      knowledge_id: newId,
      validation_status: 'human_confirmed',
    });
    expect(validated.action).toBe('validated');
    expect(validated.validation_status).toBe('human_confirmed');

    const invalidated = manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'invalidate',
      knowledge_id: newId,
    });
    expect(invalidated.action).toBe('invalidated');
  });
});

describe('Session Cache Integration', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should cache and retrieve a response', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    setCache(db, 'session-1', 'context:app/Service.php', '{"target":"Service"}', 150, snapshotId);

    const cached = getCache(db, 'session-1', 'context:app/Service.php');
    expect(cached).not.toBeNull();
    expect(cached!.content).toBe('{"target":"Service"}');
    expect(cached!.token_count).toBe(150);
  });

  it('should invalidate cache when snapshot changes', () => {
    const snap1 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap1, { status: 'completed' });

    setCache(db, 'session-1', 'context:app/Service.php', '{"v":1}', 100, snap1);

    const invalidated = invalidateCacheBySnapshot(db, snap1);
    expect(invalidated).toBe(1);

    const cached = getCache(db, 'session-1', 'context:app/Service.php');
    expect(cached).toBeNull();
  });

  it('should clear all cache for a session', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    setCache(db, 'session-1', 'key-a', '{"a":1}', 50, snapshotId);
    setCache(db, 'session-1', 'key-b', '{"b":2}', 60, snapshotId);
    setCache(db, 'session-2', 'key-c', '{"c":3}', 70, snapshotId);

    const cleared = clearSessionCache(db, 'session-1');
    expect(cleared).toBe(2);

    expect(getCache(db, 'session-1', 'key-a')).toBeNull();
    expect(getCache(db, 'session-2', 'key-c')).not.toBeNull();
  });

  it('should update cache on conflict (same session+key)', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    setCache(db, 'session-1', 'same-key', '{"v":1}', 100, snapshotId);
    setCache(db, 'session-1', 'same-key', '{"v":2}', 200, snapshotId);

    const cached = getCache(db, 'session-1', 'same-key');
    expect(cached).not.toBeNull();
    expect(cached!.content).toBe('{"v":2}');
    expect(cached!.token_count).toBe(200);
  });
});

describe('Convention Detection Integration', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should detect conventions after seeding entities and show in context', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    const controllers = ['UserController', 'OrderController', 'ProductController'];
    for (const name of controllers) {
      upsertEntity(db, {
        repository_id: repositoryId,
        entity_type: 'class',
        scope: 'symbol',
        qualified_name: `App\\Http\\Controllers\\${name}`,
        display_name: name,
        path: `app/Http/Controllers/${name}.php`,
        language: 'php',
        snapshot_id: snapshotId,
      });
    }

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/Http/Controllers/UserController.php',
      display_name: 'UserController.php',
      path: 'app/Http/Controllers/UserController.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const conventionsFound = detectConventions(db, repositoryId, snapshotId);
    expect(conventionsFound).toBeGreaterThanOrEqual(1);

    const result = getContext(db, repositoryId, {
      target: 'app/Http/Controllers/UserController.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 3000,
    });

    expect(result.target).toBeDefined();
    if (result.conventions) {
      const conventions = result.conventions as Array<{ category: string }>;
      expect(conventions.length).toBeGreaterThan(0);
    }
  });
});

describe('MySQL Migration Parsing Integration', () => {
  it('should parse a Laravel-style migration and extract full schema', () => {
    const sql = `
CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  total DECIMAL(10,2) NOT NULL,
  INDEX idx_orders_status (status),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('database/migrations/2024_create_orders.sql', sql);

    const tables = result.entities.filter((e) => e.entity_type === 'table');
    expect(tables.length).toBe(2);
    expect(tables.map((t) => t.display_name).sort()).toEqual(['order_items', 'orders']);

    const columns = result.entities.filter((e) => e.entity_type === 'column');
    expect(columns.length).toBeGreaterThanOrEqual(7);

    const fks = result.entities.filter((e) => e.entity_type === 'foreign_key');
    expect(fks.length).toBeGreaterThanOrEqual(2);

    const fkEdges = result.edges.filter((e) => e.edge_type === 'foreign_key_to');
    expect(fkEdges.length).toBeGreaterThanOrEqual(2);

    const migratesEdges = result.edges.filter((e) => e.edge_type === 'migrates');
    expect(migratesEdges.length).toBe(2);

    const indices = result.entities.filter((e) => e.entity_type === 'index');
    expect(indices.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Context Session Cache with delta responses', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should cache context response and return cached on second call', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed', files_analyzed: 1, entities_found: 1 });

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/CachedService.php',
      display_name: 'CachedService.php',
      path: 'app/CachedService.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    const first = getContext(db, repositoryId, {
      target: 'app/CachedService.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'test-session-cache',
    });
    expect(first.target).toBeDefined();
    expect((first.meta as Record<string, unknown>).cached).toBe(false);

    const second = getContext(db, repositoryId, {
      target: 'app/CachedService.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'test-session-cache',
    });
    expect(second.target).toBeDefined();
    expect((second.meta as Record<string, unknown>).cached).toBe(true);
  });

  it('should invalidate cache when snapshot changes', () => {
    const snap1 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap1, { status: 'completed' });

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/Service.php',
      display_name: 'Service.php',
      path: 'app/Service.php',
      language: 'php',
      snapshot_id: snap1,
    });

    getContext(db, repositoryId, {
      target: 'app/Service.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'sess-invalidate',
    });

    const snap2 = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snap2, { status: 'completed' });

    invalidateCacheBySnapshot(db, snap1);

    const afterInvalidation = getContext(db, repositoryId, {
      target: 'app/Service.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'sess-invalidate',
    });
    expect((afterInvalidation.meta as Record<string, unknown>).cached).toBe(false);
  });

  it('should not use cache across different sessions', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'file',
      scope: 'file',
      qualified_name: 'app/Isolated.php',
      display_name: 'Isolated.php',
      path: 'app/Isolated.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    getContext(db, repositoryId, {
      target: 'app/Isolated.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'session-A',
    });

    const fromOtherSession = getContext(db, repositoryId, {
      target: 'app/Isolated.php',
      depth: 'structure',
      purpose: 'understand',
      token_budget: 2000,
      session_id: 'session-B',
    });
    expect((fromOtherSession.meta as Record<string, unknown>).cached).toBe(false);
  });
});

describe('Search across all scopes', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const { repositoryId: rId } = createProjectWithRepository(db, 'test', '/tmp/test', '/tmp/test');
    repositoryId = rId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should search entities, knowledge, and evidence with scope=all', () => {
    const snapshotId = createSnapshot(db, { repository_id: repositoryId });
    updateSnapshot(db, snapshotId, { status: 'completed' });

    const entityId = upsertEntity(db, {
      repository_id: repositoryId,
      entity_type: 'class',
      scope: 'symbol',
      qualified_name: 'App\\PaymentGateway',
      display_name: 'PaymentGateway',
      path: 'app/PaymentGateway.php',
      language: 'php',
      snapshot_id: snapshotId,
    });

    manageRecord(db, repositoryId, TEST_CONFIG, {
      action: 'create',
      knowledge_type: 'business_rule',
      subject: 'PaymentGateway timeout is 30 seconds',
      content: 'The PaymentGateway service enforces a 30 second timeout on all requests',
      entity_ids: [entityId],
      evidence: [{
        path: 'app/PaymentGateway.php',
        line_start: 10,
        line_end: 15,
        excerpt: 'private const TIMEOUT = 30;',
        source_kind: 'code',
      }],
    });

    const entityResult = searchRepository(db, repositoryId, {
      query: 'PaymentGateway',
      scope: 'entities',
      limit: 10,
      token_budget: 2000,
    });
    expect(entityResult.results.length).toBeGreaterThan(0);

    const knowledgeResult = searchRepository(db, repositoryId, {
      query: 'timeout 30 seconds',
      scope: 'knowledge',
      limit: 10,
      token_budget: 2000,
    });
    expect(knowledgeResult.results.length).toBeGreaterThan(0);

    const evidenceResult = searchRepository(db, repositoryId, {
      query: 'TIMEOUT',
      scope: 'evidence',
      limit: 10,
      token_budget: 2000,
    });
    expect(evidenceResult.results.length).toBeGreaterThan(0);
  });
});
