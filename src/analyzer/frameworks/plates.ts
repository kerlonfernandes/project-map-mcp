/**
 * League Plates Template Adapter.
 *
 * Detects Plates template rendering patterns in PHP analysis results
 * and enriches them with framework edges:
 *
 * - $this->view->render(THEME . '/template') → edge `renders`
 * - $v->fetch('partial')                     → edge `renders`
 * - $v->insert('partial')                    → edge `renders`
 * - $v->layout('layout')                     → edge `renders`
 *
 * Supports projects using a custom System\Plates\Engine (wrapping League\Plates)
 * where each module has a theme constant (e.g. AUDITTHEME) pointing to a
 * template directory.
 *
 * Applied AFTER the PHP parser for files in Plates-based projects.
 *
 * Used by: analyzer/core.ts.
 */

import type { FileAnalysisResult } from '../../shared/types.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/**
 * Enriches a PHP analysis result with Plates template rendering edges.
 * Mutates the result in place and returns it.
 *
 * @param result - Output from parsePhpFile.
 * @param content - Raw PHP source code.
 * @returns The enriched result.
 */
export function detectPlatesPatterns(
  result: FileAnalysisResult,
  content: string,
): FileAnalysisResult {
  const relativePath = result.path;
  const fileQualified = result.entities.find(
    (e) => e.entity_type === 'file',
  )?.qualified_name ?? relativePath;

  extractViewRenders(result, content, fileQualified);
  extractTemplateCalls(result, content, fileQualified);

  return result;
}

/**
 * Extracts $this->view->render(THEME . '/template') calls from controllers.
 * The THEME constant typically resolves to a module's theme path.
 */
function extractViewRenders(
  result: FileAnalysisResult,
  content: string,
  fileQualified: string,
): void {
  // $this->view->render(CONSTANT . '/template') or $this->view->render('path/template')
  const renderPattern =
    /\$this->view->render\(\s*(?:([A-Z_]+)\s*\.\s*)?['"]([^'"]*)['"]\s*(?:,\s*\[.*?\])?\s*\)/gm;

  let match: RegExpExecArray | null;
  while ((match = renderPattern.exec(content)) !== null) {
    const themeConst = match[1] ?? null;
    const templatePath = match[2]!;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    const targetDisplay = themeConst
      ? `${themeConst}/${templatePath}`
      : templatePath;

    result.edges.push({
      source_qualified_name: fileQualified,
      target_qualified_name: `template:${targetDisplay}`,
      edge_type: 'renders',
      weight: EDGE_WEIGHTS['renders'] ?? 0.5,
      resolution_status: 'ambiguous',
      line: lineNumber,
    });
  }
}

/**
 * Extracts $v->fetch(), $v->insert(), and $v->layout() calls from templates.
 * These are League Plates v4 template composition methods.
 */
function extractTemplateCalls(
  result: FileAnalysisResult,
  content: string,
  fileQualified: string,
): void {
  // $v->fetch('name'), $v->insert('name'), $v->layout('name'), $this->fetch('name'), etc.
  const templateCallPattern =
    /\$(?:v|this)->(fetch|insert|layout)\(\s*['"]([^'"]+)['"]/gm;

  let match: RegExpExecArray | null;
  while ((match = templateCallPattern.exec(content)) !== null) {
    const templateName = match[2]!;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    result.edges.push({
      source_qualified_name: fileQualified,
      target_qualified_name: `template:${templateName}`,
      edge_type: 'renders',
      weight: EDGE_WEIGHTS['renders'] ?? 0.5,
      resolution_status: 'ambiguous',
      line: lineNumber,
    });
  }
}
