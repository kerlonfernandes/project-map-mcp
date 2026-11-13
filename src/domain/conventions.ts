/**
 * Convention Detector — identifies recurring patterns in the codebase.
 *
 * Analyzes entities and their metadata to detect naming conventions,
 * structural patterns, and configuration standards. Conventions are
 * registered with confidence proportional to occurrence count.
 *
 * Categories: naming, structure, pattern, config, testing, documentation.
 * Threshold: >= 3 occurrences OR 60% of files of the same type.
 *
 * Used by: services/sync.ts (after full analysis completes).
 */

import type { Database } from 'better-sqlite3';

import type { ConventionCategory, EntityRecord } from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import { MIN_CONVENTION_OCCURRENCES, MIN_CONVENTION_RATIO } from '../shared/constants.js';

interface ConventionCandidate {
  category: ConventionCategory;
  description: string;
  regex_pattern: string | null;
  occurrences: number;
  total_files: number;
}

/**
 * Detects conventions from the indexed entities in a repository.
 * Inserts or updates convention records in the database.
 *
 * @returns Number of conventions detected.
 */
export function detectConventions(
  db: Database,
  repositoryId: string,
  snapshotId: string,
): number {
  const entities = db.prepare(
    'SELECT * FROM entities WHERE repository_id = ?',
  ).all(repositoryId) as EntityRecord[];

  if (entities.length === 0) return 0;

  const candidates: ConventionCandidate[] = [];

  detectNamingConventions(entities, candidates);
  detectStructureConventions(entities, candidates);
  detectPatternConventions(entities, candidates);
  detectTestingConventions(entities, candidates);

  const qualifying = candidates.filter(
    (c) => c.occurrences >= MIN_CONVENTION_OCCURRENCES || ratioMet(c),
  );

  const upsertConvention = db.prepare(`
    INSERT INTO conventions (id, repository_id, category, description, regex_pattern, confidence, occurrences, snapshot_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, category, description) DO UPDATE SET
      confidence = excluded.confidence,
      occurrences = excluded.occurrences,
      snapshot_id = excluded.snapshot_id
  `);

  const insertTx = db.transaction(() => {
    for (const c of qualifying) {
      const confidence = computeConfidence(c);
      upsertConvention.run(
        generateId('conv'),
        repositoryId,
        c.category,
        c.description,
        c.regex_pattern,
        confidence,
        c.occurrences,
        snapshotId,
      );
    }
  });

  insertTx();
  return qualifying.length;
}

function ratioMet(c: ConventionCandidate): boolean {
  return c.occurrences >= 2 && c.total_files > 0 && c.occurrences / c.total_files >= MIN_CONVENTION_RATIO;
}

function computeConfidence(c: ConventionCandidate): number {
  const baseConfidence = c.total_files > 0
    ? c.occurrences / c.total_files
    : Math.min(c.occurrences / 10, 1);
  return Math.min(Math.max(baseConfidence, 0.1), 1.0);
}

// ──────────────────────────────────────────────────────────────────────
// Naming conventions
// ──────────────────────────────────────────────────────────────────────

