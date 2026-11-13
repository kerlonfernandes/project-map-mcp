/**
 * Sync Engine — orchestrates repository scanning and indexing.
 *
 * Handles both full scans (first indexing or forced re-index) and
 * incremental syncs (process only changed files via git diff).
 * Each sync creates a snapshot that tracks what was analyzed.
 *
 * Pipeline: detect changes → classify files → parse each →
 * extract entities/edges/evidence → persist → propagate staleness.
 *
 * Used by: adapter/tools/sync.ts, cli/index.ts.
 */

import type { Database } from 'better-sqlite3';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fg from 'fast-glob';

import type { ProjectMapConfig, FileAnalysisResult } from '../shared/types.js';
import {
  validatePath,
  isParseableFile,
  isBinaryFile,
  hashParams,
} from '../shared/utils.js';
import { createSnapshot, updateSnapshot, findLatestSnapshot } from '../repository/snapshots.js';
import { upsertEntity, deleteEntitiesByPath } from '../repository/entities.js';
import { upsertEdge, deleteEdgesBySourcePath, countUnresolvedEdges, findIncomingEdges } from '../repository/graph.js';
import { createEvidence, deleteEvidenceByPath, findChangedEvidence } from '../repository/evidence.js';
import { countKnowledgeByValidity, markKnowledgeStaleByEvidence } from '../repository/knowledge.js';
import { invalidateCacheBySnapshot } from '../repository/cache.js';
import { logAudit } from '../repository/audit.js';
import { analyzeFile } from '../analyzer/core.js';
import { detectConventions } from '../domain/conventions.js';
import { analyzeSchema, parseMigrationSql } from '../analyzer/mysql.js';
import { reconcile, shouldReconcile } from '../domain/reconciliation.js';

interface SyncInput {
  action: 'status' | 'incremental' | 'full' | 'analyze_file' | 'analyze_schema';
  path?: string;
  connection?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  force: boolean;
}

/**
 * Main entry point for all sync operations.
 * Routes to the appropriate handler based on the action.
 */
export async function syncRepository(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  input: SyncInput,
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'status':
      return getSyncStatus(db, repositoryId, config);
    case 'full':
      return runFullSync(db, repositoryId, config);
    case 'incremental':
      return runIncrementalSync(db, repositoryId, config);
    case 'analyze_file':
      return analyzeSpecificFile(db, repositoryId, config, input.path!);
    case 'analyze_schema':
      return runSchemaAnalysis(db, repositoryId, config, input.connection);
  }
}

/**
 * Returns the current synchronization status.
 * Shows latest snapshot, pending changes, and staleness info.
 */
function getSyncStatus(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
): Record<string, unknown> {
  const projectRoot = config.project.root;
  const latestSnapshot = findLatestSnapshot(db, repositoryId);

  const gitInfo = getGitInfo(projectRoot);
  const pendingChanges = latestSnapshot
    ? getChangedFiles(projectRoot, latestSnapshot.head_commit ?? '')
    : { modified: [], added: [], deleted: [], renamed: [] };

  const knowledgeValidity = countKnowledgeByValidity(db, repositoryId);
  const unresolvedEdges = countUnresolvedEdges(db, repositoryId);

  return {
    repository: {
      path: projectRoot,
      branch: gitInfo.branch,
      head_commit: gitInfo.headCommit,
    },
    last_snapshot: latestSnapshot
      ? {
          id: latestSnapshot.id,
          status: latestSnapshot.status,
          commit: latestSnapshot.head_commit,
          files_analyzed: latestSnapshot.files_analyzed,
          entities: latestSnapshot.entities_found,
          edges: latestSnapshot.edges_found,
          completed_at: latestSnapshot.completed_at,
        }
      : null,
    pending_changes: {
      modified_files: pendingChanges.modified.length,
      new_files: pendingChanges.added.length,
      deleted_files: pendingChanges.deleted.length,
      files: [
        ...pendingChanges.modified,
        ...pendingChanges.added,
        ...pendingChanges.deleted,
      ].slice(0, 50),
    },
    staleness: {
      stale_knowledge: knowledgeValidity['stale'] ?? 0,
      needs_review: knowledgeValidity['needs_review'] ?? 0,
      unresolved_edges: unresolvedEdges,
    },
    meta: { tokens_used: 0 },
  };
}

/**
 * Runs a full repository scan.
 * Discovers all parseable files and analyzes each one.
 */
