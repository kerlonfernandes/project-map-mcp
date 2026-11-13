/**
 * Tests for shared utility functions.
 * Covers: ID generation, hashing, path security, sanitization, language detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  generateId,
  sha256,
  hashParams,
  validatePath,
  isBlockedPath,
  sanitizeInput,
  isValidPathChars,
  detectLanguage,
  isParseableFile,
  estimateTokens,
  nowISO,
  isBinaryFile,
} from '../../../src/shared/utils.js';

import {
  PathTraversalError,
  BlockedPathError,
} from '../../../src/shared/errors.js';

describe('generateId', () => {
  it('should produce prefixed IDs', () => {
    const id = generateId('e');
    expect(id).toMatch(/^e-[a-f0-9]{12}$/);
  });

  it('should produce unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('k')));
    expect(ids.size).toBe(100);
  });
});

describe('sha256', () => {
  it('should produce consistent hex hashes', () => {
    const hash = sha256('hello world');
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should produce different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

describe('hashParams', () => {
  it('should produce a 16-char hex string', () => {
    const h = hashParams({ action: 'full' });
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('validatePath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-map-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should accept paths within the project root', () => {
    const testFile = path.join(tmpDir, 'test.php');
    fs.writeFileSync(testFile, '<?php');
    const result = validatePath('test.php', tmpDir);
    expect(result).toBe(testFile);
  });

  it('should reject path traversal attempts', () => {
    expect(() => validatePath('../../../etc/passwd', tmpDir)).toThrow(PathTraversalError);
  });

  it('should reject paths with ..', () => {
    expect(() => validatePath('foo/../../etc/passwd', tmpDir)).toThrow(PathTraversalError);
  });

  it('should reject blocked paths', () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=123');
    expect(() => validatePath('.env', tmpDir)).toThrow(BlockedPathError);
  });

  it('should reject .pem files', () => {
    expect(() => validatePath('server.pem', tmpDir)).toThrow(BlockedPathError);
  });
});

describe('isBlockedPath', () => {
  it('should match .env files', () => {
    expect(isBlockedPath('/project/.env', '/project')).toBe(true);
    expect(isBlockedPath('/project/.env.local', '/project')).toBe(true);
  });

  it('should match .pem files', () => {
    expect(isBlockedPath('/project/certs/server.pem', '/project')).toBe(true);
  });

  it('should not block regular PHP files', () => {
    expect(isBlockedPath('/project/app/User.php', '/project')).toBe(false);
  });
});

describe('sanitizeInput', () => {
  it('should strip control characters', () => {
    expect(sanitizeInput('hello\x00world')).toBe('helloworld');
  });

  it('should trim whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });

  it('should normalize Unicode', () => {
    const result = sanitizeInput('café');
    expect(result).toBe('café');
  });
});

describe('isValidPathChars', () => {
  it('should accept normal paths', () => {
    expect(isValidPathChars('src/controllers/UserController.php')).toBe(true);
  });

  it('should reject shell characters', () => {
    expect(isValidPathChars('file; rm -rf /')).toBe(false);
    expect(isValidPathChars('file$(cmd)')).toBe(false);
  });
});

describe('detectLanguage', () => {
  it('should detect PHP', () => {
    expect(detectLanguage('app/User.php')).toBe('php');
  });

  it('should detect JavaScript', () => {
    expect(detectLanguage('src/index.js')).toBe('javascript');
    expect(detectLanguage('src/app.mjs')).toBe('javascript');
  });

  it('should detect SQL', () => {
    expect(detectLanguage('migrations/001.sql')).toBe('sql');
  });

  it('should detect Python', () => {
    expect(detectLanguage('file.py')).toBe('python');
    expect(detectLanguage('file.pyw')).toBe('python');
  });

  it('should detect CSS and HTML', () => {
    expect(detectLanguage('style.css')).toBe('css');
    expect(detectLanguage('style.scss')).toBe('css');
    expect(detectLanguage('page.html')).toBe('html');
  });

  it('should return null for unknown', () => {
    expect(detectLanguage('file.rs')).toBeNull();
    expect(detectLanguage('file.go')).toBeNull();
  });
});

describe('isParseableFile', () => {
  it('should return true for PHP, JS, Python, CSS, and HTML', () => {
    expect(isParseableFile('file.php')).toBe(true);
    expect(isParseableFile('file.js')).toBe(true);
    expect(isParseableFile('file.py')).toBe(true);
    expect(isParseableFile('style.css')).toBe(true);
    expect(isParseableFile('page.html')).toBe(true);
  });

  it('should return false for other files', () => {
    expect(isParseableFile('file.sql')).toBe(false);
    expect(isParseableFile('file.rs')).toBe(false);
  });

  it('should return false for minified files', () => {
    expect(isParseableFile('app.min.js')).toBe(false);
    expect(isParseableFile('style.min.css')).toBe(false);
    expect(isParseableFile('bundle.bundle.js')).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('should estimate roughly 1 token per 4 characters', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});

describe('nowISO', () => {
  it('should return a valid ISO string', () => {
    const iso = nowISO();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('isBinaryFile', () => {
  it('should detect binary extensions', () => {
    expect(isBinaryFile('image.png')).toBe(true);
    expect(isBinaryFile('archive.zip')).toBe(true);
  });

  it('should not flag text files', () => {
    expect(isBinaryFile('code.php')).toBe(false);
    expect(isBinaryFile('code.js')).toBe(false);
  });
});
