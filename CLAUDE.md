# Ondbay MCP — Project Rules & Development Standards

## Project Identity

**Ondbay Project Intelligence MCP** is a Model Context Protocol server that
maintains persistent, verifiable, shared technical memory for software projects.
It indexes repository structure, tracks component relationships, stores knowledge
with traceable evidence, and delivers progressive context to AI clients — all
without executing project code or calling LLMs.

## Architecture Principles

1. **KISS — Keep It Stupid Simple.** Prefer the obvious solution. If a junior
   developer can't read it in 30 seconds, simplify.
2. **Clean Code.** Functions do one thing. Names reveal intent. No side effects
   hidden behind getters.
3. **Clean Architecture.** Dependencies point inward. Domain knows nothing about
   infrastructure. Entry points are thin wrappers.
4. **Evidence First.** Every assertion about the analyzed project traces back to
   a source. Unverified claims are explicitly marked.
5. **Deterministic Core.** Parsing and indexing use Tree-sitter AST, never LLM
   inference. Same input → same output.
6. **Security by Default.** All repository content is untrusted data. Path
   traversal, symlinks, and injection are blocked before any processing.

## Layer Boundaries

```
Entry Points (adapter/, cli/)
  ↓ calls
Application Services (services/)
  ↓ calls
Domain Services (domain/)
  ↓ calls
Repository Layer (repository/)
  ↓ uses
SQLite + FTS5
```

- **Entry Points** convert protocol ↔ internal calls. Zero business logic.
- **Application Services** orchestrate use cases. No direct SQL.
- **Domain Services** own knowledge rules (validation, dedup, versioning).
- **Repository Layer** is the only layer that touches SQLite.
- **Code Analysis** (analyzer/) returns structured results, never persists.

## Coding Standards

### TypeScript

- **Strict mode always.** `strict: true` in tsconfig, no `any` without a
  comment explaining why.
- **Consistent type imports.** Use `import type { Foo }` for type-only imports.
- **Named exports only.** No `export default` — it makes refactoring harder.
- **No classes unless state is needed.** Prefer plain functions and objects.
  Classes only for genuine stateful services (Database, McpServer).
- **Error handling:** throw typed errors from `shared/errors.ts`. Never
  `throw new Error('something')` — always use the project error classes.
- **No magic numbers.** Use constants from `shared/constants.ts`.

### Naming

| Thing            | Convention          | Example                      |
|------------------|---------------------|------------------------------|
| Files            | kebab-case          | `knowledge-manager.ts`       |
| Interfaces/Types | PascalCase          | `KnowledgeRecord`            |
| Functions        | camelCase           | `findByQualifiedName`        |
| Constants        | UPPER_SNAKE_CASE    | `MAX_FILE_SIZE_BYTES`        |
| Database tables  | snake_case          | `knowledge_evidence`         |
| Enum-like unions | snake_case strings  | `'business_rule'`            |

### Comments

- **Every file** starts with a JSDoc block: one line saying what it does, who
  uses it, and why it exists.
- **Every exported function** has a JSDoc: what it does, params, return, throws.
- **Inline comments** explain WHY, never WHAT. If the code needs a WHAT
  comment, rename the variable or extract a function.
- **Security-sensitive code** gets a `// SECURITY:` prefix explaining the
  threat being mitigated.

### SQL

- Always use prepared statements with `?` placeholders. Never interpolate.
- Wrap multi-table writes in transactions.
- Index names follow: `idx_{table}_{column(s)}`.

### Testing

- Test files live in `test/` mirroring `src/` structure.
- Unit tests: pure functions, no I/O mocking where possible.
- Integration tests: use in-memory SQLite (`:memory:`).
- Name pattern: `describe('ModuleName')` → `it('should do X when Y')`.

## Git & Workflow

- Commit messages: imperative mood, max 72 chars first line.
- One logical change per commit.
- No secrets in commits — ever.

## Security Checklist (for every PR)

- [ ] No `eval()`, `Function()`, or `child_process.exec()` with user input
- [ ] All SQL uses prepared statements
- [ ] All file paths validated through `validatePath()`
- [ ] No credentials persisted in SQLite
- [ ] File size checked before reading into memory
- [ ] Multi-table writes wrapped in transactions
- [ ] Errors returned to client are generic; details in logs only

## Performance Targets

| Metric                              | Target       |
|-------------------------------------|--------------|
| Full sync (1000 files)              | < 2 minutes  |
| Incremental sync (10 files)         | < 5 seconds  |
| `get_context` (cache hit)           | < 500ms      |
| `get_context` (cache miss)          | < 2 seconds  |
| `search`                            | < 200ms      |
| SQLite size (1000 files)            | < 50 MB      |
| Process RSS                         | < 256 MB     |