function runFullSync(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
): Record<string, unknown> {
  const startTime = Date.now();
  const projectRoot = config.project.root;
  const gitInfo = getGitInfo(projectRoot);

  const snapshotId = createSnapshot(db, {
    repository_id: repositoryId,
    branch_name: gitInfo.branch ?? undefined,
    head_commit: gitInfo.headCommit ?? undefined,
  });

  updateSnapshot(db, snapshotId, { status: 'running' });

  const files = discoverFiles(projectRoot, config);
  let filesAnalyzed = 0;
  let totalEntities = 0;
  let totalEdges = 0;
  const errors: string[] = [];

  const persistFile = db.transaction((result: FileAnalysisResult) => {
    // Persist entities
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
        metadata: entity.metadata as Record<string, unknown>,
        snapshot_id: snapshotId,
      });
    }

    // Persist evidence
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

    // Persist edges (deferred — need entity IDs resolved)
    for (const edge of result.edges) {
      const sourceEntity = db
        .prepare('SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?')
        .get(repositoryId, edge.source_qualified_name) as { id: string } | undefined;
      const targetEntity = db
        .prepare('SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?')
        .get(repositoryId, edge.target_qualified_name) as { id: string } | undefined;

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
        totalEdges++;
      }
    }

    totalEntities += result.entities.length;
  });

  for (const file of files) {
    try {
      const result = analyzeFile(file, projectRoot, config);
      if (result) {
        persistFile(result);
        filesAnalyzed++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: ${msg}`);
    }
  }

  const durationMs = Date.now() - startTime;
  const status = errors.length > 0 ? 'partial' : 'completed';

  updateSnapshot(db, snapshotId, {
    status,
    files_analyzed: filesAnalyzed,
    files_total: files.length,
    entities_found: totalEntities,
    edges_found: totalEdges,
    duration_ms: durationMs,
    error_message: errors.length > 0 ? errors.join('\n') : undefined,
  });

  const conventionsFound = detectConventions(db, repositoryId, snapshotId);

  // Reconciliation: run every N snapshots
  let reconciliationResult: Record<string, unknown> | undefined;
  if (shouldReconcile(db, repositoryId, config.sync.reconciliation_interval)) {
    reconciliationResult = { ...reconcile(db, repositoryId) };
  }

  logAudit(db, {
    operation: 'sync_full',
    tool_name: 'sync',
    parameters_hash: hashParams({ action: 'full' }),
    result_summary: `${filesAnalyzed}/${files.length} files, ${totalEntities} entities, ${totalEdges} edges, ${conventionsFound} conventions`,
    entities_affected: totalEntities,
    duration_ms: durationMs,
  });

  return {
    snapshot_id: snapshotId,
    status,
    files_analyzed: filesAnalyzed,
    files_total: files.length,
    entities_found: totalEntities,
    edges_found: totalEdges,
    conventions_found: conventionsFound,
    reconciliation: reconciliationResult,
    duration_ms: durationMs,
    errors: errors.length > 0 ? errors : undefined,
    meta: { tokens_used: 0 },
  };
}

/**
 * Runs an incremental sync — only processes files changed since the last snapshot.
 */
function runIncrementalSync(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
): Record<string, unknown> {
  const latestSnapshot = findLatestSnapshot(db, repositoryId);

  // No previous snapshot — fall back to full sync
  if (!latestSnapshot) {
    return runFullSync(db, repositoryId, config);
  }

  const startTime = Date.now();
  const projectRoot = config.project.root;
  const gitInfo = getGitInfo(projectRoot);

  const changes = getChangedFiles(projectRoot, latestSnapshot.head_commit ?? '');
  const filesToProcess = [...changes.modified, ...changes.added].filter(isParseableFile);

  if (filesToProcess.length === 0 && changes.deleted.length === 0) {
    return {
      status: 'no_changes',
      message: 'No parseable files changed since last snapshot',
      meta: { tokens_used: 0 },
    };
  }

  const snapshotId = createSnapshot(db, {
    repository_id: repositoryId,
    branch_name: gitInfo.branch ?? undefined,
    head_commit: gitInfo.headCommit ?? undefined,
  });

  updateSnapshot(db, snapshotId, { status: 'running' });

  let filesAnalyzed = 0;
  let totalEntities = 0;
  let totalEdges = 0;
  const errors: string[] = [];

  // Handle deleted files
  for (const file of changes.deleted) {
    db.transaction(() => {
      deleteEdgesBySourcePath(db, repositoryId, file);
      deleteEvidenceByPath(db, repositoryId, file);
      deleteEntitiesByPath(db, repositoryId, file);
    })();
  }

  // Handle modified and added files
  for (const file of filesToProcess) {
    try {
      // Clean old data for this file
      db.transaction(() => {
        deleteEdgesBySourcePath(db, repositoryId, file);
        deleteEvidenceByPath(db, repositoryId, file);
        deleteEntitiesByPath(db, repositoryId, file);
      })();

      const result = analyzeFile(file, projectRoot, config);
      if (result) {
        db.transaction(() => {
          for (const entity of result.entities) {
            upsertEntity(db, {
              repository_id: repositoryId,
              ...entity,
              metadata: entity.metadata as Record<string, unknown>,
              snapshot_id: snapshotId,
            });
          }

          for (const ev of result.evidence) {
            createEvidence(db, {
              repository_id: repositoryId,
              ...ev,
              snapshot_id: snapshotId,
            });
          }

          for (const edge of result.edges) {
            const source = db
              .prepare('SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?')
              .get(repositoryId, edge.source_qualified_name) as { id: string } | undefined;
            const target = db
              .prepare('SELECT id FROM entities WHERE repository_id = ? AND qualified_name = ?')
              .get(repositoryId, edge.target_qualified_name) as { id: string } | undefined;

            if (source && target) {
              upsertEdge(db, {
                repository_id: repositoryId,
                source_id: source.id,
                target_id: target.id,
                edge_type: edge.edge_type,
                weight: edge.weight,
                resolution_status: edge.resolution_status,
                snapshot_id: snapshotId,
              });
              totalEdges++;
            }
          }

          totalEntities += result.entities.length;
        })();
        filesAnalyzed++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: ${msg}`);
    }
  }

  // ── Staleness propagation ─────────────────────────────────────────
  const staleKnowledge = propagateStaleness(
    db,
    repositoryId,
    latestSnapshot.id,
    snapshotId,
    config.sync.staleness_max_depth,
  );

  // Invalidate session cache for affected targets
  invalidateCacheBySnapshot(db, snapshotId);

  const durationMs = Date.now() - startTime;
  const status = errors.length > 0 ? 'partial' : 'completed';

  updateSnapshot(db, snapshotId, {
    status,
    files_analyzed: filesAnalyzed,
    files_total: filesToProcess.length,
    entities_found: totalEntities,
    edges_found: totalEdges,
    duration_ms: durationMs,
    error_message: errors.length > 0 ? errors.join('\n') : undefined,
  });

  logAudit(db, {
    operation: 'sync_incremental',
    tool_name: 'sync',
    parameters_hash: hashParams({ action: 'incremental' }),
    result_summary: `${filesAnalyzed} files, ${totalEntities} entities, ${totalEdges} edges`,
    entities_affected: totalEntities,
    duration_ms: durationMs,
  });

  return {
    snapshot_id: snapshotId,
    status,
    files_analyzed: filesAnalyzed,
    deleted_files: changes.deleted.length,
    entities_found: totalEntities,
    edges_found: totalEdges,
    stale_knowledge: staleKnowledge,
    duration_ms: durationMs,
    errors: errors.length > 0 ? errors : undefined,
    meta: { tokens_used: 0 },
  };
}

