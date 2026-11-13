/**
 * MySQL Schema Analyzer.
 *
 * Two data sources:
 * 1. Migration SQL files in the repository — parsed for CREATE TABLE,
 *    ALTER TABLE, foreign keys, and indices.
 * 2. Live MySQL information_schema queries (read-only) — optional,
 *    provides actual runtime schema.
 *
 * Produces entities (table, column, index, foreign_key) and edges
 * (foreign_key_to, migrates). Results are merged into the entity graph
 * during sync.
 *
 * SECURITY: credentials are never persisted. Only SELECT on
 * information_schema is allowed. Connection is read-only.
 *
 * Used by: services/sync.ts (analyze_schema action).
 */

import type {
  ParsedEntity,
  ParsedEdge,
  ParsedEvidence,
  FileAnalysisResult,
  ProjectMapConfig,
} from '../shared/types.js';
import { EDGE_WEIGHTS } from '../shared/constants.js';
import { sha256 } from '../shared/utils.js';

/** Result from analyzing MySQL schema. */
export interface SchemaAnalysisResult {
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
  tables_found: number;
}

// ──────────────────────────────────────────────────────────────────────
// Migration SQL File Parser
// ──────────────────────────────────────────────────────────────────────

/**
 * Parses a SQL migration file and extracts table/column/index/fk entities.
 *
 * @param relativePath - File path relative to project root.
 * @param content - Raw SQL content.
 * @returns Analysis result with entities, edges, and evidence.
 */
export function parseMigrationSql(
  relativePath: string,
  content: string,
): FileAnalysisResult {
  const entities: ParsedEntity[] = [];
  const edges: ParsedEdge[] = [];
  const evidence: ParsedEvidence[] = [];
  const errors: string[] = [];

  const fileEntity: ParsedEntity = {
    entity_type: 'file',
    scope: 'file',
    qualified_name: relativePath,
    display_name: relativePath.split('/').pop() ?? relativePath,
    path: relativePath,
    line_start: 1,
    line_end: content.split('\n').length,
    language: 'sql',
  };
  entities.push(fileEntity);

  try {
    extractCreateTables(content, relativePath, entities, edges, evidence);
    extractAlterTables(content, relativePath, entities, edges, evidence);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`Migration parse error: ${msg}`);
  }

  return { path: relativePath, language: 'sql', entities, edges, evidence, errors };
}

function extractCreateTables(
  content: string,
  relativePath: string,
  entities: ParsedEntity[],
  edges: ParsedEdge[],
  evidence: ParsedEvidence[],
): void {
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)\s*(?:ENGINE|;)/gi;
  let match: RegExpExecArray | null;

  while ((match = createTableRegex.exec(content)) !== null) {
    const tableName = match[1]!;
    const body = match[2]!;
    const lineStart = content.substring(0, match.index).split('\n').length;
    const lineEnd = lineStart + body.split('\n').length;

    const tableQualified = `table:${tableName}`;
    entities.push({
      entity_type: 'table',
      scope: 'database',
      qualified_name: tableQualified,
      display_name: tableName,
      path: relativePath,
      line_start: lineStart,
      line_end: lineEnd,
      language: 'sql',
    });

    edges.push({
      source_qualified_name: relativePath,
      target_qualified_name: tableQualified,
      edge_type: 'migrates',
      weight: EDGE_WEIGHTS['migrates'] ?? 0.7,
      resolution_status: 'resolved',
    });

    evidence.push({
      source_kind: 'migration',
      path: relativePath,
      line_start: lineStart,
      line_end: lineEnd,
      excerpt: `CREATE TABLE ${tableName}`,
      content_hash: sha256(`CREATE TABLE ${tableName} ${body}`),
    });

    extractColumnsFromBody(body, tableName, relativePath, lineStart, entities);
    extractForeignKeysFromBody(body, tableName, relativePath, lineStart, entities, edges);
    extractIndicesFromBody(body, tableName, relativePath, lineStart, entities);
  }
}

