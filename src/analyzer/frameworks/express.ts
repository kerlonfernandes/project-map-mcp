/**
 * Express Framework Adapter.
 *
 * Detects Express-specific patterns in JavaScript analysis results and
 * enriches them with framework entities and edges:
 *
 * - app.get/post/put/delete() → entity `route` + edge `handles_route`
 * - router.get/post/...()    → entity `route` with prefix
 * - app.use(middleware)       → entity `middleware`
 * - app.use('/prefix', router) → composition edges
 * - Error handlers (4 params) → entity `middleware` (error handler)
 *
 * Applied AFTER the JS parser for files in Express projects. Uses
 * regex on the source to find Express API calls that the generic JS
 * parser can't semantically identify.
 *
 * Used by: analyzer/core.ts.
 */

import type {
  FileAnalysisResult,
  ParsedEntity,
} from '../../shared/types.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/**
 * Enriches a JS analysis result with Express-specific entities and edges.
 * Mutates the result in place and returns it.
 *
 * @param result - Output from parseJavaScriptFile.
 * @param content - Raw JavaScript source code.
 * @returns The enriched result.
 */
export function detectExpressPatterns(
  result: FileAnalysisResult,
  content: string,
): FileAnalysisResult {
  const relativePath = result.path;

  extractExpressRoutes(result, content, relativePath);
  extractMiddleware(result, content, relativePath);
  extractRouterMounts(result, content, relativePath);
  extractErrorHandlers(result, content, relativePath);

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Route extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Extracts app.get/post/... and router.get/post/... calls.
 * Creates `route` entities and `handles_route` edges.
 */
function extractExpressRoutes(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  // Match app.get('/path', handler) or router.get('/path', handler)
  const routePattern =
    /(?:app|router)\.(get|post|put|patch|delete|options|head|all)\(\s*['"]([^'"]+)['"]/gm;

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
      language: 'javascript',
      metadata: { http_method: httpMethod, route_path: routePath },
    });

    const handlerRef = extractHandlerReference(content, match.index);
    if (handlerRef) {
      result.edges.push({
        source_qualified_name: routeQualifiedName,
        target_qualified_name: `${relativePath}:${handlerRef}`,
        edge_type: 'handles_route',
        weight: EDGE_WEIGHTS['handles_route'] ?? 0.8,
        resolution_status: 'ambiguous',
        line: lineNumber,
      });
    }
  }
}

/**
 * Tries to extract the handler function name from a route call.
 */
function extractHandlerReference(content: string, matchIndex: number): string | null {
  const contextEnd = content.indexOf('\n', matchIndex + 200);
  const lineContext = content.slice(
    matchIndex,
    contextEnd !== -1 ? contextEnd : matchIndex + 300,
  );

  // Named function reference: app.get('/path', controllerName)
  const namedHandler = lineContext.match(
    /,\s*([a-zA-Z_]\w+)\s*\)/,
  );
  if (namedHandler && namedHandler[1] !== 'function' && namedHandler[1] !== 'async') {
    return namedHandler[1]!;
  }

  // Controller method: app.get('/path', controller.method)
  const dotHandler = lineContext.match(
    /,\s*(\w+\.\w+)\s*\)/,
  );
  if (dotHandler) {
    return dotHandler[1]!;
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Middleware extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Detects app.use(middleware) calls (without a path prefix).
 * Creates `middleware` entities.
 */
function extractMiddleware(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  // Match app.use(middlewareName) or app.use(middleware())
  // But NOT app.use('/path', ...) — that's a router mount
  const middlewarePattern =
    /(?:app|router)\.use\(\s*(?!['"/])([a-zA-Z_][\w.]*)\s*(?:\(.*?\))?\s*\)/gm;

  let match: RegExpExecArray | null;
  while ((match = middlewarePattern.exec(content)) !== null) {
    const middlewareName = match[1]!;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    if (isAlreadyDetected(result.entities, 'middleware', middlewareName, relativePath)) {
      continue;
    }

    result.entities.push({
      entity_type: 'middleware',
      scope: 'symbol',
      qualified_name: `middleware:${relativePath}:${middlewareName}`,
      display_name: middlewareName,
      path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      language: 'javascript',
      metadata: { type: 'global' },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Router mount extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Detects app.use('/prefix', router) calls.
 * Creates composition edges from the mount path to the router module.
 */
function extractRouterMounts(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  // Match app.use('/prefix', routerVariable)
  const mountPattern =
    /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/gm;

  let match: RegExpExecArray | null;
  while ((match = mountPattern.exec(content)) !== null) {
    const prefix = match[1]!;
    const routerVar = match[2]!;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    result.edges.push({
      source_qualified_name: relativePath,
      target_qualified_name: `${relativePath}:${routerVar}`,
      edge_type: 'references',
      weight: EDGE_WEIGHTS['references'] ?? 0.3,
      resolution_status: 'ambiguous',
      line: lineNumber,
    });

    result.entities.push({
      entity_type: 'route',
      scope: 'symbol',
      qualified_name: `route:MOUNT:${prefix}`,
      display_name: `MOUNT ${prefix}`,
      path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      language: 'javascript',
      metadata: { http_method: 'MOUNT', route_path: prefix, router: routerVar },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Error handler extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Detects Express error handlers — functions with exactly 4 parameters
 * where the first is typically `err`.
 */
function extractErrorHandlers(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
): void {
  // Match function(err, req, res, next) or (err, req, res, next) =>
  const errorHandlerPattern =
    /(?:function\s+(\w+)\s*)?\(\s*(err|error)\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*(?:=>)?\s*\{/gm;

  let match: RegExpExecArray | null;
  while ((match = errorHandlerPattern.exec(content)) !== null) {
    const handlerName = match[1] ?? 'errorHandler';
    const lineNumber = content.slice(0, match.index).split('\n').length;

    if (isAlreadyDetected(result.entities, 'middleware', handlerName, relativePath)) {
      continue;
    }

    result.entities.push({
      entity_type: 'middleware',
      scope: 'symbol',
      qualified_name: `middleware:${relativePath}:${handlerName}`,
      display_name: `${handlerName} (error handler)`,
      path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      language: 'javascript',
      metadata: { type: 'error_handler' },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function isAlreadyDetected(
  entities: ParsedEntity[],
  entityType: string,
  name: string,
  path: string,
): boolean {
  return entities.some(
    (e) =>
      e.entity_type === entityType &&
      e.display_name === name &&
      e.path === path,
  );
}
