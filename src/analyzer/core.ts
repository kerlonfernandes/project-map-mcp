/**
 * Code Analyzer orchestrator.
 *
 * Routes file analysis to the appropriate language-specific parser
 * based on file extension. After the base parser runs, applies any
 * matching framework adapter (Laravel for PHP, Express for JS) to
 * enrich the result with framework-specific entities and edges.
 *
 * The Sync Engine calls this module for every file that needs analysis.
 * This module never touches the database directly.
 *
 * Used by: services/sync.ts.
 */

import fs from 'node:fs';

import type { ProjectMapConfig, FileAnalysisResult } from '../shared/types.js';
import { detectLanguage, isBinaryFile, isMinifiedFile, validatePath, validateFileSize } from '../shared/utils.js';
import { parsePhpFile } from './parsers/php.js';
import { parseJavaScriptFile } from './parsers/javascript.js';
import { parsePythonFile } from './parsers/python.js';
import { detectLaravelPatterns } from './frameworks/laravel.js';
import { detectExpressPatterns } from './frameworks/express.js';
import { detectCoffeeCodePatterns } from './frameworks/coffeecode.js';
import { detectPlatesPatterns } from './frameworks/plates.js';

/**
 * Analyzes a single file and returns extracted entities, edges, and evidence.
 *
 * Pipeline: validate → parse (Tree-sitter) → enrich (framework adapter).
 *
 * @param relativePath - File path relative to project root.
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Project configuration.
 * @returns Analysis result, or null if the file is not parseable.
 */
export function analyzeFile(
  relativePath: string,
  projectRoot: string,
  config: ProjectMapConfig,
): FileAnalysisResult | null {
  if (isBinaryFile(relativePath)) return null;
  if (isMinifiedFile(relativePath)) return null;

  const language = detectLanguage(relativePath);
  if (!language) return null;

  const PARSEABLE_LANGUAGES = new Set(['php', 'javascript', 'python', 'css', 'html']);
  if (!PARSEABLE_LANGUAGES.has(language)) return null;

  // SECURITY: validate path is within project root
  const absolutePath = validatePath(relativePath, projectRoot, config.security.blocked_paths);

  if (!fs.existsSync(absolutePath)) return null;

  const maxSize = config.analysis.max_file_size_mb * 1024 * 1024;
  validateFileSize(absolutePath, maxSize);

  const content = fs.readFileSync(absolutePath, 'utf-8');

  let result: FileAnalysisResult | null = null;

  switch (language) {
    case 'php':
      result = parsePhpFile(relativePath, content);
      if (result && config.analysis.frameworks?.includes('laravel')) {
        detectLaravelPatterns(result, content);
      }
      if (result && config.analysis.frameworks?.includes('coffeecode')) {
        detectCoffeeCodePatterns(result, content);
      }
      if (result && config.analysis.frameworks?.includes('plates')) {
        detectPlatesPatterns(result, content);
      }
      break;
    case 'javascript':
      result = parseJavaScriptFile(relativePath, content);
      if (result && config.analysis.frameworks?.includes('express')) {
        detectExpressPatterns(result, content);
      }
      break;
    case 'python':
      result = parsePythonFile(relativePath, content);
      break;
    case 'css':
    case 'html':
      result = {
        path: relativePath,
        language,
        entities: [{
          entity_type: language === 'html' ? 'template' : 'stylesheet',
          scope: 'file',
          qualified_name: relativePath,
          display_name: relativePath.split('/').pop() ?? relativePath,
          path: relativePath,
          line_start: 1,
          line_end: content.split('\n').length,
          language,
        }],
        edges: [],
        evidence: [],
        errors: [],
      };
      break;
    default:
      return null;
  }

  return result;
}