function extractColumnsFromBody(
  body: string,
  tableName: string,
  relativePath: string,
  baseLineStart: number,
  entities: ParsedEntity[],
): void {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('PRIMARY') || line.startsWith('UNIQUE') ||
        line.startsWith('INDEX') || line.startsWith('KEY') ||
        line.startsWith('FOREIGN') || line.startsWith('CONSTRAINT') ||
        line.startsWith(')')) continue;

    const columnMatch = line.match(/^[`"']?(\w+)[`"']?\s+([\w()]+)/);
    if (columnMatch) {
      const colName = columnMatch[1]!;
      const colType = columnMatch[2]!;

      if (['CREATE', 'ALTER', 'DROP', 'TABLE', 'ADD', 'MODIFY'].includes(colName.toUpperCase())) continue;

      entities.push({
        entity_type: 'column',
        scope: 'database',
        qualified_name: `column:${tableName}.${colName}`,
        display_name: `${tableName}.${colName}`,
        path: relativePath,
        line_start: baseLineStart + i,
        line_end: baseLineStart + i,
        language: 'sql',
        metadata: { column_type: colType, table: tableName },
      });
    }
  }
}

function extractForeignKeysFromBody(
  body: string,
  tableName: string,
  relativePath: string,
  baseLineStart: number,
  entities: ParsedEntity[],
  edges: ParsedEdge[],
): void {
  const fkRegex = /(?:CONSTRAINT\s+[`"']?(\w+)[`"']?\s+)?FOREIGN\s+KEY\s*\([`"']?(\w+)[`"']?\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\([`"']?(\w+)[`"']?\)/gi;
  let fkMatch: RegExpExecArray | null;

  while ((fkMatch = fkRegex.exec(body)) !== null) {
    const constraintName = fkMatch[1] ?? `fk_${tableName}_${fkMatch[2]}`;
    const column = fkMatch[2]!;
    const refTable = fkMatch[3]!;
    const refColumn = fkMatch[4]!;
    const lineNum = baseLineStart + body.substring(0, fkMatch.index).split('\n').length;

    entities.push({
      entity_type: 'foreign_key',
      scope: 'database',
      qualified_name: `fk:${tableName}.${constraintName}`,
      display_name: `${tableName}.${column} → ${refTable}.${refColumn}`,
      path: relativePath,
      line_start: lineNum,
      line_end: lineNum,
      language: 'sql',
      metadata: { table: tableName, column, ref_table: refTable, ref_column: refColumn },
    });

    edges.push({
      source_qualified_name: `column:${tableName}.${column}`,
      target_qualified_name: `table:${refTable}`,
      edge_type: 'foreign_key_to',
      weight: EDGE_WEIGHTS['foreign_key_to'] ?? 0.8,
      resolution_status: 'resolved',
    });
  }

  // Shorthand: columnName_id REFERENCES (Laravel convention)
  const shorthandFkRegex = /[`"']?(\w+_id)[`"']?\s+\w+.*?REFERENCES\s+[`"']?(\w+)[`"']?\s*\([`"']?(\w+)[`"']?\)/gi;
  let shortMatch: RegExpExecArray | null;

  while ((shortMatch = shorthandFkRegex.exec(body)) !== null) {
    const column = shortMatch[1]!;
    const refTable = shortMatch[2]!;

    const alreadyExists = edges.some(
      (e) => e.source_qualified_name === `column:${tableName}.${column}` && e.edge_type === 'foreign_key_to',
    );
    if (alreadyExists) continue;

    edges.push({
      source_qualified_name: `column:${tableName}.${column}`,
      target_qualified_name: `table:${refTable}`,
      edge_type: 'foreign_key_to',
      weight: EDGE_WEIGHTS['foreign_key_to'] ?? 0.8,
      resolution_status: 'resolved',
    });
  }
}

function extractIndicesFromBody(
  body: string,
  tableName: string,
  relativePath: string,
  baseLineStart: number,
  entities: ParsedEntity[],
): void {
  const indexRegex = /(?:UNIQUE\s+)?(?:INDEX|KEY)\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/gi;
  let idxMatch: RegExpExecArray | null;

  while ((idxMatch = indexRegex.exec(body)) !== null) {
    const indexName = idxMatch[1]!;
    const columns = idxMatch[2]!;
    const lineNum = baseLineStart + body.substring(0, idxMatch.index).split('\n').length;

    entities.push({
      entity_type: 'index',
      scope: 'database',
      qualified_name: `index:${tableName}.${indexName}`,
      display_name: `${tableName}.${indexName}`,
      path: relativePath,
      line_start: lineNum,
      line_end: lineNum,
      language: 'sql',
      metadata: { table: tableName, columns: columns.trim() },
    });
  }
}

function extractAlterTables(
  content: string,
  relativePath: string,
  entities: ParsedEntity[],
  edges: ParsedEdge[],
  _evidence: ParsedEvidence[],
): void {
  const alterRegex = /ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+([\s\S]*?)(?:;)/gi;
  let match: RegExpExecArray | null;

  while ((match = alterRegex.exec(content)) !== null) {
    const tableName = match[1]!;
    const body = match[2]!;
    const lineStart = content.substring(0, match.index).split('\n').length;

    edges.push({
      source_qualified_name: relativePath,
      target_qualified_name: `table:${tableName}`,
      edge_type: 'migrates',
      weight: EDGE_WEIGHTS['migrates'] ?? 0.7,
      resolution_status: 'resolved',
    });

    // ADD COLUMN
    const addColRegex = /ADD\s+(?:COLUMN\s+)?[`"']?(\w+)[`"']?\s+(\w+)/gi;
    let colMatch: RegExpExecArray | null;
    while ((colMatch = addColRegex.exec(body)) !== null) {
      const colName = colMatch[1]!;
      const colType = colMatch[2]!;

      entities.push({
        entity_type: 'column',
        scope: 'database',
        qualified_name: `column:${tableName}.${colName}`,
        display_name: `${tableName}.${colName}`,
        path: relativePath,
        line_start: lineStart,
        line_end: lineStart,
        language: 'sql',
        metadata: { column_type: colType, table: tableName },
      });
    }

    extractForeignKeysFromBody(body, tableName, relativePath, lineStart, entities, edges);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Live MySQL Schema Analysis
// ──────────────────────────────────────────────────────────────────────

interface MySqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// SECURITY: SQL statements that are NEVER allowed
const BLOCKED_SQL_PATTERNS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|EXECUTE|TRUNCATE)\b/i;

/**
 * Validates that a SQL statement is read-only.
 * @throws Error if the statement contains write operations.
 */
function validateReadOnly(sql: string): void {
  if (BLOCKED_SQL_PATTERNS.test(sql)) {
    throw new Error('Only SELECT queries on information_schema are allowed');
  }
}

/**
 * Analyzes a MySQL schema via information_schema (live connection).
 *
 * SECURITY: Read-only connection, only SELECT on information_schema,
 * credentials held in memory only, never persisted.
 *
 * @param connection - MySQL connection parameters.
 * @param config - Project configuration (for security settings).
 * @returns Schema analysis result.
 */
export async function analyzeSchema(
  connection: MySqlConnection,
  config: ProjectMapConfig,
): Promise<SchemaAnalysisResult> {
  const entities: ParsedEntity[] = [];
  const edges: ParsedEdge[] = [];
  const evidence: ParsedEvidence[] = [];
  const errors: string[] = [];

  // SECURITY: validate host
  if (!config.security.mysql.allow_connection) {
    return { entities, edges, evidence, errors: ['MySQL connection disabled in config'], tables_found: 0 };
  }

  const allowedHosts = config.security.mysql.allowed_hosts;
  if (!allowedHosts.includes(connection.host)) {
    return { entities, edges, evidence, errors: [`Host "${connection.host}" not in allowed list`], tables_found: 0 };
  }

  if (config.security.mysql.blocked_schemas.includes(connection.database)) {
    return { entities, edges, evidence, errors: [`Schema "${connection.database}" is blocked`], tables_found: 0 };
  }

  try {
    const mysql2 = await import('mysql2/promise');
    const conn = await mysql2.createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      connectTimeout: 5000,
      multipleStatements: false,
    });

    // SECURITY: set read-only mode
    await conn.execute('SET SESSION TRANSACTION READ ONLY');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 is optional; typed interface would force the dependency
    const execConn = conn as any;
    const tablesFound = await queryTables(execConn, connection.database, entities, evidence, errors);
    await queryForeignKeys(execConn, connection.database, entities, edges, errors);
    await queryIndices(execConn, connection.database, entities, errors);

    await conn.end();

    return { entities, edges, evidence, errors, tables_found: tablesFound };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Cannot find module')) {
      errors.push('mysql2 package not installed. Run: npm install mysql2');
    } else {
      errors.push(`MySQL connection failed: ${msg}`);
    }
    return { entities, edges, evidence, errors, tables_found: 0 };
  }
}

async function queryTables(
  conn: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  database: string,
  entities: ParsedEntity[],
  evidence: ParsedEvidence[],
  errors: string[],
): Promise<number> {
  const sql = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`;
  validateReadOnly(sql);

  try {
    const [rows] = await conn.execute(sql, [database]);
    const columns = rows as Array<{
      TABLE_NAME: string;
      COLUMN_NAME: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_KEY: string;
      COLUMN_DEFAULT: string | null;
      EXTRA: string;
    }>;

    const tableNames = new Set<string>();
    for (const col of columns) {
      tableNames.add(col.TABLE_NAME);

      entities.push({
        entity_type: 'column',
        scope: 'database',
        qualified_name: `column:${col.TABLE_NAME}.${col.COLUMN_NAME}`,
        display_name: `${col.TABLE_NAME}.${col.COLUMN_NAME}`,
        path: null as unknown as string,
        line_start: 0,
        line_end: 0,
        language: 'sql',
        metadata: {
          table: col.TABLE_NAME,
          column_type: col.COLUMN_TYPE,
          nullable: col.IS_NULLABLE === 'YES',
          key: col.COLUMN_KEY,
          default_value: col.COLUMN_DEFAULT,
          extra: col.EXTRA,
        },
      });
    }

    for (const tableName of tableNames) {
      entities.push({
        entity_type: 'table',
        scope: 'database',
        qualified_name: `table:${tableName}`,
        display_name: tableName,
        path: null as unknown as string,
        line_start: 0,
        line_end: 0,
        language: 'sql',
      });

      evidence.push({
        source_kind: 'schema',
        path: `information_schema:${database}`,
        line_start: 0,
        line_end: 0,
        excerpt: `Table ${tableName} in ${database}`,
        content_hash: sha256(`${database}.${tableName}`),
      });
    }

    return tableNames.size;
  } catch (error) {
    errors.push(`Failed to query tables: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

async function queryForeignKeys(
  conn: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  database: string,
  entities: ParsedEntity[],
  edges: ParsedEdge[],
  errors: string[],
): Promise<void> {
  const sql = `SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE kcu WHERE kcu.TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`;
  validateReadOnly(sql);

  try {
    const [rows] = await conn.execute(sql, [database]);
    const fks = rows as Array<{
      CONSTRAINT_NAME: string;
      TABLE_NAME: string;
      COLUMN_NAME: string;
      REFERENCED_TABLE_NAME: string;
      REFERENCED_COLUMN_NAME: string;
    }>;

    for (const fk of fks) {
      entities.push({
        entity_type: 'foreign_key',
        scope: 'database',
        qualified_name: `fk:${fk.TABLE_NAME}.${fk.CONSTRAINT_NAME}`,
        display_name: `${fk.TABLE_NAME}.${fk.COLUMN_NAME} → ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`,
        path: null as unknown as string,
        line_start: 0,
        line_end: 0,
        language: 'sql',
        metadata: {
          table: fk.TABLE_NAME,
          column: fk.COLUMN_NAME,
          ref_table: fk.REFERENCED_TABLE_NAME,
          ref_column: fk.REFERENCED_COLUMN_NAME,
        },
      });

      edges.push({
        source_qualified_name: `column:${fk.TABLE_NAME}.${fk.COLUMN_NAME}`,
        target_qualified_name: `table:${fk.REFERENCED_TABLE_NAME}`,
        edge_type: 'foreign_key_to',
        weight: EDGE_WEIGHTS['foreign_key_to'] ?? 0.8,
        resolution_status: 'resolved',
      });
    }
  } catch (error) {
    errors.push(`Failed to query foreign keys: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function queryIndices(
  conn: { execute: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]> },
  database: string,
  entities: ParsedEntity[],
  errors: string[],
): Promise<void> {
  const sql = `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?`;
  validateReadOnly(sql);

  try {
    const [rows] = await conn.execute(sql, [database]);
    const indices = rows as Array<{
      TABLE_NAME: string;
      INDEX_NAME: string;
      COLUMN_NAME: string;
      NON_UNIQUE: number;
      INDEX_TYPE: string;
    }>;

    const seenIndices = new Set<string>();
    for (const idx of indices) {
      const qualifiedName = `index:${idx.TABLE_NAME}.${idx.INDEX_NAME}`;
      if (seenIndices.has(qualifiedName)) continue;
      seenIndices.add(qualifiedName);

      entities.push({
        entity_type: 'index',
        scope: 'database',
        qualified_name: qualifiedName,
        display_name: `${idx.TABLE_NAME}.${idx.INDEX_NAME}`,
        path: null as unknown as string,
        line_start: 0,
        line_end: 0,
        language: 'sql',
        metadata: {
          table: idx.TABLE_NAME,
          unique: idx.NON_UNIQUE === 0,
          index_type: idx.INDEX_TYPE,
        },
      });
    }
  } catch (error) {
    errors.push(`Failed to query indices: ${error instanceof Error ? error.message : String(error)}`);
  }
}
