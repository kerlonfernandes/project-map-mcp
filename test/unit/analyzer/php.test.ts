/**
 * Tests for the PHP parser — entity and relationship extraction.
 */

import { describe, it, expect } from 'vitest';
import { parsePhpFile } from '../../../src/analyzer/parsers/php.js';

describe('PHP Parser', () => {
  it('should extract a file entity', () => {
    const result = parsePhpFile('app/User.php', '<?php\nclass User {}\n');
    expect(result.entities.some((e) => e.entity_type === 'file')).toBe(true);
  });

  it('should extract a class', () => {
    const code = `<?php
namespace App\\Models;

class User {
  public function getName(): string {
    return $this->name;
  }
}
`;
    const result = parsePhpFile('app/Models/User.php', code);

    const classEntity = result.entities.find((e) => e.entity_type === 'class');
    expect(classEntity).toBeDefined();
    expect(classEntity!.display_name).toBe('User');
    expect(classEntity!.qualified_name).toBe('App\\Models\\User');
  });

  it('should extract methods', () => {
    const code = `<?php
namespace App\\Models;

class User {
  public function getName(): string {
    return $this->name;
  }

  private function validate(): bool {
    return true;
  }
}
`;
    const result = parsePhpFile('app/Models/User.php', code);

    const methods = result.entities.filter(
      (e) => e.entity_type === 'function' && e.metadata?.is_method,
    );
    expect(methods.length).toBe(2);
    expect(methods.map((m) => m.display_name)).toContain('getName');
    expect(methods.map((m) => m.display_name)).toContain('validate');
  });

  it('should detect extends edge', () => {
    const code = `<?php
namespace App\\Models;

class User extends Model {
}
`;
    const result = parsePhpFile('app/Models/User.php', code);

    const extendsEdge = result.edges.find((e) => e.edge_type === 'extends');
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.source_qualified_name).toBe('App\\Models\\User');
    expect(extendsEdge!.target_qualified_name).toContain('Model');
  });

  it('should detect use/import edges', () => {
    const code = `<?php
namespace App\\Controllers;

use App\\Models\\User;
use App\\Services\\AuthService;

class UserController {
}
`;
    const result = parsePhpFile('app/Controllers/UserController.php', code);

    const importEdges = result.edges.filter((e) => e.edge_type === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(2);
    expect(importEdges.map((e) => e.target_qualified_name)).toContain('App\\Models\\User');
    expect(importEdges.map((e) => e.target_qualified_name)).toContain('App\\Services\\AuthService');
  });

  it('should extract an interface', () => {
    const code = `<?php
namespace App\\Contracts;

interface Authenticatable {
  public function getAuthIdentifier(): string;
}
`;
    const result = parsePhpFile('app/Contracts/Authenticatable.php', code);

    const iface = result.entities.find((e) => e.entity_type === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.display_name).toBe('Authenticatable');
  });

  it('should extract a trait', () => {
    const code = `<?php
namespace App\\Traits;

trait HasTimestamps {
  public function getCreatedAt(): string {
    return $this->created_at;
  }
}
`;
    const result = parsePhpFile('app/Traits/HasTimestamps.php', code);

    const trait = result.entities.find((e) => e.entity_type === 'trait');
    expect(trait).toBeDefined();
    expect(trait!.display_name).toBe('HasTimestamps');
  });

  it('should detect implements edge', () => {
    const code = `<?php
namespace App\\Models;

class User extends Model implements Authenticatable, HasRoles {
}
`;
    const result = parsePhpFile('app/Models/User.php', code);

    const implEdges = result.edges.filter((e) => e.edge_type === 'implements');
    expect(implEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract global functions', () => {
    const code = `<?php
function helper_format_date(string $date): string {
  return date('Y-m-d', strtotime($date));
}
`;
    const result = parsePhpFile('app/helpers.php', code);

    const func = result.entities.find(
      (e) => e.entity_type === 'function' && e.display_name === 'helper_format_date',
    );
    expect(func).toBeDefined();
  });

  it('should handle empty files gracefully', () => {
    const result = parsePhpFile('empty.php', '<?php\n');
    expect(result.errors.length).toBe(0);
    expect(result.entities.length).toBe(1); // just the file entity
  });

  it('should handle syntax errors gracefully', () => {
    const code = `<?php
class Broken {
  function foo( {
  }
`;
    const result = parsePhpFile('broken.php', code);
    // Tree-sitter is error-tolerant — it should still extract something
    expect(result).toBeDefined();
  });

  it('should report language as php', () => {
    const result = parsePhpFile('test.php', '<?php class Foo {}');
    expect(result.language).toBe('php');
  });
});
