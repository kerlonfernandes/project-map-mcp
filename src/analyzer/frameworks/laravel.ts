/**
 * Laravel Framework Adapter.
 *
 * Detects Laravel-specific patterns in PHP analysis results and enriches
 * them with framework entities and edges:
 *
 * - Routes (Route::get/post/...) → entity `route` + edge `handles_route`
 * - Eloquent Models (extends Model) → entity `model` + relationship edges
 * - Migrations (extends Migration) → entity `migration` + edge `migrates`
 * - Events, Listeners, Jobs, Middleware, Commands, Config, Factories, Seeders
 * - Blade view references (view('name')) → edge `renders`
 *
 * Applied AFTER the PHP parser for files in Laravel projects. Reads the
 * already-parsed entities/edges and adds framework-specific ones by
 * re-examining the source code with targeted regex patterns.
 *
 * Used by: analyzer/core.ts.
 */

import type {
  FileAnalysisResult,
  ParsedEntity,
  ParsedEdge,
} from '../../shared/types.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/** Eloquent relationship method names → edge type mapping. */
const ELOQUENT_RELATIONSHIPS: Record<string, string> = {
  hasMany: 'has_many',
  hasOne: 'has_one',
  belongsTo: 'belongs_to_model',
  belongsToMany: 'many_to_many',
};

/**
 * Enriches a PHP analysis result with Laravel-specific entities and edges.
 * Mutates the result in place and returns it.
 *
 * @param result - Output from parsePhpFile.
 * @param content - Raw PHP source code.
 * @returns The enriched result.
 */
export function detectLaravelPatterns(
  result: FileAnalysisResult,
  content: string,
): FileAnalysisResult {
  const relativePath = result.path;

  if (isRoutesFile(relativePath)) {
    extractRoutes(result, content, relativePath);
  }

  if (isConfigFile(relativePath)) {
    extractConfigEntity(result, relativePath);
  }

  enrichClassEntities(result, content, relativePath);
  extractBladeReferences(result, content, relativePath);

  return result;
}

/**
 * Detects whether a file lives in a Laravel routes directory.
 */
function isRoutesFile(filePath: string): boolean {
  return filePath.startsWith('routes/') && filePath.endsWith('.php');
}

/**
 * Detects whether a file lives in the config directory.
 */
function isConfigFile(filePath: string): boolean {
  return filePath.startsWith('config/') && filePath.endsWith('.php');
}

// ──────────────────────────────────────────────────────────────────────
// Route extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Extracts Route::method() calls from route files.
 * Creates `route` entities and `handles_route` edges to controllers.
 */
