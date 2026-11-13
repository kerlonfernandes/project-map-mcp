/**
 * PHP Parser — extracts entities and relationships from PHP source files.
 *
 * Uses Tree-sitter to build an AST, then walks it to identify:
 * - Classes, interfaces, traits, functions
 * - Inheritance (extends, implements, use trait)
 * - Method calls, instantiation, imports (use statements)
 * - Docblocks and comments for evidence
 *
 * This parser returns structured data and never persists anything.
 * Framework-specific patterns (Laravel) are detected in a separate
 * adapter module.
 *
 * Used by: analyzer/core.ts.
 */

import Parser from 'tree-sitter';
import PhpLanguage from 'tree-sitter-php';
import type {
  FileAnalysisResult,
  ParsedEntity,
  ParsedEdge,
  ParsedEvidence,
} from '../../shared/types.js';
import { sha256 } from '../../shared/utils.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

// Tree-sitter-php exposes the language under .php for the PHP sub-grammar
const phpLanguage = (PhpLanguage as { php: Parser.Language }).php ?? PhpLanguage;

/**
 * Parses a PHP file and extracts entities, edges, and evidence.
 *
 * @param relativePath - File path relative to project root.
 * @param content - The PHP source code as a string.
 * @returns Structured analysis result.
 */
export function parsePhpFile(relativePath: string, content: string): FileAnalysisResult {
  const parser = new Parser();
  parser.setLanguage(phpLanguage as Parser.Language);

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
    language: 'php',
  });

  // Extract namespace for qualified name resolution
  let namespace = '';

  try {
    walkNode(tree.rootNode, {
      relativePath,
      content,
      namespace,
      currentClass: null,
      entities,
      edges,
      evidence,
      errors,
      setNamespace(ns: string) { namespace = ns; this.namespace = ns; },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`AST walk failed: ${msg}`);
  }

  return { path: relativePath, language: 'php', entities, edges, evidence, errors };
}

interface WalkContext {
  relativePath: string;
  content: string;
  namespace: string;
  currentClass: string | null;
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
  setNamespace: (ns: string) => void;
}

/**
 * Recursively walks the AST tree, extracting entities and relationships.
 */
function walkNode(node: Parser.SyntaxNode, ctx: WalkContext): void {
  switch (node.type) {
    case 'namespace_definition':
      handleNamespace(node, ctx);
      break;
    case 'namespace_use_declaration':
      handleUseStatement(node, ctx);
      break;
    case 'class_declaration':
      handleClass(node, ctx);
      break;
    case 'interface_declaration':
      handleInterface(node, ctx);
      break;
    case 'trait_declaration':
      handleTrait(node, ctx);
      break;
    case 'function_definition':
      handleFunction(node, ctx);
      break;
  }

  // Recurse into children
  for (const child of node.children) {
    walkNode(child, ctx);
  }
}

function handleNamespace(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    ctx.setNamespace(nameNode.text);
  }
}

