/**
 * Export / Import service for portable project databases.
 *
 * Enables sharing a fully-indexed project knowledge base with team
 * members. The exported .pmap.db file is a self-contained SQLite
 * database that any colleague can drop into their local checkout.
 *
 * Export flow:
 *   1. Copy the active database to the exports directory.
 *   2. Stamp export metadata (who, when, project name, schema version).
 *   3. Ensure all paths are relative (portable).
 *
 * Import flow:
 *   1. Validate the imported file is a valid Project Map database.
 *   2. Check schema compatibility.
 *   3. Copy it as the active database (backup the old one).
 *
 * Used by: adapter/tools/export.ts, cli/index.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

import { ExportError, IncompatibleSchemaError } from '../shared/errors.js';
import {
  EXPORT_DIR_NAME,
  EXPORT_FILE_EXTENSION,
  EXPORT_FORMAT_VERSION,
} from '../shared/constants.js';
import { nowISO, hashParams } from '../shared/utils.js';
import { logAudit } from '../repository/audit.js';
import {
  findFirstProject,
  getAllDbMetadata,
  setDbMetadata,
} from '../repository/projects.js';

interface ExportResult {
  export_path: string;
  project_name: string;
  label: string;
  entities_count: number;
  knowledge_count: number;
  edges_count: number;
  exported_at: string;
  format_version: number;
}

interface ImportResult {
  project_name: string;
  entities_count: number;
  knowledge_count: number;
  edges_count: number;
  imported_at: string;
  backup_path: string | null;
}

interface ExportListItem {
  filename: string;
  path: string;
  label: string;
  project_name: string;
  exported_at: string;
  size_bytes: number;
}

/**
 * Exports the current project database as a portable file.
 *
 * The export is a SQLite copy with metadata stamped into db_metadata.
 * All paths are already relative (migration 004), so no rewriting needed.
 */
export function exportDatabase(
  db: DatabaseType,
  projectRoot: string,
  label?: string,
): ExportResult {
  const project = findFirstProject(db);
  if (!project) {
    throw new ExportError('No project found in database. Run sync first.');
  }

  const exportDir = path.resolve(projectRoot, EXPORT_DIR_NAME);
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const timestamp = nowISO().replace(/[:.]/g, '-');
  const safeLabel = label
    ? label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
    : project.name;
  const filename = `${safeLabel}_${timestamp}${EXPORT_FILE_EXTENSION}`;
  const exportPath = path.join(exportDir, filename);

  // SECURITY: validate export path stays within project
  const resolvedExport = path.resolve(exportPath);
  const resolvedRoot = path.resolve(projectRoot);
  if (!resolvedExport.startsWith(resolvedRoot + path.sep)) {
    throw new ExportError('Export path escapes project root');
  }

  // VACUUM INTO creates a synchronous, consistent copy of the database
  copyDatabaseSync(db, exportPath);

  const exportDb = new Database(exportPath);
  try {
    stampExportMetadata(exportDb, project.name, safeLabel);
  } finally {
    exportDb.close();
  }

  const counts = getDbCounts(db);
  const exportedAt = nowISO();

  logAudit(db, {
    operation: 'knowledge_create',
    tool_name: 'export',
    parameters_hash: hashParams({ action: 'export', label }),
    result_summary: `Exported: ${counts.entities} entities, ${counts.knowledge} knowledge, ${counts.edges} edges`,
    entities_affected: counts.entities,
  });

  return {
    export_path: exportPath,
    project_name: project.name,
    label: safeLabel,
    entities_count: counts.entities,
    knowledge_count: counts.knowledge,
    edges_count: counts.edges,
    exported_at: exportedAt,
    format_version: EXPORT_FORMAT_VERSION,
  };
}

/**
 * Imports a portable database file as the active project database.
 *
 * Creates a backup of the current database before replacing it.
 */
