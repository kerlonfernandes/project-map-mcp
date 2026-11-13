/**
 * Repository for project and repository (Git repo) records.
 *
 * A project is the top-level container. A repository is a Git checkout
 * within that project (MVP supports one repo per project).
 *
 * Used by: CLI (init), Sync Engine, Application Services.
 */

import type { Database } from 'better-sqlite3';

import type { ProjectRecord, RepositoryRecord } from '../shared/types.js';
import { generateId, nowISO } from '../shared/utils.js';

/**
 * Creates a new project and its primary repository in a single transaction.
 *
 * Paths are stored as '.' (relative to the project root) so the
 * database remains portable across machines. The application resolves
 * them to absolute paths at runtime.
 *
 * @returns Object with both IDs.
 */
export function createProjectWithRepository(
  db: Database,
  name: string,
  _rootPath: string,
  _repoPath: string,
  remoteUrl?: string,
): { projectId: string; repositoryId: string } {
  const projectId = generateId('proj');
  const repositoryId = generateId('repo');

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, name, root_path)
      VALUES (?, ?, ?)
    `).run(projectId, name, '.');

    db.prepare(`
      INSERT INTO repositories (id, project_id, path, remote_url)
      VALUES (?, ?, ?, ?)
    `).run(repositoryId, projectId, '.', remoteUrl ?? null);
  });

  tx();

  return { projectId, repositoryId };
}

/** Finds a project by root path (legacy) or by relative path '.'. */
export function findProjectByPath(
  db: Database,
  rootPath: string,
): ProjectRecord | undefined {
  const byRelative = db.prepare('SELECT * FROM projects WHERE root_path = ?').get('.') as
    | ProjectRecord
    | undefined;
  if (byRelative) return byRelative;

  return db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
    | ProjectRecord
    | undefined;
}

/** Finds a project by name. */
export function findProjectByName(
  db: Database,
  name: string,
): ProjectRecord | undefined {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as
    | ProjectRecord
    | undefined;
}

/** Returns the first (and typically only) project in the database. */
export function findFirstProject(db: Database): ProjectRecord | undefined {
  return db.prepare('SELECT * FROM projects LIMIT 1').get() as
    | ProjectRecord
    | undefined;
}

/** Finds the repository for a project. */
export function findRepositoryByProjectId(
  db: Database,
  projectId: string,
): RepositoryRecord | undefined {
  return db.prepare('SELECT * FROM repositories WHERE project_id = ? LIMIT 1').get(
    projectId,
  ) as RepositoryRecord | undefined;
}

/** Finds a repository by its path. */
export function findRepositoryByPath(
  db: Database,
  repoPath: string,
): RepositoryRecord | undefined {
  return db.prepare('SELECT * FROM repositories WHERE path = ? LIMIT 1').get(
    repoPath,
  ) as RepositoryRecord | undefined;
}

/** Updates the project's updated_at timestamp. */
export function touchProject(db: Database, projectId: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowISO(), projectId);
}

// ──────────────────────────────────────────────────────────────────────
// Database Metadata
// ──────────────────────────────────────────────────────────────────────

/** Reads a metadata value by key. */
export function getDbMetadata(db: Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM db_metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Writes or updates a metadata key-value pair. */
export function setDbMetadata(db: Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO db_metadata (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value);
}

/** Reads all metadata as a record. */
export function getAllDbMetadata(db: Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM db_metadata').all() as Array<{
    key: string;
    value: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
