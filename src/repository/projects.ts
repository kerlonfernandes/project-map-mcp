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
 * @returns Object with both IDs.
 */
export function createProjectWithRepository(
  db: Database,
  name: string,
  rootPath: string,
  repoPath: string,
  remoteUrl?: string,
): { projectId: string; repositoryId: string } {
  const projectId = generateId('proj');
  const repositoryId = generateId('repo');

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, name, root_path)
      VALUES (?, ?, ?)
    `).run(projectId, name, rootPath);

    db.prepare(`
      INSERT INTO repositories (id, project_id, path, remote_url)
      VALUES (?, ?, ?, ?)
    `).run(repositoryId, projectId, repoPath, remoteUrl ?? null);
  });

  tx();

  return { projectId, repositoryId };
}

/** Finds a project by root path. */
export function findProjectByPath(
  db: Database,
  rootPath: string,
): ProjectRecord | undefined {
  return db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as
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