export function importDatabase(
  currentDb: DatabaseType,
  _projectRoot: string,
  importPath: string,
  dbPath: string,
): ImportResult {
  const resolvedImport = path.resolve(importPath);
  if (!fs.existsSync(resolvedImport)) {
    throw new ExportError(`Import file not found: ${importPath}`);
  }

  // Validate the imported database
  const importDb = new Database(resolvedImport, { readonly: true });
  try {
    validateImportedDatabase(importDb);
  } finally {
    importDb.close();
  }

  // Backup current database
  let backupPath: string | null = null;
  const resolvedDbPath = path.resolve(dbPath);
  if (fs.existsSync(resolvedDbPath)) {
    const timestamp = nowISO().replace(/[:.]/g, '-');
    backupPath = `${resolvedDbPath}.backup-${timestamp}`;
    currentDb.close();
    fs.copyFileSync(resolvedDbPath, backupPath);
  } else {
    currentDb.close();
  }

  // Replace with imported database
  fs.copyFileSync(resolvedImport, resolvedDbPath);

  // Open the new database and get stats
  const newDb = new Database(resolvedDbPath);
  try {
    const project = findFirstProject(newDb);
    const counts = getDbCounts(newDb);

    setDbMetadata(newDb, 'imported_at', nowISO());
    setDbMetadata(newDb, 'imported_from', path.basename(importPath));

    return {
      project_name: project?.name ?? 'unknown',
      entities_count: counts.entities,
      knowledge_count: counts.knowledge,
      edges_count: counts.edges,
      imported_at: nowISO(),
      backup_path: backupPath,
    };
  } finally {
    newDb.close();
  }
}

/**
 * Lists all exported database files in the exports directory.
 */
export function listExports(projectRoot: string): ExportListItem[] {
  const exportDir = path.resolve(projectRoot, EXPORT_DIR_NAME);
  if (!fs.existsSync(exportDir)) {
    return [];
  }

  const files = fs.readdirSync(exportDir)
    .filter((f) => f.endsWith(EXPORT_FILE_EXTENSION))
    .sort()
    .reverse();

  const results: ExportListItem[] = [];

  for (const filename of files) {
    const filePath = path.join(exportDir, filename);
    const stats = fs.statSync(filePath);

    let label = 'unknown';
    let projectName = 'unknown';
    let exportedAt = stats.mtime.toISOString();

    try {
      const exportDb = new Database(filePath, { readonly: true });
      try {
        const metadata = getAllDbMetadata(exportDb);
        label = metadata['export_label'] ?? label;
        projectName = metadata['project_name'] ?? projectName;
        exportedAt = metadata['exported_at'] ?? exportedAt;
      } finally {
        exportDb.close();
      }
    } catch {
      // Can't read metadata — use defaults from filesystem
    }

    results.push({
      filename,
      path: filePath,
      label,
      project_name: projectName,
      exported_at: exportedAt,
      size_bytes: stats.size,
    });
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function stampExportMetadata(
  exportDb: DatabaseType,
  projectName: string,
  label: string,
): void {
  setDbMetadata(exportDb, 'exported_at', nowISO());
  setDbMetadata(exportDb, 'export_label', label);
  setDbMetadata(exportDb, 'project_name', projectName);
  setDbMetadata(exportDb, 'format_version', String(EXPORT_FORMAT_VERSION));
  setDbMetadata(exportDb, 'portable', 'true');
}

function validateImportedDatabase(db: DatabaseType): void {
  // Check that essential tables exist
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
    AND name IN ('projects', 'repositories', 'entities', 'schema_version')
  `).all() as Array<{ name: string }>;

  const tableNames = new Set(tables.map((t) => t.name));
  const required = ['projects', 'repositories', 'entities', 'schema_version'];

  for (const table of required) {
    if (!tableNames.has(table)) {
      throw new ExportError(`Invalid database: missing table '${table}'`);
    }
  }

  // Check schema version compatibility
  const versionRow = db.prepare(
    'SELECT COALESCE(MAX(version), 0) as max_version FROM schema_version',
  ).get() as { max_version: number };

  if (versionRow.max_version < 4) {
    throw new IncompatibleSchemaError(4, versionRow.max_version);
  }
}

function getDbCounts(db: DatabaseType): {
  entities: number;
  knowledge: number;
  edges: number;
} {
  const entities = (
    db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }
  ).c;
  const knowledge = (
    db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }
  ).c;
  const edges = (
    db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }
  ).c;

  return { entities, knowledge, edges };
}

/**
 * Synchronous database copy using better-sqlite3's serialize API.
 * Returns a complete, self-contained snapshot of the database.
 */
function copyDatabaseSync(db: DatabaseType, destPath: string): void {
  const buffer = db.serialize();
  fs.writeFileSync(destPath, buffer);
}
