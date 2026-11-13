/**
 * Versionable knowledge file service.
 *
 * Serializes knowledge records to git-friendly Markdown files with YAML
 * frontmatter, and deserializes them back. Each knowledge record becomes
 * one file under `.project-map/knowledge/<type>/<slug>.md`.
 *
 * The SQLite database remains the runtime index; these files are the
 * durable, version-controlled source of truth for knowledge content.
 *
 * Used by: services/record.ts (write-through), services/sync.ts (bulk export/import).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { KNOWLEDGE_DIR_NAME } from '../shared/constants.js';
import type {
  KnowledgeRecord,
  EvidenceRecord,
  KnowledgeType,
  KnowledgeOrigin,
  ValidationStatus,
  ValidityState,
  SourceKind,
} from '../shared/types.js';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface KnowledgeFileFrontmatter {
  id: string;
  type: KnowledgeType;
  subject: string;
  origin: KnowledgeOrigin;
  validation_status: ValidationStatus;
  confidence: number;
  validity: ValidityState;
  created_at: string;
  validated_at: string | null;
  supersedes: string | null;
  evidence: Array<{
    path: string;
    lines: [number | null, number | null];
    source_kind: SourceKind;
    excerpt: string | null;
  }>;
  entities: string[];
}

export interface KnowledgeFileData {
  frontmatter: KnowledgeFileFrontmatter;
  content: string;
}

// ──────────────────────────────────────────────────────────────────────
// Slugify
// ──────────────────────────────────────────────────────────────────────

/** Converts a subject string to a filesystem-safe kebab-case slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ──────────────────────────────────────────────────────────────────────
// Serialize (DB → File)
// ──────────────────────────────────────────────────────────────────────

/**
 * Serializes a knowledge record and its evidence into Markdown+YAML frontmatter.
 */
export function serializeKnowledgeFile(
  record: KnowledgeRecord,
  evidence: EvidenceRecord[],
  entityNames: string[],
): string {
  const fm: KnowledgeFileFrontmatter = {
    id: record.id,
    type: record.knowledge_type,
    subject: record.subject,
    origin: record.origin,
    validation_status: record.validation_status,
    confidence: record.confidence,
    validity: record.validity,
    created_at: record.created_at,
    validated_at: record.validated_at,
    supersedes: record.supersedes_id,
    evidence: evidence.map((ev) => ({
      path: ev.path ?? '',
      lines: [ev.line_start, ev.line_end],
      source_kind: ev.source_kind,
      excerpt: ev.excerpt,
    })),
    entities: entityNames,
  };

  const yamlLines = serializeYaml(fm);
  return `---\n${yamlLines}---\n\n${record.content}\n`;
}

/**
 * Minimal YAML serializer for the frontmatter structure.
 * Avoids external dependencies — handles only the shapes we produce.
 */
function serializeYaml(fm: KnowledgeFileFrontmatter): string {
  const lines: string[] = [];

  lines.push(`id: "${escapeYamlString(fm.id)}"`);
  lines.push(`type: ${fm.type}`);
  lines.push(`subject: "${escapeYamlString(fm.subject)}"`);
  lines.push(`origin: ${fm.origin}`);
  lines.push(`validation_status: ${fm.validation_status}`);
  lines.push(`confidence: ${fm.confidence}`);
  lines.push(`validity: ${fm.validity}`);
  lines.push(`created_at: "${fm.created_at}"`);
  lines.push(`validated_at: ${fm.validated_at ? `"${fm.validated_at}"` : 'null'}`);
  lines.push(`supersedes: ${fm.supersedes ? `"${escapeYamlString(fm.supersedes)}"` : 'null'}`);

  if (fm.evidence.length === 0) {
    lines.push('evidence: []');
  } else {
    lines.push('evidence:');
    for (const ev of fm.evidence) {
      lines.push(`  - path: "${escapeYamlString(ev.path)}"`);
      lines.push(`    lines: [${ev.lines[0] ?? 'null'}, ${ev.lines[1] ?? 'null'}]`);
      lines.push(`    source_kind: ${ev.source_kind}`);
      lines.push(`    excerpt: ${ev.excerpt ? `"${escapeYamlString(ev.excerpt)}"` : 'null'}`);
    }
  }

  if (fm.entities.length === 0) {
    lines.push('entities: []');
  } else {
    lines.push('entities:');
    for (const name of fm.entities) {
      lines.push(`  - "${escapeYamlString(name)}"`);
    }
  }

  return lines.join('\n') + '\n';
}