/**
 * Analyzes a single specified file.
 */
function analyzeSpecificFile(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  filePath: string,
): Record<string, unknown> {
  const projectRoot = config.project.root;
  const validatedPath = validatePath(filePath, projectRoot);
  const relativePath = path.relative(projectRoot, validatedPath);

  const latestSnapshot = findLatestSnapshot(db, repositoryId);
  const snapshotId = latestSnapshot?.id ?? createSnapshot(db, {
    repository_id: repositoryId,
  });

  const result = analyzeFile(relativePath, projectRoot, config);
  if (!result) {
    return { error: `File not parseable: ${relativePath}` };
  }

  db.transaction(() => {
    deleteEdgesBySourcePath(db, repositoryId, relativePath);
    deleteEvidenceByPath(db, repositoryId, relativePath);
    deleteEntitiesByPath(db, repositoryId, relativePath);

    for (const entity of result.entities) {
      upsertEntity(db, {
        repository_id: repositoryId,
        ...entity,
        metadata: entity.metadata as Record<string, unknown>,
        snapshot_id: snapshotId,
      });
    }

    for (const ev of result.evidence) {
      createEvidence(db, {
        repository_id: repositoryId,
        ...ev,
        snapshot_id: snapshotId,
      });
    }
  })();

  return {
    file: relativePath,
    entities: result.entities.length,
    edges: result.edges.length,
    evidence: result.evidence.length,
    errors: result.errors.length > 0 ? result.errors : undefined,
    meta: { tokens_used: 0 },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Staleness Propagation
// ──────────────────────────────────────────────────────────────────────

/**
 * Propagates staleness through the dependency graph after an incremental sync.
 *
 * When evidence content_hash changes between snapshots:
 * 1. Find all changed evidence records.
 * 2. Mark directly linked knowledge as needs_review.
 * 3. Walk incoming edges (dependents) up to maxDepth.
 * 4. Mark knowledge of dependent entities as needs_review too.
 *
 * Edge weights control propagation: extends (0.9) propagates strongly,
 * references (0.3) propagates weakly.
 *
 * @returns Number of knowledge records marked stale.
 */
function propagateStaleness(
  db: Database,
  repositoryId: string,
  oldSnapshotId: string,
  newSnapshotId: string,
  maxDepth: number,
): number {
  const changedEvidence = findChangedEvidence(db, repositoryId, oldSnapshotId, newSnapshotId);
  if (changedEvidence.length === 0) return 0;

  // Step 1: Mark knowledge directly linked to changed evidence
  const changedEvidenceIds = changedEvidence.map((e) => e.id);
  let totalStale = markKnowledgeStaleByEvidence(db, changedEvidenceIds);

  // Step 2: Find entities affected by the changed evidence (by path)
  const affectedPaths = new Set(changedEvidence.map((e) => e.path).filter(Boolean));
  const affectedEntityIds = new Set<string>();

  for (const filePath of affectedPaths) {
    const entities = db.prepare(
      'SELECT id FROM entities WHERE repository_id = ? AND path = ?',
    ).all(repositoryId, filePath) as Array<{ id: string }>;

    for (const e of entities) {
      affectedEntityIds.add(e.id);
    }
  }

  // Step 3: Walk incoming edges (who depends on affected entities)
  const visited = new Set<string>(affectedEntityIds);
  let frontier = [...affectedEntityIds];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const entityId of frontier) {
      const incoming = findIncomingEdges(db, entityId);

      for (const edge of incoming) {
        // Only propagate through strong edges
        if (edge.weight < 0.5) continue;

        const dependentId = edge.source_id;
        if (visited.has(dependentId)) continue;

        visited.add(dependentId);
        nextFrontier.push(dependentId);

        // Mark knowledge of the dependent entity
        const dependentKnowledge = db.prepare(`
          SELECT ke.knowledge_id
          FROM knowledge_entities ke
          JOIN knowledge k ON k.id = ke.knowledge_id
          WHERE ke.entity_id = ?
            AND k.validity = 'current'
        `).all(dependentId) as Array<{ knowledge_id: string }>;

        for (const row of dependentKnowledge) {
          db.prepare(`
            UPDATE knowledge SET validity = 'needs_review' WHERE id = ?
          `).run(row.knowledge_id);
          totalStale++;
        }
      }
    }

    frontier = nextFrontier;
  }

  return totalStale;
}

