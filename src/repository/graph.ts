/**
 * Repository for the relationship graph (edges between entities).
 *
 * Edges represent how entities relate to each other: imports, extends,
 * calls, dispatches, etc. Each edge carries a weight (coupling strength),
 * resolution status, and a reference to the evidence that detected it.
 *
 * Used by: Application Services (graph, impact, context).
 */

import type { Database } from 'better-sqlite3';

import type { EdgeRecord, EdgeType, ResolutionStatus } from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import { EDGE_WEIGHTS } from '../shared/constants.js';

export interface CreateEdgeInput {
  repository_id: string;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  weight?: number;
  resolution_status?: ResolutionStatus;
  evidence_id?: string;
  snapshot_id: string;
  metadata?: Record<string, unknown>;
}

/**
 * Creates or updates an edge between two entities.
 * On conflict (same source, target, type), updates the existing edge.
 *
 * @returns The edge ID.
 */
export function upsertEdge(db: Database, input: CreateEdgeInput): string {
  const id = generateId('edge');
  const weight = input.weight ?? EDGE_WEIGHTS[input.edge_type] ?? 0.5;
  const metadataJson = JSON.stringify(input.metadata ?? {});

  db.prepare(`
    INSERT INTO edges (
      id, repository_id, source_id, target_id, edge_type,
      weight, resolution_status, evidence_id, snapshot_id, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET
      weight = excluded.weight,
      resolution_status = excluded.resolution_status,
      evidence_id = excluded.evidence_id,
      snapshot_id = excluded.snapshot_id,
      metadata_json = excluded.metadata_json
  `).run(
    id,
    input.repository_id,
    input.source_id,
    input.target_id,
    input.edge_type,
    weight,
    input.resolution_status ?? 'resolved',
    input.evidence_id ?? null,
    input.snapshot_id,
    metadataJson,
  );

  // Return the actual ID after upsert
  const row = db
    .prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?')
    .get(input.source_id, input.target_id, input.edge_type) as { id: string } | undefined;

  return row?.id ?? id;
}

/** Finds all outgoing edges from an entity. */
export function findOutgoingEdges(
  db: Database,
  entityId: string,
  edgeTypes?: EdgeType[],
  includeUnresolved: boolean = false,
): EdgeRecord[] {
  let sql = 'SELECT * FROM edges WHERE source_id = ?';
  const params: unknown[] = [entityId];

  if (edgeTypes && edgeTypes.length > 0) {
    const placeholders = edgeTypes.map(() => '?').join(',');
    sql += ` AND edge_type IN (${placeholders})`;
    params.push(...edgeTypes);
  }

  if (!includeUnresolved) {
    sql += ` AND resolution_status != 'unresolved'`;
  }

  sql += ' ORDER BY weight DESC';
  return db.prepare(sql).all(...params) as EdgeRecord[];
}

/** Finds all incoming edges to an entity. */
export function findIncomingEdges(
  db: Database,
  entityId: string,
  edgeTypes?: EdgeType[],
  includeUnresolved: boolean = false,
): EdgeRecord[] {
  let sql = 'SELECT * FROM edges WHERE target_id = ?';
  const params: unknown[] = [entityId];

  if (edgeTypes && edgeTypes.length > 0) {
    const placeholders = edgeTypes.map(() => '?').join(',');
    sql += ` AND edge_type IN (${placeholders})`;
    params.push(...edgeTypes);
  }

  if (!includeUnresolved) {
    sql += ` AND resolution_status != 'unresolved'`;
  }

  sql += ' ORDER BY weight DESC';
  return db.prepare(sql).all(...params) as EdgeRecord[];
}

/**
 * Traverses the graph from a starting entity up to a maximum depth.
 * Returns all reachable nodes and the edges connecting them.
 *
 * Uses BFS (breadth-first search) for predictable depth behavior.
 */
export function traverseGraph(
  db: Database,
  startEntityId: string,
  direction: 'incoming' | 'outgoing' | 'both',
  maxDepth: number = 2,
  edgeTypes?: EdgeType[],
  includeUnresolved: boolean = false,
): { nodeIds: Set<string>; edges: EdgeRecord[] } {
  const visited = new Set<string>([startEntityId]);
  const allEdges: EdgeRecord[] = [];
  let frontier = [startEntityId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const edgesForNode: EdgeRecord[] = [];

      if (direction === 'outgoing' || direction === 'both') {
        edgesForNode.push(...findOutgoingEdges(db, nodeId, edgeTypes, includeUnresolved));
      }
      if (direction === 'incoming' || direction === 'both') {
        edgesForNode.push(...findIncomingEdges(db, nodeId, edgeTypes, includeUnresolved));
      }

      for (const edge of edgesForNode) {
        allEdges.push(edge);

        const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
        }
      }
    }

    frontier = nextFrontier;
  }

  return { nodeIds: visited, edges: allEdges };
}

/** Deletes all edges originating from entities in a specific file. */
export function deleteEdgesBySourcePath(
  db: Database,
  repositoryId: string,
  filePath: string,
): number {
  const result = db.prepare(`
    DELETE FROM edges
    WHERE repository_id = ?
      AND source_id IN (
        SELECT id FROM entities WHERE repository_id = ? AND path = ?
      )
  `).run(repositoryId, repositoryId, filePath);
  return result.changes;
}

/** Counts all edges in a repository. */
export function countEdges(db: Database, repositoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM edges WHERE repository_id = ?')
    .get(repositoryId) as { count: number };
  return row.count;
}

/** Counts unresolved edges in a repository. */
export function countUnresolvedEdges(db: Database, repositoryId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM edges WHERE repository_id = ? AND resolution_status = 'unresolved'`,
    )
    .get(repositoryId) as { count: number };
  return row.count;
}