function escapeYamlString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// ──────────────────────────────────────────────────────────────────────
// Deserialize (File → Data)
// ──────────────────────────────────────────────────────────────────────

/**
 * Parses a Markdown file with YAML frontmatter into structured data.
 * Returns null if the file format is invalid.
 */
export function deserializeKnowledgeFile(fileContent: string): KnowledgeFileData | null {
  const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch?.[1]) return null;

  const yamlText = fmMatch[1];
  const content = (fmMatch[2] ?? '').trim();

  const fm = parseYaml(yamlText);
  if (!fm || !fm['id'] || !fm['type'] || !fm['subject']) return null;

  return { frontmatter: fm as unknown as KnowledgeFileFrontmatter, content };
}

/**
 * Minimal YAML parser for our specific frontmatter shape.
 * Handles scalars, arrays of scalars, and arrays of objects (evidence).
 */
function parseYaml(yaml: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i]!;
      const topMatch = line.match(/^(\w+):\s*(.*)$/);

      if (!topMatch?.[1]) { i++; continue; }

      const key = topMatch[1];
      const value = (topMatch[2] ?? '').trim();

      if (value === '') {
        // Check if next line is array start
        if (i + 1 < lines.length && (lines[i + 1] ?? '').match(/^\s+-/)) {
          const items = parseArrayBlock(lines, i + 1);
          result[key] = items.values;
          i = items.nextIndex;
          continue;
        }
        i++;
        continue;
      }

      if (value === '[]') {
        result[key] = [];
        i++;
        continue;
      }

      if (value.startsWith('[') && value.endsWith(']')) {
        result[key] = parseInlineArray(value);
        i++;
        continue;
      }

      // Array block check
      if (i + 1 < lines.length && (lines[i + 1] ?? '').match(/^\s+-/)) {
        const items = parseArrayBlock(lines, i + 1);
        result[key] = items.values;
        i = items.nextIndex;
        continue;
      }

      result[key] = parseScalar(value);
      i++;
    }

    return result;
  } catch {
    return null;
  }
}

function parseArrayBlock(lines: string[], startIndex: number): { values: unknown[]; nextIndex: number } {
  const items: unknown[] = [];
  let i = startIndex;

  while (i < lines.length && (lines[i] ?? '').match(/^\s+-/)) {
    const itemLine = lines[i] ?? '';
    const objMatch = itemLine.match(/^\s+-\s+(\w+):\s*(.*)$/);

    if (objMatch?.[1]) {
      const obj: Record<string, unknown> = {};
      obj[objMatch[1]] = parseScalar(objMatch[2] ?? '');
      i++;

      while (i < lines.length) {
        const fieldMatch = (lines[i] ?? '').match(/^\s{4}(\w+):\s*(.*)$/);
        if (!fieldMatch?.[1]) break;
        obj[fieldMatch[1]] = parseScalar(fieldMatch[2] ?? '');
        i++;
      }

      items.push(obj);
    } else {
      const scalarMatch = itemLine.match(/^\s+-\s+(.+)$/);
      if (scalarMatch?.[1]) {
        items.push(parseScalar(scalarMatch[1]));
      }
      i++;
    }
  }

  return { values: items, nextIndex: i };
}

function parseScalar(value: string): unknown {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  if (value.startsWith('[') && value.endsWith(']')) {
    return parseInlineArray(value);
  }

  return value;
}

function parseInlineArray(value: string): unknown[] {
  const inner = value.slice(1, -1);
  if (inner.trim() === '') return [];
  return inner.split(',').map((s) => parseScalar(s.trim()));
}

