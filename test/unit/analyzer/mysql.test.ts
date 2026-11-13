/**
 * Tests for the MySQL Schema Analyzer — migration SQL parsing.
 *
 * Live MySQL connection tests are skipped since mysql2 is optional.
 */

import { describe, it, expect } from 'vitest';
import { parseMigrationSql, analyzeSchema } from '../../../src/analyzer/mysql.js';
import type { ProjectMapConfig } from '../../../src/shared/types.js';

const DISABLED_CONFIG: ProjectMapConfig = {
  project: { name: 'test', root: '/tmp/test' },
  analysis: { languages: ['php'], frameworks: [], exclude_patterns: [], max_file_size_mb: 2, max_directory_depth: 20, max_files_per_sync: 500, parse_timeout_ms: 30000 },
  database: { path: ':memory:', max_size_mb: 50, cache_size_mb: 8 },
  security: { blocked_paths: [], mysql: { allow_connection: false, allowed_hosts: ['localhost'], blocked_schemas: ['mysql'] }, rate_limit: { enabled: false, max_per_minute: 60 } },
  sync: { reconciliation_interval: 10, staleness_max_depth: 3 },
  context: { default_depth: 'structure', default_purpose: 'understand', default_token_budget: 2000, max_token_budget: 200000 },
};

describe('parseMigrationSql', () => {
  it('should extract table entities from CREATE TABLE', () => {
    const sql = `
CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/001_create_users.sql', sql);

    expect(result.errors).toHaveLength(0);

    const fileEntity = result.entities.find((e) => e.entity_type === 'file');
    expect(fileEntity).toBeDefined();
    expect(fileEntity!.qualified_name).toBe('migrations/001_create_users.sql');

    const tableEntity = result.entities.find((e) => e.entity_type === 'table');
    expect(tableEntity).toBeDefined();
    expect(tableEntity!.qualified_name).toBe('table:users');
    expect(tableEntity!.display_name).toBe('users');

    const columns = result.entities.filter((e) => e.entity_type === 'column');
    expect(columns.length).toBeGreaterThanOrEqual(3);

    const nameCol = columns.find((c) => c.qualified_name === 'column:users.name');
    expect(nameCol).toBeDefined();

    const migratesEdge = result.edges.find((e) => e.edge_type === 'migrates');
    expect(migratesEdge).toBeDefined();
    expect(migratesEdge!.source_qualified_name).toBe('migrations/001_create_users.sql');
    expect(migratesEdge!.target_qualified_name).toBe('table:users');
  });

  it('should extract foreign keys from CREATE TABLE', () => {
    const sql = `
CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  total DECIMAL(10,2),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/002_create_orders.sql', sql);

    const fkEntity = result.entities.find((e) => e.entity_type === 'foreign_key');
    expect(fkEntity).toBeDefined();
    expect(fkEntity!.qualified_name).toBe('fk:orders.fk_orders_user');
    expect(fkEntity!.display_name).toContain('users');

    const fkEdge = result.edges.find((e) => e.edge_type === 'foreign_key_to');
    expect(fkEdge).toBeDefined();
    expect(fkEdge!.source_qualified_name).toBe('column:orders.user_id');
    expect(fkEdge!.target_qualified_name).toBe('table:users');
  });

  it('should extract indices from CREATE TABLE', () => {
    const sql = `
CREATE TABLE products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  sku VARCHAR(50),
  INDEX idx_products_sku (sku),
  UNIQUE INDEX idx_products_name (name)
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/003_create_products.sql', sql);

    const indices = result.entities.filter((e) => e.entity_type === 'index');
    expect(indices.length).toBe(2);

    const skuIndex = indices.find((i) => i.qualified_name === 'index:products.idx_products_sku');
    expect(skuIndex).toBeDefined();
  });

  it('should handle ALTER TABLE with ADD COLUMN', () => {
    const sql = `
ALTER TABLE users ADD COLUMN phone VARCHAR(20) AFTER email;
ALTER TABLE users ADD COLUMN address TEXT;`;

    const result = parseMigrationSql('migrations/004_add_user_fields.sql', sql);

    const columns = result.entities.filter((e) => e.entity_type === 'column');
    expect(columns.length).toBeGreaterThanOrEqual(2);

    const phoneCol = columns.find((c) => c.qualified_name === 'column:users.phone');
    expect(phoneCol).toBeDefined();

    const migratesEdges = result.edges.filter((e) => e.edge_type === 'migrates');
    expect(migratesEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle ALTER TABLE with ADD FOREIGN KEY', () => {
    const sql = `
ALTER TABLE orders ADD COLUMN product_id BIGINT UNSIGNED;
ALTER TABLE orders ADD CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id);`;

    const result = parseMigrationSql('migrations/005_add_order_product.sql', sql);

    const fkEntity = result.entities.find((e) => e.entity_type === 'foreign_key');
    expect(fkEntity).toBeDefined();

    const fkEdge = result.edges.find((e) => e.edge_type === 'foreign_key_to');
    expect(fkEdge).toBeDefined();
    expect(fkEdge!.target_qualified_name).toBe('table:products');
  });

  it('should handle multiple CREATE TABLE statements in one file', () => {
    const sql = `
CREATE TABLE categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE product_categories (
  product_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, category_id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/006_categories.sql', sql);

    const tables = result.entities.filter((e) => e.entity_type === 'table');
    expect(tables.length).toBe(2);

    const fkEdges = result.edges.filter((e) => e.edge_type === 'foreign_key_to');
    expect(fkEdges.length).toBe(2);
  });

  it('should handle CREATE TABLE IF NOT EXISTS', () => {
    const sql = `
CREATE TABLE IF NOT EXISTS settings (
  key_name VARCHAR(100) PRIMARY KEY,
  value TEXT
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/007_settings.sql', sql);

    const table = result.entities.find((e) => e.entity_type === 'table');
    expect(table).toBeDefined();
    expect(table!.qualified_name).toBe('table:settings');
  });

  it('should produce evidence for each CREATE TABLE', () => {
    const sql = `
CREATE TABLE logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message TEXT
) ENGINE=InnoDB;`;

    const result = parseMigrationSql('migrations/008_logs.sql', sql);

    const evidence = result.evidence.filter((e) => e.source_kind === 'migration');
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence[0]!.excerpt).toContain('CREATE TABLE logs');
    expect(evidence[0]!.content_hash).toBeDefined();
  });

  it('should return empty results for non-DDL SQL', () => {
    const sql = `
INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');
UPDATE users SET name = 'Bob' WHERE id = 1;
SELECT * FROM users;`;

    const result = parseMigrationSql('migrations/009_seed.sql', sql);

    const tables = result.entities.filter((e) => e.entity_type === 'table');
    expect(tables.length).toBe(0);
  });
});

describe('analyzeSchema (security validation)', () => {
  it('should reject when connection is disabled', async () => {
    const result = await analyzeSchema(
      { host: 'localhost', port: 3306, user: 'root', password: '', database: 'test' },
      DISABLED_CONFIG,
    );

    expect(result.tables_found).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('disabled');
  });

  it('should reject non-allowed host', async () => {
    const config: ProjectMapConfig = {
      ...DISABLED_CONFIG,
      security: {
        ...DISABLED_CONFIG.security,
        mysql: { allow_connection: true, allowed_hosts: ['localhost'], blocked_schemas: [] },
      },
    };

    const result = await analyzeSchema(
      { host: 'evil.example.com', port: 3306, user: 'root', password: '', database: 'test' },
      config,
    );

    expect(result.tables_found).toBe(0);
    expect(result.errors[0]).toContain('not in allowed list');
  });

  it('should reject blocked schema', async () => {
    const config: ProjectMapConfig = {
      ...DISABLED_CONFIG,
      security: {
        ...DISABLED_CONFIG.security,
        mysql: { allow_connection: true, allowed_hosts: ['localhost'], blocked_schemas: ['mysql', 'information_schema'] },
      },
    };

    const result = await analyzeSchema(
      { host: 'localhost', port: 3306, user: 'root', password: '', database: 'mysql' },
      config,
    );

    expect(result.tables_found).toBe(0);
    expect(result.errors[0]).toContain('blocked');
  });
});
