/**
 * TypeScript Parser — extracts entities and relationships from TS/TSX files.
 *
 * Uses Tree-sitter with the TypeScript and TSX grammars. Handles the same
 * node types as the JavaScript parser plus TypeScript-specific constructs:
 * - Interfaces, type aliases, enums
 * - Classes, functions (exported), arrow functions
 * - Imports (import/require) and exports
 *
 * Used by: analyzer/core.ts.
 */

import Parser from 'tree-sitter';
import TsLanguage from 'tree-sitter-typescript';
import type {
  FileAnalysisResult,
  ParsedEntity,
  ParsedEdge,
  ParsedEvidence,
} from '../../shared/types.js';
import { sha256 } from '../../shared/utils.js';
import { EDGE_WEIGHTS } from '../../shared/constants.js';

const tsGrammar = (TsLanguage as { typescript: unknown }).typescript;
const tsxGrammar = (TsLanguage as { tsx: unknown }).tsx;

/**
 * Parses a TypeScript file and extracts entities, edges, and evidence.
 */
export function parseTypeScriptFile(
  relativePath: string,
  content: string,
): FileAnalysisResult {
  const parser = new Parser();
  const isTsx = relativePath.endsWith('.tsx');
  parser.setLanguage(isTsx ? tsxGrammar : tsGrammar);

  const tree = parser.parse(content);
  const entities: ParsedEntity[] = [];
  const edges: ParsedEdge[] = [];
  const evidence: ParsedEvidence[] = [];
  const errors: string[] = [];

  entities.push({
    entity_type: 'file',
    scope: 'file',
    qualified_name: relativePath,
    display_name: relativePath.split('/').pop() ?? relativePath,
    path: relativePath,
    line_start: 1,
    line_end: content.split('\n').length,
    language: 'typescript',
  });

  try {
    walkTsNode(tree.rootNode, {
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

  return { path: relativePath, language: 'typescript', entities, edges, evidence, errors };
}

interface TsWalkContext {
  relativePath: string;
  content: string;
  entities: ParsedEntity[];
  edges: ParsedEdge[];
  evidence: ParsedEvidence[];
  errors: string[];
}

function walkTsNode(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  switch (node.type) {
    case 'import_statement':
      handleImport(node, ctx);
      break;
    case 'class_declaration':
      handleClass(node, ctx);
      break;
    case 'function_declaration':
      handleFunction(node, ctx);
      break;
    case 'export_statement':
      handleExport(node, ctx);
      break;
    case 'lexical_declaration':
    case 'variable_declaration':
      handleVariableDeclaration(node, ctx);
      break;
    case 'interface_declaration':
      handleInterface(node, ctx);
      break;
    case 'type_alias_declaration':
      handleTypeAlias(node, ctx);
      break;
    case 'enum_declaration':
      handleEnum(node, ctx);
      break;
  }

  for (const child of node.children) {
    if (child.type !== 'class_body' && child.type !== 'statement_block') {
      walkTsNode(child, ctx);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Node Handlers
// ──────────────────────────────────────────────────────────────────────

function handleImport(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;

  const modulePath = sourceNode.text.replace(/['"]/g, '');
  const isRelative = modulePath.startsWith('.') || modulePath.startsWith('/');

  ctx.edges.push({
    source_qualified_name: ctx.relativePath,
    target_qualified_name: isRelative ? resolveRelativePath(ctx.relativePath, modulePath) : modulePath,
    edge_type: 'imports',
    weight: EDGE_WEIGHTS['imports'] ?? 0.6,
    resolution_status: 'resolved',
    line: node.startPosition.row + 1,
  });

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
      language: 'typescript',
    });
  }
}

function handleClass(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
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
    language: 'typescript',
  });

  const heritage = node.childForFieldName('superclass')
    ?? findChild(node, 'class_heritage');
  if (heritage) {
    const parentName = heritage.text.replace('extends ', '').trim().split(/\s+/)[0]!;
    ctx.edges.push({
      source_qualified_name: qualifiedName,
      target_qualified_name: parentName,
      edge_type: 'extends',
      weight: EDGE_WEIGHTS['extends'] ?? 0.9,
      resolution_status: 'ambiguous',
      line: heritage.startPosition.row + 1,
    });
  }

  // Check for implements
  for (const child of node.children) {
    if (child.type === 'implements_clause') {
      for (const typeNode of child.namedChildren) {
        ctx.edges.push({
          source_qualified_name: qualifiedName,
          target_qualified_name: typeNode.text,
          edge_type: 'implements',
          weight: EDGE_WEIGHTS['implements'] ?? 0.8,
          resolution_status: 'ambiguous',
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  extractDocEvidence(node, ctx);

  const body = node.childForFieldName('body');
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === 'method_definition' || member.type === 'public_field_definition') {
        handleMethod(member, ctx, qualifiedName);
      }
    }
  }
}

function handleFunction(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text;
  const qualifiedName = `${ctx.relativePath}:${funcName}`;

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
    language: 'typescript',
    signature,
  });

  extractDocEvidence(node, ctx);
}

function handleMethod(
  node: Parser.SyntaxNode,
  ctx: TsWalkContext,
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
    language: 'typescript',
    metadata: { is_method: true, class: classQualifiedName },
  });
}

function handleExport(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  for (const child of node.namedChildren) {
    walkTsNode(child, ctx);
  }
}

function handleVariableDeclaration(
  node: Parser.SyntaxNode,
  ctx: TsWalkContext,
): void {
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
              resolution_status: 'resolved',
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

function handleInterface(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const qualifiedName = `${ctx.relativePath}:${name}`;

  ctx.entities.push({
    entity_type: 'interface',
    scope: 'symbol',
    qualified_name: qualifiedName,
    display_name: name,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'typescript',
  });

  // Handle extends for interfaces
  for (const child of node.children) {
    if (child.type === 'extends_type_clause') {
      for (const typeNode of child.namedChildren) {
        ctx.edges.push({
          source_qualified_name: qualifiedName,
          target_qualified_name: typeNode.text,
          edge_type: 'extends',
          weight: EDGE_WEIGHTS['extends'] ?? 0.9,
          resolution_status: 'ambiguous',
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  extractDocEvidence(node, ctx);
}

function handleTypeAlias(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;

  ctx.entities.push({
    entity_type: 'interface',
    scope: 'symbol',
    qualified_name: `${ctx.relativePath}:${name}`,
    display_name: name,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'typescript',
    metadata: { is_type_alias: true },
  });

  extractDocEvidence(node, ctx);
}

function handleEnum(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;

  ctx.entities.push({
    entity_type: 'class',
    scope: 'symbol',
    qualified_name: `${ctx.relativePath}:${name}`,
    display_name: name,
    path: ctx.relativePath,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    language: 'typescript',
    metadata: { is_enum: true },
  });

  extractDocEvidence(node, ctx);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
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

function extractDocEvidence(node: Parser.SyntaxNode, ctx: TsWalkContext): void {
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