// ──────────────────────────────────────────────────────────────────────
// File I/O
// ──────────────────────────────────────────────────────────────────────

/** Returns the directory path for a knowledge type under the project root. */
export function getKnowledgeTypePath(projectRoot: string, knowledgeType: string): string {
  return path.join(projectRoot, KNOWLEDGE_DIR_NAME, knowledgeType);
}

/** Returns the full file path for a knowledge record. */
export function getKnowledgeFilePath(
  projectRoot: string,
  knowledgeType: string,
  subject: string,
  id: string,
): string {
  const slug = slugify(subject) || id;
  return path.join(getKnowledgeTypePath(projectRoot, knowledgeType), `${slug}.md`);
}

/**
 * Writes a knowledge record to its Markdown file.
 *
 * Creates the type subdirectory if it doesn't exist.
 * Validates the output path stays within the project root.
 */
export function writeKnowledgeFile(
  projectRoot: string,
  record: KnowledgeRecord,
  evidence: EvidenceRecord[],
  entityNames: string[],
): string {
  const filePath = getKnowledgeFilePath(
    projectRoot,
    record.knowledge_type,
    record.subject,
    record.id,
  );

  // SECURITY: ensure path stays within project root
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(projectRoot);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Knowledge file path escapes project root');
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = serializeKnowledgeFile(record, evidence, entityNames);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Removes the Markdown file for a knowledge record (used when archiving).
 */
export function removeKnowledgeFile(
  projectRoot: string,
  knowledgeType: string,
  subject: string,
  id: string,
): void {
  const filePath = getKnowledgeFilePath(projectRoot, knowledgeType, subject, id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Reads all knowledge files from the knowledge directory.
 * Returns parsed data for each valid file found.
 */
export function readAllKnowledgeFiles(projectRoot: string): Array<{
  filePath: string;
  data: KnowledgeFileData;
}> {
  const knowledgeDir = path.join(projectRoot, KNOWLEDGE_DIR_NAME);
  if (!fs.existsSync(knowledgeDir)) return [];

  const results: Array<{ filePath: string; data: KnowledgeFileData }> = [];

  const typeDirs = fs.readdirSync(knowledgeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const typeDir of typeDirs) {
    const typePath = path.join(knowledgeDir, typeDir.name);
    const files = fs.readdirSync(typePath)
      .filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(typePath, file);

      // SECURITY: validate path stays within project
      const resolvedPath = path.resolve(filePath);
      const resolvedRoot = path.resolve(projectRoot);
      if (!resolvedPath.startsWith(resolvedRoot + path.sep)) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = deserializeKnowledgeFile(content);
        if (data) {
          results.push({ filePath, data });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────
// DB Helpers (query evidence and entities for a knowledge record)
// ──────────────────────────────────────────────────────────────────────

/** Fetches all evidence records linked to a knowledge record. */
export function getEvidenceForKnowledge(db: Database, knowledgeId: string): EvidenceRecord[] {
  return db.prepare(`
    SELECT e.*
    FROM evidence e
    JOIN knowledge_evidence ke ON ke.evidence_id = e.id
    WHERE ke.knowledge_id = ?
  `).all(knowledgeId) as EvidenceRecord[];
}

/** Fetches qualified names of entities linked to a knowledge record. */
export function getEntityNamesForKnowledge(db: Database, knowledgeId: string): string[] {
  const rows = db.prepare(`
    SELECT ent.qualified_name
    FROM entities ent
    JOIN knowledge_entities ke ON ke.entity_id = ent.id
    WHERE ke.knowledge_id = ?
  `).all(knowledgeId) as Array<{ qualified_name: string }>;

  return rows.map((r) => r.qualified_name);
}

// ──────────────────────────────────────────────────────────────────────
// Bulk Operations
// ──────────────────────────────────────────────────────────────────────

export interface KnowledgeExportResult {
  files_written: number;
  files_skipped: number;
  directory: string;
}

/**
 * Exports all current knowledge records from DB to Markdown files.
 * Existing files are overwritten only if the record content changed.
 */
export function exportAllKnowledge(
  db: Database,
  repositoryId: string,
  projectRoot: string,
): KnowledgeExportResult {
  const records = db.prepare(`
    SELECT * FROM knowledge
    WHERE repository_id = ? AND validity != 'archived'
    ORDER BY knowledge_type, subject
  `).all(repositoryId) as KnowledgeRecord[];

  let filesWritten = 0;
  let filesSkipped = 0;

  for (const record of records) {
    const evidence = getEvidenceForKnowledge(db, record.id);
    const entityNames = getEntityNamesForKnowledge(db, record.id);

    const filePath = getKnowledgeFilePath(
      projectRoot,
      record.knowledge_type,
      record.subject,
      record.id,
    );

    const newContent = serializeKnowledgeFile(record, evidence, entityNames);

    // Only write if content changed
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing === newContent) {
        filesSkipped++;
        continue;
      }
    }

    writeKnowledgeFile(projectRoot, record, evidence, entityNames);
    filesWritten++;
  }

  // Remove files for archived records
  const archivedRecords = db.prepare(`
    SELECT id, knowledge_type, subject FROM knowledge
    WHERE repository_id = ? AND validity = 'archived'
  `).all(repositoryId) as Array<{ id: string; knowledge_type: string; subject: string }>;

  for (const archived of archivedRecords) {
    removeKnowledgeFile(projectRoot, archived.knowledge_type, archived.subject, archived.id);
  }

  return {
    files_written: filesWritten,
    files_skipped: filesSkipped,
    directory: path.join(projectRoot, KNOWLEDGE_DIR_NAME),
  };
}

export interface KnowledgeImportResult {
  records_created: number;
  records_updated: number;
  records_unchanged: number;
  errors: string[];
}

/**
 * Imports knowledge records from Markdown files into the database.
 * Files with an existing ID update the record; new IDs create records.
 */
export function importAllKnowledge(
  db: Database,
  repositoryId: string,
  projectRoot: string,
): KnowledgeImportResult {
  const files = readAllKnowledgeFiles(projectRoot);
  let recordsCreated = 0;
  let recordsUpdated = 0;
  let recordsUnchanged = 0;
  const errors: string[] = [];

  for (const { filePath, data } of files) {
    try {
      const fm = data.frontmatter;
      const existing = db.prepare('SELECT * FROM knowledge WHERE id = ?')
        .get(fm.id) as KnowledgeRecord | undefined;

      if (existing) {
        // Check if anything changed
        if (
          existing.content === data.content &&
          existing.subject === fm.subject &&
          existing.validation_status === fm.validation_status &&
          existing.confidence === fm.confidence &&
          existing.validity === fm.validity
        ) {
          recordsUnchanged++;
          continue;
        }

        db.prepare(`
          UPDATE knowledge
          SET subject = ?, knowledge_type = ?, content = ?, origin = ?,
              validation_status = ?, confidence = ?, validity = ?,
              validated_at = ?, supersedes_id = ?
          WHERE id = ?
        `).run(
          fm.subject,
          fm.type,
          data.content,
          fm.origin,
          fm.validation_status,
          fm.confidence,
          fm.validity,
          fm.validated_at,
          fm.supersedes,
          fm.id,
        );

        recordsUpdated++;
      } else {
        db.prepare(`
          INSERT INTO knowledge (
            id, repository_id, subject, knowledge_type, content, origin,
            validation_status, confidence, validity, snapshot_id,
            supersedes_id, created_at, validated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          fm.id,
          repositoryId,
          fm.subject,
          fm.type,
          data.content,
          fm.origin,
          fm.validation_status,
          fm.confidence,
          fm.validity,
          fm.supersedes,
          fm.created_at,
          fm.validated_at,
        );

        recordsCreated++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${path.basename(filePath)}: ${msg}`);
    }
  }

  return { records_created: recordsCreated, records_updated: recordsUpdated, records_unchanged: recordsUnchanged, errors };
}