function handleUseStatement(node: Parser.SyntaxNode, ctx: WalkContext): void {
  // `use App\Models\User;` → import edge
  for (const child of node.namedChildren) {
    if (child.type === 'namespace_use_clause') {
      const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
      if (nameNode) {
        const importedName = nameNode.text;
        const sourceQualified = ctx.currentClass
          ? qualifyName(ctx.namespace, ctx.currentClass)
          : ctx.relativePath;

        ctx.edges.push({
          source_qualified_name: sourceQualified,
          target_qualified_name: importedName,
          edge_type: 'imports',
          weight: EDGE_WEIGHTS['imports'] ?? 0.6,
          resolution_status: 'resolved',
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handleClass(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const className = nameNode.text;
  const qualifiedName = qualifyName(ctx.namespace, className);
  const prevClass = ctx.currentClass;
  ctx.currentClass = className;

  // Signature: collect modifiers, name, extends, implements
  const signature = buildClassSignature(node, className);

  ctx.entities.push({
    entity_type: 'class',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: className,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'php',
    signature,
    metadata: extractClassMetadata(node),
  });

  // Extract docblock as evidence
  extractDocblockEvidence(node, ctx, qualifiedName);

  // Handle extends
  const baseClause = node.childForFieldName('base_clause')
    ?? findChild(node, 'base_clause');
  if (baseClause) {
    const parentName = baseClause.namedChildren[0]?.text;
    if (parentName) {
      ctx.edges.push({
        source_qualified_name: qualifiedName,
        target_qualified_name: resolveClassName(parentName, ctx.namespace),
        edge_type: 'extends',
        weight: EDGE_WEIGHTS['extends'] ?? 0.9,
        resolution_status: 'resolved',
        line: baseClause.startPosition.row + 1,
      });
    }
  }

  // Handle implements
  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    for (const child of interfaceClause.namedChildren) {
      if (child.type === 'name' || child.type === 'qualified_name') {
        ctx.edges.push({
          source_qualified_name: qualifiedName,
          target_qualified_name: resolveClassName(child.text, ctx.namespace),
          edge_type: 'implements',
          weight: EDGE_WEIGHTS['implements'] ?? 0.9,
          resolution_status: 'resolved',
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  // Handle use trait inside class body
  const body = node.childForFieldName('body')
    ?? findChild(node, 'declaration_list');
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === 'use_declaration') {
        for (const traitChild of member.namedChildren) {
          if (traitChild.type === 'name' || traitChild.type === 'qualified_name') {
            ctx.edges.push({
              source_qualified_name: qualifiedName,
              target_qualified_name: resolveClassName(traitChild.text, ctx.namespace),
              edge_type: 'uses_trait',
              weight: EDGE_WEIGHTS['uses_trait'] ?? 0.8,
              resolution_status: 'resolved',
              line: traitChild.startPosition.row + 1,
            });
          }
        }
      }

      // Extract methods
      if (member.type === 'method_declaration') {
        handleMethod(member, ctx, qualifiedName);
      }
    }
  }

  ctx.currentClass = prevClass;
}

function handleInterface(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const interfaceName = nameNode.text;
  const qualifiedName = qualifyName(ctx.namespace, interfaceName);

  ctx.entities.push({
    entity_type: 'interface',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: interfaceName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'php',
  });

  extractDocblockEvidence(node, ctx, qualifiedName);
}

function handleTrait(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const traitName = nameNode.text;
  const qualifiedName = qualifyName(ctx.namespace, traitName);

  ctx.entities.push({
    entity_type: 'trait',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: traitName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'php',
  });

  extractDocblockEvidence(node, ctx, qualifiedName);
}

function handleFunction(node: Parser.SyntaxNode, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text;
  const qualifiedName = ctx.namespace
    ? `${ctx.namespace}\\${funcName}`
    : funcName;

  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  const signature = `function ${funcName}(${params?.text ?? ''})${returnType ? ': ' + returnType.text : ''}`;

  ctx.entities.push({
    entity_type: 'function',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: funcName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'php',
    signature,
  });

  extractDocblockEvidence(node, ctx, qualifiedName);
}

function handleMethod(
  node: Parser.SyntaxNode,
  ctx: WalkContext,
  classQualifiedName: string,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const methodName = nameNode.text;
  const qualifiedName = `${classQualifiedName}::${methodName}`;

  // Visibility
  let visibility = 'public';
  for (const child of node.children) {
    if (child.type === 'visibility_modifier') {
      visibility = child.text;
    }
  }

  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  const signature = `${visibility} function ${methodName}(${params?.text ?? ''})${returnType ? ': ' + returnType.text : ''}`;

  ctx.entities.push({
    entity_type: 'function',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: methodName,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'php',
    signature,
    metadata: { visibility, is_method: true, class: classQualifiedName },
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function qualifyName(namespace: string, name: string): string {
  return namespace ? `${namespace}\\${name}` : name;
}

function resolveClassName(name: string, currentNamespace: string): string {
  if (name.startsWith('\\')) return name.slice(1);
  if (name.includes('\\')) return name;
  return currentNamespace ? `${currentNamespace}\\${name}` : name;
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

function buildClassSignature(node: Parser.SyntaxNode, className: string): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.type === 'abstract_modifier') parts.push('abstract');
    if (child.type === 'final_modifier') parts.push('final');
  }
  parts.push('class', className);

  const baseClause = node.childForFieldName('base_clause') ?? findChild(node, 'base_clause');
  if (baseClause) {
    parts.push('extends', baseClause.namedChildren[0]?.text ?? '');
  }

  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    parts.push('implements', interfaceClause.namedChildren.map((c) => c.text).join(', '));
  }

  return parts.join(' ');
}

function extractClassMetadata(node: Parser.SyntaxNode): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const child of node.children) {
    if (child.type === 'abstract_modifier') meta.abstract = true;
    if (child.type === 'final_modifier') meta.final = true;
  }
  return meta;
}

function extractDocblockEvidence(
  node: Parser.SyntaxNode,
  ctx: WalkContext,
  _symbolName: string,
): void {
  // Look for a comment node immediately before this declaration
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
