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

import type { OndbayConfig, FileAnalysisResult } from '../shared/types.js';
import { detectLanguage, isBinaryFile, validatePath, validateFileSize } from '../shared/utils.js';
import { parsePhpFile } from './parsers/php.js';
import { parseJavaScriptFile } from './parsers/javascript.js';
import { detectLaravelPatterns } from './frameworks/laravel.js';
import { detectExpressPatterns } from './frameworks/express.js';

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
  config: OndbayConfig,
): FileAnalysisResult | null {
  if (isBinaryFile(relativePath)) return null;

  const language = detectLanguage(relativePath);
  if (!language || (language !== 'php' && language !== 'javascript')) return null;

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
      break;
    case 'javascript':
      result = parseJavaScriptFile(relativePath, content);
      if (result && config.analysis.frameworks?.includes('express')) {
        detectExpressPatterns(result, content);
      }
      break;
    default:
      return null;
  }

  return result;
}