function detectNamingConventions(entities: EntityRecord[], candidates: ConventionCandidate[]): void {
  const classes = entities.filter((e) => e.entity_type === 'class');

  const suffixCounts: Record<string, number> = {};
  const suffixPatterns: Record<string, string> = {
    Controller: 'Controller$',
    Service: 'Service$',
    Repository: 'Repository$',
    Factory: 'Factory$',
    Middleware: 'Middleware$',
    Provider: 'Provider$',
    Command: 'Command$',
    Job: 'Job$',
    Event: 'Event$',
    Listener: 'Listener$',
    Observer: 'Observer$',
    Policy: 'Policy$',
    Request: 'Request$',
    Resource: 'Resource$',
    Exception: 'Exception$',
    Test: 'Test$',
    Spec: 'Spec$',
  };

  for (const cls of classes) {
    for (const [suffix] of Object.entries(suffixPatterns)) {
      if (cls.display_name.endsWith(suffix)) {
        suffixCounts[suffix] = (suffixCounts[suffix] ?? 0) + 1;
      }
    }
  }

  for (const [suffix, count] of Object.entries(suffixCounts)) {
    candidates.push({
      category: 'naming',
      description: `Classes of type ${suffix.toLowerCase()} end with "${suffix}"`,
      regex_pattern: suffixPatterns[suffix] ?? null,
      occurrences: count,
      total_files: classes.length,
    });
  }

  const functions = entities.filter((e) => e.entity_type === 'function');
  const camelCase = functions.filter((e) => /^[a-z][a-zA-Z0-9]*$/.test(e.display_name));
  const snakeCase = functions.filter((e) => /^[a-z][a-z0-9_]*$/.test(e.display_name));

  if (camelCase.length > snakeCase.length && camelCase.length >= MIN_CONVENTION_OCCURRENCES) {
    candidates.push({
      category: 'naming',
      description: 'Functions use camelCase naming',
      regex_pattern: '^[a-z][a-zA-Z0-9]*$',
      occurrences: camelCase.length,
      total_files: functions.length,
    });
  } else if (snakeCase.length > camelCase.length && snakeCase.length >= MIN_CONVENTION_OCCURRENCES) {
    candidates.push({
      category: 'naming',
      description: 'Functions use snake_case naming',
      regex_pattern: '^[a-z][a-z0-9_]*$',
      occurrences: snakeCase.length,
      total_files: functions.length,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Structure conventions
// ──────────────────────────────────────────────────────────────────────

function detectStructureConventions(entities: EntityRecord[], candidates: ConventionCandidate[]): void {
  const files = entities.filter((e) => e.entity_type === 'file');
  const dirCounts: Record<string, number> = {};

  for (const file of files) {
    if (!file.path) continue;
    const dir = file.path.split('/').slice(0, -1).join('/');
    if (dir) {
      dirCounts[dir] = (dirCounts[dir] ?? 0) + 1;
    }
  }

  const typeByDir: Record<string, Record<string, number>> = {};
  const classEntities = entities.filter((e) => e.entity_type === 'class');

  for (const cls of classEntities) {
    if (!cls.path) continue;
    const dir = cls.path.split('/').slice(0, -1).join('/');
    const suffix = extractSuffix(cls.display_name);
    if (dir && suffix) {
      typeByDir[dir] = typeByDir[dir] ?? {};
      typeByDir[dir]![suffix] = (typeByDir[dir]![suffix] ?? 0) + 1;
    }
  }

  for (const [dir, types] of Object.entries(typeByDir)) {
    for (const [type, count] of Object.entries(types)) {
      if (count >= MIN_CONVENTION_OCCURRENCES) {
        candidates.push({
          category: 'structure',
          description: `${type} classes are located in ${dir}/`,
          regex_pattern: null,
          occurrences: count,
          total_files: classEntities.filter((e) => e.display_name.endsWith(type)).length,
        });
      }
    }
  }
}

function extractSuffix(name: string): string | null {
  const suffixes = [
    'Controller', 'Service', 'Repository', 'Model', 'Factory',
    'Middleware', 'Provider', 'Command', 'Job', 'Event', 'Listener',
    'Test', 'Spec',
  ];
  for (const s of suffixes) {
    if (name.endsWith(s) && name !== s) return s;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Pattern conventions
// ──────────────────────────────────────────────────────────────────────

function detectPatternConventions(entities: EntityRecord[], candidates: ConventionCandidate[]): void {
  const classes = entities.filter((e) => e.entity_type === 'class');

  const repoCount = classes.filter((e) => e.display_name.endsWith('Repository')).length;
  const serviceCount = classes.filter((e) => e.display_name.endsWith('Service')).length;

  if (repoCount >= MIN_CONVENTION_OCCURRENCES) {
    candidates.push({
      category: 'pattern',
      description: 'Repository pattern used for data access',
      regex_pattern: 'Repository$',
      occurrences: repoCount,
      total_files: classes.length,
    });
  }

  if (serviceCount >= MIN_CONVENTION_OCCURRENCES) {
    candidates.push({
      category: 'pattern',
      description: 'Service layer pattern used for business logic',
      regex_pattern: 'Service$',
      occurrences: serviceCount,
      total_files: classes.length,
    });
  }

  const observerCount = classes.filter((e) => e.display_name.endsWith('Observer')).length;
  if (observerCount >= MIN_CONVENTION_OCCURRENCES) {
    candidates.push({
      category: 'pattern',
      description: 'Observer pattern used for event handling',
      regex_pattern: 'Observer$',
      occurrences: observerCount,
      total_files: classes.length,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Testing conventions
// ──────────────────────────────────────────────────────────────────────

function detectTestingConventions(entities: EntityRecord[], candidates: ConventionCandidate[]): void {
  const files = entities.filter((e) => e.entity_type === 'file');

  const testFiles = files.filter((e) =>
    e.path?.includes('test') || e.path?.includes('Test') || e.path?.includes('spec'),
  );
  const phpTestFiles = testFiles.filter((e) => e.path?.endsWith('.php'));
  const jsTestFiles = testFiles.filter((e) =>
    e.path?.endsWith('.test.js') || e.path?.endsWith('.spec.js'),
  );

  if (phpTestFiles.length >= MIN_CONVENTION_OCCURRENCES) {
    const suffixTest = phpTestFiles.filter((e) => e.display_name.endsWith('Test.php'));
    if (suffixTest.length >= MIN_CONVENTION_OCCURRENCES) {
      candidates.push({
        category: 'testing',
        description: 'PHP test files end with Test.php',
        regex_pattern: 'Test\\.php$',
        occurrences: suffixTest.length,
        total_files: phpTestFiles.length,
      });
    }
  }

  if (jsTestFiles.length >= MIN_CONVENTION_OCCURRENCES) {
    const dotTest = jsTestFiles.filter((e) => e.path?.endsWith('.test.js'));
    if (dotTest.length >= MIN_CONVENTION_OCCURRENCES) {
      candidates.push({
        category: 'testing',
        description: 'JavaScript test files use .test.js suffix',
        regex_pattern: '\\.test\\.js$',
        occurrences: dotTest.length,
        total_files: jsTestFiles.length,
      });
    }
  }
}
