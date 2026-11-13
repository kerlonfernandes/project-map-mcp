/**
 * Python Parser — extracts entities and relationships from Python source files.
 *
 * Uses Tree-sitter to build an AST, then walks it to identify:
 * - Classes, functions, methods, decorators
 * - Imports (import X, from X import Y)
 * - Inheritance (class Foo(Bar))
 * - Module-level constants and variables
 *
 * This parser returns structured data and never persists anything.
 *
 * Used by: analyzer/core.ts.
 */

import Parser from 'tree-sitter';
import PythonLanguage from 'tree-sitter-python';
import type {
  FileAnalysisResult,
  ParsedEntity,
  ParsedEdge,
  ParsedEvidence,
} from '../../shared/types.js';
import { sha256 } from '../../shared/utils.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

/**
 * Parses a Python file and extracts entities, edges, and evidence.
 *
 * @param relativePath - File path relative to project root.
 * @param content - The Python source code as a string.
 * @returns Structured analysis result.
 */
export function parsePythonFile(relativePath: string, content: string): FileAnalysisResult {
  const parser = new Parser();
  parser.setLanguage(PythonLanguage);

  const tree = parser.parse(content);
  const entities: ParsedEntity[] = [];
  const edges: ParsedEdge[] = [];
  const evidence: ParsedEvidence[] = [];
  const errors: string[] = [];

  const lines = content.split('\n');

  entities.push({
    entity_type: 'file',
    scope: 'file',
    qualified_name: relativePath,
    display_name: relativePath.split('/').pop() ?? relativePath,
    path: relativePath,
    line_start: 1,
    line_end: lines.length,
    language: 'python',
  });

  try {
    walkNode(tree.rootNode, {
      relativePath,
      content,
      currentClass: null,
      entities,
      edges,
      evidence,
      errors,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`AST walk failed: ${msg}`);
  }

  return { path: relativePath, language: 'python', entities, edges, evidence, errors };
}

interface WalkContext {
  relativePath: string;
  content: string;
  currentClass: string | null;
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
}

function walkNode(node: Parser.SyntaxNode, ctx: WalkContext): void {
  switch (node.type) {
    case 'class_definition':
      handleClass(node, ctx);
      return;
    case 'function_definition':
      handleFunction(node, ctx);
      return;
    case 'import_statement':
      handleImport(node, ctx);
      return;
    case 'import_from_statement':
      handleFromImport(node, ctx);
      return;
    case 'decorated_definition':
      handleDecorated(node, ctx);
      return;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkNode(child, ctx);
  }
}

function handleClass(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const className = nameNode.text;
  const qualifiedName = `${ctx.relativePath}::${className}`;

  const docstring = extractDocstring(node);

  ctx.entities.push({
    entity_type: 'class',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: className,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'python',
  });

  if (docstring) {
    ctx.evidence.push({
      source_kind: 'docblock',
      path: ctx.relativePath,
      excerpt: docstring,
      line_start: node.startPosition.row + 2,
      line_end: node.startPosition.row + 2 + docstring.split('\n').length,
      content_hash: sha256(docstring),
    });
  }

  // Superclasses (inheritance)
  const argList = node.childForFieldName('superclasses');
  if (argList) {
    for (let i = 0; i < argList.namedChildCount; i++) {
      const base = argList.namedChild(i);
      if (base) {
        ctx.edges.push({
          source_qualified_name: qualifiedName,
          target_qualified_name: base.text,
          edge_type: 'extends',
          weight: EDGE_WEIGHTS['extends'] ?? 0.9,
          resolution_status: 'ambiguous',
        });
      }
    }
  }

  // Walk body with class context
  const body = node.childForFieldName('body');
  if (body) {
    const prevClass = ctx.currentClass;
    ctx.currentClass = className;
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child) walkNode(child, ctx);
    }
    ctx.currentClass = prevClass;
  }
}

function handleFunction(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text;
  const isMethod = ctx.currentClass !== null;
  const qualifiedName = isMethod
    ? `${ctx.relativePath}::${ctx.currentClass}.${funcName}`
    : `${ctx.relativePath}::${funcName}`;

  const docstring = extractDocstring(node);

  ctx.entities.push({
    entity_type: isMethod ? 'function' : 'function',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: isMethod ? `${ctx.currentClass}.${funcName}` : funcName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'python',
  });

  if (docstring) {
    ctx.evidence.push({
      source_kind: 'docblock',
      path: ctx.relativePath,
      excerpt: docstring,
      line_start: node.startPosition.row + 2,
      line_end: node.startPosition.row + 2 + docstring.split('\n').length,
      content_hash: sha256(docstring),
    });
  }
}

function handleImport(node: Parser.SyntaxNode, ctx: WalkContext): void {
  // import foo, import foo.bar
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'dotted_name' || child.type === 'aliased_import')) {
      const moduleName = child.type === 'aliased_import'
        ? (child.childForFieldName('name')?.text ?? child.text)
        : child.text;

      ctx.edges.push({
        source_qualified_name: ctx.relativePath,
        target_qualified_name: moduleName,
        edge_type: 'imports',
        weight: EDGE_WEIGHTS['imports'] ?? 0.6,
        resolution_status: 'ambiguous',
      });
    }
  }
}

function handleFromImport(node: Parser.SyntaxNode, ctx: WalkContext): void {
  // from foo import bar, baz
  const moduleNode = node.childForFieldName('module_name');
  const moduleName = moduleNode?.text ?? '';

  if (!moduleName) return;

  ctx.edges.push({
    source_qualified_name: ctx.relativePath,
    target_qualified_name: moduleName,
    edge_type: 'imports',
    weight: EDGE_WEIGHTS['imports'] ?? 0.6,
    resolution_status: 'ambiguous',
  });
}

function handleDecorated(node: Parser.SyntaxNode, ctx: WalkContext): void {
  // Walk the definition inside (class or function)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      if (child.type === 'class_definition' || child.type === 'function_definition') {
        walkNode(child, ctx);
      }
    }
  }
}

function extractDocstring(node: Parser.SyntaxNode): string | null {
  const body = node.childForFieldName('body');
  if (!body || body.namedChildCount === 0) return null;

  const firstStmt = body.namedChild(0);
  if (!firstStmt) return null;

  // Docstring: first statement is an expression_statement containing a string
  if (firstStmt.type === 'expression_statement') {
    const expr = firstStmt.namedChild(0);
    if (expr && expr.type === 'string') {
      const raw = expr.text;
      return raw
        .replace(/^("""|'''|"|')/, '')
        .replace(/("""|'''|"|')$/, '')
        .trim();
    }
  }

  return null;
}