// ──────────────────────────────────────────────────────────────────────
// Git Helpers
// ──────────────────────────────────────────────────────────────────────

interface GitInfo {
  branch: string | null;
  headCommit: string | null;
}

function getGitInfo(projectRoot: string): GitInfo {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const headCommit = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    return { branch, headCommit };
  } catch {
    return { branch: null, headCommit: null };
  }
}

interface FileChanges {
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: string[];
}

function getChangedFiles(projectRoot: string, sinceCommit: string): FileChanges {
  const result: FileChanges = { modified: [], added: [], deleted: [], renamed: [] };

  if (!sinceCommit) return result;

  try {
    const diff = execSync(`git diff --name-status ${sinceCommit} HEAD`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });

    for (const line of diff.split('\n').filter(Boolean)) {
      const [status, ...fileParts] = line.split('\t');
      const file = fileParts[0];
      if (!file) continue;

      switch (status?.[0]) {
        case 'M': result.modified.push(file); break;
        case 'A': result.added.push(file); break;
        case 'D': result.deleted.push(file); break;
        case 'R': result.renamed.push(file); break;
      }
    }

    // Also check working tree changes
    const workingDiff = execSync('git diff --name-status', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });

    for (const line of workingDiff.split('\n').filter(Boolean)) {
      const [status, ...fileParts] = line.split('\t');
      const file = fileParts[0];
      if (!file) continue;

      if (status?.[0] === 'M' && !result.modified.includes(file)) {
        result.modified.push(file);
      }
    }
  } catch {
    // Git not available or not a git repo — return empty
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// File Discovery
// ──────────────────────────────────────────────────────────────────────

function discoverFiles(projectRoot: string, config: ProjectMapConfig): string[] {
  const patterns = ['**/*.php', '**/*.js', '**/*.mjs', '**/*.cjs'];
  const ignore = config.analysis.exclude_patterns;

  const files = fg.sync(patterns, {
    cwd: projectRoot,
    ignore,
    absolute: false,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    deep: config.analysis.max_directory_depth,
  });

  return files.filter((f) => !isBinaryFile(f)).slice(0, config.analysis.max_files_per_sync);
}

// ──────────────────────────────────────────────────────────────────────
// MySQL Schema Analysis
// ──────────────────────────────────────────────────────────────────────

async function runSchemaAnalysis(
  db: Database,
  repositoryId: string,
  config: ProjectMapConfig,
  connection?: SyncInput['connection'],
): Promise<Record<string, unknown>> {
  const snapshotId = createSnapshot(db, { repository_id: repositoryId });
  const errors: string[] = [];
  let totalEntities = 0;
  let totalEdges = 0;
  let totalTables = 0;

  try {
    // Source 1: Parse migration SQL files from the repository
    const projectRoot = config.project.root;
    const migrationPatterns = [
      'database/migrations/**/*.sql',
      'migrations/**/*.sql',
      'db/migrations/**/*.sql',
    ];

    const migrationFiles = fg.sync(migrationPatterns, {
      cwd: projectRoot,
      absolute: false,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    });

    for (const relPath of migrationFiles) {
      try { validatePath(relPath, projectRoot); } catch { continue; }

      try {
        const fs = await import('node:fs');
        const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
        const result = parseMigrationSql(relPath, content);

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
          totalEntities++;
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
            totalEdges++;
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

        errors.push(...result.errors);
      } catch (err) {
        errors.push(`Failed to parse ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const tablesFromMigrations = db.prepare(
      "SELECT COUNT(*) as count FROM entities WHERE repository_id = ? AND entity_type = 'table'",
    ).get(repositoryId) as { count: number };
    totalTables += tablesFromMigrations.count;

    // Source 2: Live MySQL connection (optional)
    if (connection) {
      const schemaResult = await analyzeSchema(connection, config);

      for (const entity of schemaResult.entities) {
        upsertEntity(db, {
          repository_id: repositoryId,
          entity_type: entity.entity_type,
          scope: entity.scope,
          qualified_name: entity.qualified_name,
          display_name: entity.display_name,
          path: entity.path,
          language: entity.language,
          metadata: entity.metadata,
          snapshot_id: snapshotId,
        });
        totalEntities++;
      }

      for (const edge of schemaResult.edges) {
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
          totalEdges++;
        }
      }

      for (const ev of schemaResult.evidence) {
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

      totalTables += schemaResult.tables_found;
      errors.push(...schemaResult.errors);
    }

    updateSnapshot(db, snapshotId, {
      status: 'completed',
      entities_found: totalEntities,
      edges_found: totalEdges,
    });

    logAudit(db, {
      operation: 'sync_schema',
      tool_name: 'sync',
      parameters_hash: hashParams({ action: 'analyze_schema', connection: !!connection }),
      result_summary: `Schema analysis: ${totalTables} tables, ${totalEntities} entities, ${totalEdges} edges`,
      entities_affected: totalEntities,
    });

    return {
      snapshot_id: snapshotId,
      tables_found: totalTables,
      entities_found: totalEntities,
      edges_found: totalEdges,
      migration_files_parsed: migrationFiles.length,
      live_connection: !!connection,
      errors,
    };
  } catch (error) {
    updateSnapshot(db, snapshotId, { status: 'failed' });
    return {
      error: `Schema analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      snapshot_id: snapshotId,
    };
  }
}
