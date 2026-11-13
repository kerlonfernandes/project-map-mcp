/**
 * CoffeeCode Router Framework Adapter.
 *
 * Detects CoffeeCode Router patterns in PHP analysis results and enriches
 * them with framework entities and edges:
 *
 * - $router->namespace('Modules\X\Controllers')->group("module")
 * - $router->get|post|put|delete("/path", "Controller:method", "route.name")
 *
 * This is the router used by the ParceladoUSA monorepo: each module has a
 * routes.php that declares its controller mappings via CoffeeCode\Router.
 *
 * Applied AFTER the PHP parser for route files in CoffeeCode projects.
 *
 * Used by: analyzer/core.ts.
 */

import type { FileAnalysisResult } from '../../shared/types.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/**
 * Enriches a PHP analysis result with CoffeeCode Router entities and edges.
 * Mutates the result in place and returns it.
 *
 * @param result - Output from parsePhpFile.
 * @param content - Raw PHP source code.
 * @returns The enriched result.
 */
export function detectCoffeeCodePatterns(
  result: FileAnalysisResult,
  content: string,
): FileAnalysisResult {
  const relativePath = result.path;

  if (!isRoutesFile(relativePath)) return result;

  const group = extractGroup(content);
  const namespace = extractNamespace(content);

  extractRoutes(result, content, relativePath, group, namespace);

  return result;
}

/**
 * CoffeeCode route files live in Modules/{name}/routes.php or similar.
 */
function isRoutesFile(filePath: string): boolean {
  return filePath.endsWith('routes.php');
}

/**
 * Extracts the group name from $router->...->group("name").
 */
function extractGroup(content: string): string | null {
  const match = content.match(/->group\(\s*['"]([^'"]+)['"]\s*\)/);
  return match ? match[1]! : null;
}

/**
 * Extracts the namespace from $router->namespace('Modules\X\Controllers').
 */
function extractNamespace(content: string): string | null {
  const match = content.match(/->namespace\(\s*['"]([^'"]+)['"]\s*\)/);
  return match ? match[1]! : null;
}

/**
 * Extracts $router->method("/path", "Controller:action", "route.name") calls.
 */
function extractRoutes(
  result: FileAnalysisResult,
  content: string,
  relativePath: string,
  group: string | null,
  namespace: string | null,
): void {
  const routePattern =
    /\$router->(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?\s*\)/gm;

  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(content)) !== null) {
    const httpMethod = match[1]!.toUpperCase();
    const routePath = match[2]!;
    const controllerAction = match[3]!;
    const routeName = match[4] ?? null;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    const fullPath = group ? `/${group}${routePath}` : routePath;
    const qualifiedName = routeName
      ? `route:${routeName}`
      : `route:${httpMethod}:${fullPath}`;

    const displayName = routeName
      ? `${httpMethod} ${fullPath} (${routeName})`
      : `${httpMethod} ${fullPath}`;

    result.entities.push({
      entity_type: 'route',
      scope: 'symbol',
      qualified_name: qualifiedName,
      display_name: displayName,
      path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      language: 'php',
      metadata: {
        http_method: httpMethod,
        route_path: fullPath,
        route_name: routeName,
        group,
      },
    });

    const controllerRef = resolveController(controllerAction, namespace);
    if (controllerRef) {
      result.edges.push({
        source_qualified_name: qualifiedName,
        target_qualified_name: controllerRef.controller,
        edge_type: 'handles_route',
        weight: EDGE_WEIGHTS['handles_route'] ?? 0.8,
        resolution_status: 'ambiguous',
        line: lineNumber,
      });
    }
  }
}

/**
 * Resolves "Controller:method" into a qualified controller name.
 * CoffeeCode format: "ControllerName:methodName"
 */
function resolveController(
  action: string,
  namespace: string | null,
): { controller: string; method: string } | null {
  const parts = action.split(':');
  if (parts.length !== 2) return null;

  const [controllerName, methodName] = parts as [string, string];
  const controller = namespace
    ? `${namespace}\\${controllerName}`
    : controllerName;

  return { controller, method: methodName };
}
