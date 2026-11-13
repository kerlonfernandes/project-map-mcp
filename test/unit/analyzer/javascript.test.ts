/**
 * Tests for the JavaScript parser — entity and relationship extraction.
 */

import { describe, it, expect } from 'vitest';
import { parseJavaScriptFile } from '../../../src/analyzer/parsers/javascript.js';

describe('JavaScript Parser', () => {
  it('should extract a file entity', () => {
    const result = parseJavaScriptFile('src/index.js', 'const x = 1;\n');
    expect(result.entities.some((e) => e.entity_type === 'file')).toBe(true);
  });

  it('should extract a class', () => {
    const code = `
class UserService {
  constructor(db) {
    this.db = db;
  }

  findAll() {
    return this.db.query('SELECT * FROM users');
  }
}
`;
    const result = parseJavaScriptFile('src/services/UserService.js', code);

    const classEntity = result.entities.find((e) => e.entity_type === 'class');
    expect(classEntity).toBeDefined();
    expect(classEntity!.display_name).toBe('UserService');
  });

  it('should extract methods from a class', () => {
    const code = `
class UserService {
  findAll() {}
  create(data) {}
}
`;
    const result = parseJavaScriptFile('src/UserService.js', code);

    const methods = result.entities.filter(
      (e) => e.entity_type === 'function' && e.metadata?.is_method,
    );
    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.map((m) => m.display_name)).toContain('findAll');
    expect(methods.map((m) => m.display_name)).toContain('create');
  });

  it('should extract a function declaration', () => {
    const code = `
function calculateTotal(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}
`;
    const result = parseJavaScriptFile('src/utils.js', code);

    const func = result.entities.find(
      (e) => e.entity_type === 'function' && e.display_name === 'calculateTotal',
    );
    expect(func).toBeDefined();
    expect(func!.signature).toContain('calculateTotal');
  });

  it('should detect ES6 import edges', () => {
    const code = `
import express from 'express';
import { Router } from './router';
`;
    const result = parseJavaScriptFile('src/app.js', code);

    const importEdges = result.edges.filter((e) => e.edge_type === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(2);

    const expressImport = importEdges.find((e) => e.target_qualified_name === 'express');
    expect(expressImport).toBeDefined();
  });

  it('should create package entities for npm imports', () => {
    const code = `import express from 'express';`;
    const result = parseJavaScriptFile('src/app.js', code);

    const pkg = result.entities.find(
      (e) => e.entity_type === 'package' && e.display_name === 'express',
    );
    expect(pkg).toBeDefined();
    expect(pkg!.qualified_name).toBe('npm:express');
  });

  it('should detect extends edge', () => {
    const code = `
class AdminController extends BaseController {
  index() {}
}
`;
    const result = parseJavaScriptFile('src/AdminController.js', code);

    const extendsEdge = result.edges.find((e) => e.edge_type === 'extends');
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.target_qualified_name).toContain('BaseController');
  });

  it('should resolve relative import paths', () => {
    const code = `import { helper } from '../utils/helper';`;
    const result = parseJavaScriptFile('src/controllers/main.js', code);

    const importEdge = result.edges.find(
      (e) => e.edge_type === 'imports' && e.target_qualified_name.includes('utils/helper'),
    );
    expect(importEdge).toBeDefined();
  });

  it('should handle empty files gracefully', () => {
    const result = parseJavaScriptFile('empty.js', '');
    expect(result.errors.length).toBe(0);
    expect(result.entities.length).toBe(1); // just the file entity
  });

  it('should report language as javascript', () => {
    const result = parseJavaScriptFile('test.js', 'const a = 1;');
    expect(result.language).toBe('javascript');
  });

  it('should handle scoped npm packages', () => {
    const code = `import sdk from '@modelcontextprotocol/sdk';`;
    const result = parseJavaScriptFile('src/mcp.js', code);

    const pkg = result.entities.find(
      (e) => e.entity_type === 'package' && e.qualified_name === 'npm:@modelcontextprotocol/sdk',
    );
    expect(pkg).toBeDefined();
  });
});
