/**
 * JavaScript Parser — extracts entities and relationships from JS files.
 *
 * Uses Tree-sitter to build an AST, then walks it to identify:
 * - Classes, functions (exported), arrow functions
 * - Imports (import/require) and exports
 * - Method calls, instantiation
 *
 * This is a Phase 2 parser — basic structure for now, will be
 * extended with full ES module resolution and Express adapter.
 *
 * Used by: analyzer/core.ts.
 */

import Parser from 'tree-sitter';
import JsLanguage from 'tree-sitter-javascript';
import type {
  FileAnalysisResult,
  ParsedEntity,
  ParsedEdge,
  ParsedEvidence,
} from '../../shared/types.js';
import { sha256 } from '../../shared/utils.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/**
 * Parses a JavaScript file and extracts entities, edges, and evidence.
 *
 * @param relativePath - File path relative to project root.
 * @param content - The JavaScript source code as a string.
 * @returns Structured analysis result.
 */
export function parseJavaScriptFile(
  relativePath: string,
  content: string,
): FileAnalysisResult {
  const parser = new Parser();
  parser.setLanguage(JsLanguage as unknown as Parser.Language);

  const tree = parser.parse(content);
  const entities: ParsedEntity[] = [];
  const edges: ParsedEdge[] = [];
  const evidence: ParsedEvidence[] = [];
  const errors: string[] = [];

  // File entity
  entities.push({
    entity_type: 'file',
    scope: 'file',
    qualified_name: relativePath,
    display_name: relativePath.split('/').pop() ?? relativePath,
    path: relativePath,
    line_start: 1,
    line_end: content.split('\n').length,
    language: 'javascript',
  });

  try {
    walkJsNode(tree.rootNode, {
      relativePath,
      content,
      entities,
      edges,
      evidence,
      errors,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`AST walk failed: ${msg}`);
  }

  return { path: relativePath, language: 'javascript', entities, edges, evidence, errors };
}

interface JsWalkContext {
  relativePath: string;
  content: string;
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
}

function walkJsNode(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  switch (node.type) {
    case 'import_statement':
      handleImport(node, ctx);
      break;
    case 'class_declaration':
      handleJsClass(node, ctx);
      break;
    case 'function_declaration':
      handleJsFunction(node, ctx);
      break;
    case 'export_statement':
      handleExport(node, ctx);
      break;
    case 'lexical_declaration':
    case 'variable_declaration':
      handleVariableDeclaration(node, ctx);
      break;
  }

  // Recurse into children (but skip class/function bodies to avoid double processing)
  for (const child of node.children) {
    if (child.type !== 'class_body' && child.type !== 'statement_block') {
      walkJsNode(child, ctx);
    }
  }
}

function handleImport(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;

  const modulePath = sourceNode.text.replace(/['"]/g, '');
  const isRelative = modulePath.startsWith('.') || modulePath.startsWith('/');

  ctx.edges.push({
    source_qualified_name: ctx.relativePath,
    target_qualified_name: isRelative ? resolveRelativePath(ctx.relativePath, modulePath) : modulePath,
    edge_type: 'imports',
    weight: EDGE_WEIGHTS['imports'] ?? 0.6,
    resolution_status: isRelative ? 'resolved' : 'resolved',
    line: node.startPosition.row + 1,
  });

  // If importing from a package, create a package entity
  if (!isRelative) {
    const packageName = modulePath.startsWith('@')
      ? modulePath.split('/').slice(0, 2).join('/')
      : modulePath.split('/')[0] ?? modulePath;

    ctx.entities.push({
      entity_type: 'package',
      scope: 'external',
      qualified_name: `npm:${packageName}`,
      display_name: packageName!,
      path: ctx.relativePath,
      line_start: node.startPosition.row + 1,
      line_end: node.endPosition.row + 1,
      language: 'javascript',
    });
  }
}

function handleJsClass(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const className = nameNode.text;
  const qualifiedName = `${ctx.relativePath}:${className}`;

  ctx.entities.push({
    entity_type: 'class',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: className,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'javascript',
  });

  // Handle extends
  const heritage = node.childForFieldName('superclass')
    ?? findJsChild(node, 'class_heritage');
  if (heritage) {
    const parentName = heritage.text.replace('extends ', '').trim();
    ctx.edges.push({
      source_qualified_name: qualifiedName,
      target_qualified_name: parentName,
      edge_type: 'extends',
      weight: EDGE_WEIGHTS['extends'] ?? 0.9,
      resolution_status: 'ambiguous',
      line: heritage.startPosition.row + 1,
    });
  }

  extractJsDocEvidence(node, ctx);

  // Extract methods from class body
  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === 'method_definition') {
        handleJsMethod(member, ctx, qualifiedName);
      }
    }
  }
}

function handleJsFunction(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text;
  const qualifiedName = `${ctx.relativePath}:${funcName}`;

  const params = node.childForFieldName('parameters');
  const signature = `function ${funcName}(${params?.text ?? ''})`;

  ctx.entities.push({
    entity_type: 'function',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: funcName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'javascript',
    signature,
  });

  extractJsDocEvidence(node, ctx);
}

function handleJsMethod(
  node: Parser.SyntaxNode,
  ctx: JsWalkContext,
  classQualifiedName: string,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const methodName = nameNode.text;
  const qualifiedName = `${classQualifiedName}.${methodName}`;

  ctx.entities.push({
    entity_type: 'function',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: methodName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'javascript',
    metadata: { is_method: true, class: classQualifiedName },
  });
}

function handleExport(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  // Process the exported declaration within the export
  for (const child of node.namedChildren) {
    walkJsNode(child, ctx);
  }
}

function handleVariableDeclaration(
  node: Parser.SyntaxNode,
  ctx: JsWalkContext,
): void {
  // Look for `const X = require('...')` patterns
  for (const declarator of node.namedChildren) {
    if (declarator.type === 'variable_declarator') {
      const init = declarator.childForFieldName('value');
      if (init?.type === 'call_expression') {
        const func = init.childForFieldName('function');
        if (func?.text === 'require') {
          const args = init.childForFieldName('arguments');
          const firstArg = args?.namedChildren[0];
          if (firstArg?.type === 'string') {
            const modulePath = firstArg.text.replace(/['"]/g, '');
            const isRelative = modulePath.startsWith('.');

            ctx.edges.push({
              source_qualified_name: ctx.relativePath,
              target_qualified_name: isRelative
                ? resolveRelativePath(ctx.relativePath, modulePath)
                : modulePath,
              edge_type: 'imports',
              weight: EDGE_WEIGHTS['imports'] ?? 0.6,
              resolution_status: isRelative ? 'resolved' : 'resolved',
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function findJsChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

function resolveRelativePath(fromFile: string, importPath: string): string {
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = (dir ? dir + '/' + importPath : importPath).split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }

  return resolved.join('/');
}

function extractJsDocEvidence(node: Parser.SyntaxNode, ctx: JsWalkContext): void {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment') {
    const excerpt = prev.text;
    ctx.evidence.push({
      source_kind: excerpt.startsWith('/**') ? 'docblock' : 'comment',
      path: ctx.relativePath,
      line_start: prev.startPosition.row + 1,
      line_end: prev.endPosition.row + 1,
      excerpt: excerpt.slice(0, 500),
      content_hash: sha256(excerpt),
    });
  }
}