function extractRoutes(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  // Match Route::get('/path', [Controller::class, 'method'])
  // Match Route::get('/path', 'Controller@method')
  // Match Route::get('/path', function() {})
  const routePattern =
    /Route::(get|post|put|patch|delete|options|any|match)\(\s*['"]([^'"]+)['"]/gm;

  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(content)) !== null) {
    const httpMethod = match[1]!.toUpperCase();
    const routePath = match[2]!;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    const routeQualifiedName = `route:${httpMethod}:${routePath}`;

    result.entities.push({
      entity_type: 'route',
      scope: 'symbol',
      qualified_name: routeQualifiedName,
      display_name: `${httpMethod} ${routePath}`,
      path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      language: 'php',
      metadata: { http_method: httpMethod, route_path: routePath },
    });

    const controllerRef = extractControllerFromRoute(content, match.index);
    if (controllerRef) {
      result.edges.push({
        source_qualified_name: routeQualifiedName,
        target_qualified_name: controllerRef,
        edge_type: 'handles_route',
        weight: EDGE_WEIGHTS['handles_route'] ?? 0.8,
        resolution_status: 'ambiguous',
        line: lineNumber,
      });
    }
  }

  // Match Route::resource() and Route::apiResource()
  const resourcePattern =
    /Route::(resource|apiResource)\(\s*['"]([^'"]+)['"]\s*,\s*([^\s),]+)/gm;

  while ((match = resourcePattern.exec(content)) !== null) {
    const routePath = match[2]!;
    const controllerRef = match[3]!.replace('::class', '').replace(/[[\]']/g, '');
    const lineNumber = content.slice(0, match.index).split('\n').length;

    for (const method of ['index', 'show', 'store', 'update', 'destroy']) {
      const routeQualifiedName = `route:RESOURCE:${routePath}.${method}`;

      result.entities.push({
        entity_type: 'route',
        scope: 'symbol',
        qualified_name: routeQualifiedName,
        display_name: `RESOURCE ${routePath}.${method}`,
        path: relativePath,
        line_start: lineNumber,
        line_end: lineNumber,
        language: 'php',
        metadata: { http_method: 'RESOURCE', route_path: routePath, action: method },
      });

      result.edges.push({
        source_qualified_name: routeQualifiedName,
        target_qualified_name: controllerRef,
        edge_type: 'handles_route',
        weight: EDGE_WEIGHTS['handles_route'] ?? 0.8,
        resolution_status: 'ambiguous',
        line: lineNumber,
      });
    }
  }
}

/**
 * Extracts the controller reference from the area around a Route:: call.
 */
function extractControllerFromRoute(content: string, matchIndex: number): string | null {
  const contextEnd = content.indexOf('\n', matchIndex + 200);
  const lineContext = content.slice(matchIndex, contextEnd !== -1 ? contextEnd : matchIndex + 300);

  // [Controller::class, 'method']
  const arrayStyle = lineContext.match(/\[\s*([A-Z][\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]/);
  if (arrayStyle) {
    return arrayStyle[1]!;
  }

  // 'Controller@method'
  const atStyle = lineContext.match(/['"]([A-Z][\w\\]+)@(\w+)['"]/);
  if (atStyle) {
    return atStyle[1]!;
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Class enrichment (Models, Migrations, Events, Jobs, etc.)
// ──────────────────────────────────────────────────────────────────────

/**
 * Looks at class entities already extracted by the PHP parser and
 * enriches them with Laravel-specific entity types and edges based
 * on their parent class.
 */
function enrichClassEntities(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  const classEntities = result.entities.filter((e) => e.entity_type === 'class');
  const extendsEdges = result.edges.filter((e) => e.edge_type === 'extends');

  for (const classEntity of classEntities) {
    const parentEdge = extendsEdges.find(
      (e) => e.source_qualified_name === classEntity.qualified_name,
    );
    const parentName = parentEdge?.target_qualified_name?.split('\\').pop() ?? '';

    if (parentName === 'Model' || parentName === 'Authenticatable') {
      enrichModel(result, classEntity, content, relativePath);
    } else if (parentName === 'Migration') {
      enrichMigration(result, classEntity, relativePath);
    } else if (parentName === 'Command') {
      addFrameworkEntity(result, classEntity, 'command');
    } else if (parentName === 'Factory') {
      enrichFactory(result, classEntity, content, relativePath);
    } else if (parentName === 'Seeder') {
      addFrameworkEntity(result, classEntity, 'seeder');
    }

    // Events: check for ShouldBroadcast or Event suffix
    if (isEvent(classEntity, parentName)) {
      addFrameworkEntity(result, classEntity, 'event');
    }

    // Jobs: check for ShouldQueue interface
    if (isJob(classEntity, result.edges)) {
      addFrameworkEntity(result, classEntity, 'job');
    }

    // Listeners: check for handle() method
    if (isListener(classEntity, result.entities)) {
      enrichListener(result, classEntity, content, relativePath);
    }

    // Middleware: check for handle($request, $next) method
    if (isMiddleware(classEntity, result.entities)) {
      addFrameworkEntity(result, classEntity, 'middleware');
    }
  }
}

/**
 * Enriches an Eloquent model: creates `model` entity and relationship edges.
 */
function enrichModel(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  content: string,
  relativePath: string,
): void {
  result.entities.push({
    entity_type: 'model',
    scope: 'symbol',
    qualified_name: `model:${classEntity.qualified_name}`,
    display_name: classEntity.display_name,
    path: relativePath,
    line_start: classEntity.line_start,
    line_end: classEntity.line_end,
    language: 'php',
    metadata: { class: classEntity.qualified_name },
  });

  // Extract $table property for maps_to_table edge
  const tableMatch = content.match(
    /\$table\s*=\s*['"]([\w]+)['"]/,
  );
  const tableName = tableMatch
    ? tableMatch[1]!
    : pluralize(classEntity.display_name.toLowerCase());

  result.edges.push({
    source_qualified_name: classEntity.qualified_name,
    target_qualified_name: `table:${tableName}`,
    edge_type: 'maps_to_table',
    weight: tableMatch ? 0.99 : 0.85,
    resolution_status: tableMatch ? 'resolved' : 'ambiguous',
    line: classEntity.line_start,
  });

  // Extract Eloquent relationship methods
  extractEloquentRelationships(result, classEntity, content);
}

/**
 * Extracts Eloquent relationship method calls (hasMany, belongsTo, etc.)
 * and creates the corresponding edges.
 */
function extractEloquentRelationships(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  content: string,
): void {
  for (const [method, edgeType] of Object.entries(ELOQUENT_RELATIONSHIPS)) {
    const pattern = new RegExp(
      `\\$this->${method}\\(\\s*([A-Z][\\w\\\\]+)::class`,
      'g',
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const relatedModel = match[1]!;
      const lineNumber = content.slice(0, match.index).split('\n').length;

      result.edges.push({
        source_qualified_name: classEntity.qualified_name,
        target_qualified_name: relatedModel,
        edge_type: edgeType as ParsedEdge['edge_type'],
        weight: EDGE_WEIGHTS[edgeType as keyof typeof EDGE_WEIGHTS] ?? 0.7,
        resolution_status: 'ambiguous',
        line: lineNumber,
      });
    }
  }
}

/**
 * Enriches a migration class: creates `migration` entity.
 */
function enrichMigration(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  relativePath: string,
): void {
  result.entities.push({
    entity_type: 'migration',
    scope: 'symbol',
    qualified_name: `migration:${classEntity.qualified_name}`,
    display_name: classEntity.display_name,
    path: relativePath,
    line_start: classEntity.line_start,
    line_end: classEntity.line_end,
    language: 'php',
  });
}

/**
 * Enriches a factory class: creates `factory` entity + `tests` edge to model.
 */
function enrichFactory(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  content: string,
  relativePath: string,
): void {
  result.entities.push({
    entity_type: 'factory',
    scope: 'symbol',
    qualified_name: `factory:${classEntity.qualified_name}`,
    display_name: classEntity.display_name,
    path: relativePath,
    line_start: classEntity.line_start,
    line_end: classEntity.line_end,
    language: 'php',
  });

  // Extract model reference: protected $model = ModelClass::class;
  const modelMatch = content.match(/\$model\s*=\s*([A-Z][\w\\]+)::class/);
  if (modelMatch) {
    result.edges.push({
      source_qualified_name: classEntity.qualified_name,
      target_qualified_name: modelMatch[1]!,
      edge_type: 'tests',
      weight: EDGE_WEIGHTS['tests'] ?? 0.6,
      resolution_status: 'ambiguous',
      line: classEntity.line_start,
    });
  }
}

/**
 * Enriches a listener class: creates `listener` entity + `listens_to` edge.
 */
function enrichListener(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  content: string,
  relativePath: string,
): void {
  result.entities.push({
    entity_type: 'listener',
    scope: 'symbol',
    qualified_name: `listener:${classEntity.qualified_name}`,
    display_name: classEntity.display_name,
    path: relativePath,
    line_start: classEntity.line_start,
    line_end: classEntity.line_end,
    language: 'php',
  });

  // Try to find the event type from the handle() parameter type hint
  const handleMatch = content.match(
    /function\s+handle\s*\(\s*([A-Z][\w\\]+)\s+\$/,
  );
  if (handleMatch) {
    result.edges.push({
      source_qualified_name: classEntity.qualified_name,
      target_qualified_name: handleMatch[1]!,
      edge_type: 'listens_to',
      weight: EDGE_WEIGHTS['listens_to'] ?? 0.7,
      resolution_status: 'ambiguous',
      line: classEntity.line_start,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Config entity
// ──────────────────────────────────────────────────────────────────────

/**
 * Creates a config entity for files in the config/ directory.
 */
function extractConfigEntity(
  result: FileAnalysisResult,
  relativePath: string,
): void {
  const configName = relativePath
    .replace('config/', '')
    .replace('.php', '');

  result.entities.push({
    entity_type: 'config',
    scope: 'file',
    qualified_name: `config:${configName}`,
    display_name: configName,
    path: relativePath,
    line_start: 1,
    line_end: 1,
    language: 'php',
  });
}

// ──────────────────────────────────────────────────────────────────────
// Blade view references
// ──────────────────────────────────────────────────────────────────────

/**
 * Finds view('name') calls and creates `renders` edges to Blade files.
 */
function extractBladeReferences(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  const viewPattern = /view\(\s*['"]([^'"]+)['"]/g;
  const fileQualified = result.entities.find(
    (e) => e.entity_type === 'file',
  )?.qualified_name ?? relativePath;

  let match: RegExpExecArray | null;
  while ((match = viewPattern.exec(content)) !== null) {
    const viewName = match[1]!;
    const bladePath = `resources/views/${viewName.replace(/\./g, '/')}.blade.php`;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    result.edges.push({
      source_qualified_name: fileQualified,
      target_qualified_name: bladePath,
      edge_type: 'renders',
      weight: EDGE_WEIGHTS['renders'] ?? 0.7,
      resolution_status: 'ambiguous',
      line: lineNumber,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Classification helpers
// ──────────────────────────────────────────────────────────────────────

function isEvent(classEntity: ParsedEntity, parentName: string): boolean {
  return (
    parentName === 'Event' ||
    classEntity.display_name.endsWith('Event') ||
    parentName === 'ShouldBroadcast'
  );
}

function isJob(classEntity: ParsedEntity, edges: ParsedEdge[]): boolean {
  const implementsEdges = edges.filter(
    (e) =>
      e.edge_type === 'implements' &&
      e.source_qualified_name === classEntity.qualified_name,
  );
  return implementsEdges.some(
    (e) => e.target_qualified_name.includes('ShouldQueue'),
  );
}

function isListener(classEntity: ParsedEntity, entities: ParsedEntity[]): boolean {
  const methods = entities.filter(
    (e) =>
      e.entity_type === 'function' &&
      e.metadata?.is_method &&
      e.metadata?.class === classEntity.qualified_name,
  );
  return methods.some((m) => m.display_name === 'handle');
}

function isMiddleware(classEntity: ParsedEntity, entities: ParsedEntity[]): boolean {
  const methods = entities.filter(
    (e) =>
      e.entity_type === 'function' &&
      e.metadata?.is_method &&
      e.metadata?.class === classEntity.qualified_name,
  );
  const handleMethod = methods.find((m) => m.display_name === 'handle');
  if (!handleMethod?.signature) return false;
  return (
    handleMethod.signature.includes('$request') &&
    handleMethod.signature.includes('$next')
  );
}

function addFrameworkEntity(
  result: FileAnalysisResult,
  classEntity: ParsedEntity,
  entityType: ParsedEntity['entity_type'],
): void {
  result.entities.push({
    entity_type: entityType,
    scope: 'symbol',
    qualified_name: `${entityType}:${classEntity.qualified_name}`,
    display_name: classEntity.display_name,
    path: classEntity.path,
    line_start: classEntity.line_start,
    line_end: classEntity.line_end,
    language: 'php',
    metadata: { class: classEntity.qualified_name },
  });
}

// ──────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────

/**
 * Naive English pluralization for table name guessing.
 * Covers common cases: User→users, Category→categories, Status→statuses.
 */
function pluralize(word: string): string {
  if (word.endsWith('y') && !['ay', 'ey', 'iy', 'oy', 'uy'].some((v) => word.endsWith(v))) {
    return word.slice(0, -1) + 'ies';
  }
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') ||
      word.endsWith('ch') || word.endsWith('sh')) {
    return word + 'es';
  }
  return word + 's';
}
