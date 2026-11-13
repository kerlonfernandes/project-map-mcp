# Ondbay MCP — Handoff de Desenvolvimento

**Data:** 2026-11-13  
**Documento base:** [Especificação Técnica v4.0](./especificacao-tecnica-v4.md)

---

## O Que é Este Projeto

O **Ondbay Project Intelligence MCP** e um servidor Model Context Protocol que mantém memória técnica persistente e verificável de projetos de software. Ele indexa repositórios via Tree-sitter (PHP e JavaScript), rastreia relacionamentos entre componentes, armazena conhecimento com evidências rastreáveis, e entrega contexto progressivo a clientes de IA — tudo sem executar código do projeto nem chamar LLMs.

A especificação completa está em `docs/especificacao-tecnica-v4.md`. As regras de desenvolvimento estão em `CLAUDE.md` na raiz do projeto.

---

## Arquitetura

```
Entry Points (adapter/server.ts, cli/index.ts)
  ↓
Application Services (services/)
  ↓
Domain Services (domain/)
  ↓
Repository Layer (repository/)
  ↓
SQLite + FTS5
```

**Stack:** TypeScript strict + better-sqlite3 + Tree-sitter + MCP SDK + Zod + fast-glob

---

## Estado Atual — PROJETO COMPLETO

### Fase 1 — Foundation (100% COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Projeto TypeScript + tooling | `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | Completo |
| Regras de desenvolvimento | `CLAUDE.md` | Completo |
| Types e Constants | `src/shared/types.ts`, `constants.ts`, `errors.ts`, `utils.ts`, `schemas.ts` | Completo |
| Schema SQLite + migrations | `migrations/001_initial.sql`, `002_work_sessions.sql`, `003_conventions_unique.sql`, `src/repository/db.ts` | Completo |
| Repository Layer completo | `src/repository/{entities,evidence,knowledge,graph,snapshots,projects,cache,audit,sessions}.ts` | Completo |
| PHP Parser (Tree-sitter) | `src/analyzer/parsers/php.ts` | Completo |
| JavaScript Parser (Tree-sitter) | `src/analyzer/parsers/javascript.ts` | Completo |
| MCP Server com 7 tools | `src/adapter/server.ts`, `src/adapter/tools/*.ts` | Completo |
| Application Services | `src/services/{sync,search,context,graph,impact,record,session}.ts` | Completo |
| CLI (init, sync, status, search) | `src/cli/index.ts`, `src/cli/config.ts` | Completo |
| Entry point principal | `src/index.ts` | Completo |
| Testes unitários | `test/unit/**/*.test.ts` | Completo |

### Fase 2 — Intelligence (100% COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Laravel Adapter | `src/analyzer/frameworks/laravel.ts` | **COMPLETO** — Routes, Eloquent models + relationships, migrations, events, listeners, jobs, middleware, Blade views, commands, config, factories, seeders |
| Express Adapter | `src/analyzer/frameworks/express.ts` | **COMPLETO** — Routes (app/router), middleware, router mounts, error handlers |
| Integração dos adapters no pipeline | `src/analyzer/core.ts` | **COMPLETO** — Detecta framework via config e aplica adapter após parser base |
| Knowledge Manager (duplicate detection) | `src/domain/knowledge.ts` | **COMPLETO** — FTS5 similarity, entity overlap, type match, Jaccard scoring, conflict detection, audit logging |
| Integração com record service | `src/services/record.ts` | **COMPLETO** — Duplicate check antes de insert, reject/dispute/link actions |
| Context Delivery (gaps, conventions, truncation) | `src/services/context.ts` | **COMPLETO** — Gap detection, investigation plans, conventions, token budget por purpose weights, truncated_categories no meta, session cache integration |
| Staleness propagation | `src/services/sync.ts` | **COMPLETO** — Propagação via evidence hash comparison + BFS por incoming edges com max_depth |
| Testes de integração Phase 2 | `test/integration/pipeline.test.ts` | **COMPLETO** — 30+ testes: sync→search→context, duplicate detection, staleness, adapters, session cache, conventions, search scopes |

### Fase 2.5 — Session Continuity (100% COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Schema `work_sessions` + `work_session_checkpoints` | `migrations/002_work_sessions.sql` | **COMPLETO** |
| Repository Layer | `src/repository/sessions.ts` | **COMPLETO** — CRUD completo |
| Application Service | `src/services/session.ts` | **COMPLETO** |
| Tool Handler | `src/adapter/tools/session.ts` | **COMPLETO** |
| Types + Error + Schema | `src/shared/types.ts`, `errors.ts`, `schemas.ts` | **COMPLETO** |
| Testes unitários | `test/unit/repository/sessions.test.ts`, `test/unit/services/session.test.ts` | **COMPLETO** |

### Fase 3 — Advanced (100% COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| MySQL Analyzer (migration SQL parsing) | `src/analyzer/mysql.ts` | **COMPLETO** — CREATE TABLE, ALTER TABLE, foreign keys, indices, columns. Live MySQL via information_schema (optional, mysql2). |
| MySQL Analyzer integração com sync | `src/services/sync.ts` (runSchemaAnalysis) | **COMPLETO** — action 'analyze_schema' processa migrations + conexão live |
| Convention Detector | `src/domain/conventions.ts` | **COMPLETO** — Naming, structure, pattern, testing. Threshold ≥3 OR 60% (min 2). Upsert. |
| Convention Detector migration | `migrations/003_conventions_unique.sql` | **COMPLETO** |
| Session cache com delta responses | `src/services/context.ts` + `src/repository/cache.ts` | **COMPLETO** — Cache por session_id + cacheKey, invalidação por snapshot, delta responses |
| Reconciliação periódica | `src/domain/reconciliation.ts` | **COMPLETO** — Orphan entities, broken edges, expired cache, stale knowledge. Runs every N snapshots. |
| Performance tuning | `test/performance/benchmarks.test.ts` | **COMPLETO** — get_context <500ms, search <200ms, cache hit <100ms |
| Testes E2E | `test/e2e/real-projects.test.ts` | **COMPLETO** — Laravel + Express fixture projects com full pipeline |
| Testes MySQL Analyzer | `test/unit/analyzer/mysql.test.ts` | **COMPLETO** — 12 testes: parse SQL, security validation |
| Testes Reconciliation | `test/unit/domain/reconciliation.test.ts` | **COMPLETO** — 7 testes: cleanup, interval check |
| README e API docs | `README.md` | **COMPLETO** — Bilíngue EN/PT, guia de instalação, configuração, setup Claude |

---

## Resumo de Testes

| Suite | Testes | Status |
|---|---|---|
| Unit: repository/ | ~40 | Passando |
| Unit: services/ | ~35 | Passando |
| Unit: domain/ | ~23 | Passando |
| Unit: analyzer/ | ~30 | Passando |
| Integration: pipeline | ~30 | Passando |
| Performance: benchmarks | 5 | Passando |
| E2E: real-projects | 13 | Passando |
| **Total** | **180** | **Todos passando** |

---

## Como Rodar

```bash
# Instalar dependências
npm install --legacy-peer-deps

# Compilar TypeScript
npx tsc

# Rodar testes (180 passando)
npx vitest run

# Inicializar projeto para análise
node dist/cli/index.js init

# Sync completo
node dist/cli/index.js sync --full

# Iniciar MCP server (via STDIO)
ONDBAY_PROJECT_ROOT=/path/to/project node dist/index.js
```

---

## Detalhes Técnicos Importantes

### Tree-sitter PHP
- O `tree-sitter-php` exporta a linguagem sob `.php`: `(PhpLanguage as {php: Parser.Language}).php ?? PhpLanguage`
- Requer `--legacy-peer-deps` por conflito de versão com `tree-sitter@0.25.1`

### Framework Detection
- Adapters são ativados pela config `analysis.frameworks` (default: `['laravel', 'express']`)
- O adapter roda DEPOIS do parser base e enriquece o resultado com entidades/edges extras
- Não reprocessa o AST — usa regex no source para padrões framework-specific

### Duplicate Detection
- Usa Jaccard similarity (word sets) + FTS5 ranking
- Threshold de rejeição: 0.75, threshold de conflito: 0.50
- Integrado no `services/record.ts` — roda antes de cada `create`

### Staleness Propagation
- Compara `content_hash` das evidências entre snapshots
- BFS reverso pelos incoming edges até `staleness_max_depth` (default: 3)
- Edges com weight < 0.5 não propagam

### MySQL Analyzer
- **Fonte 1:** Parse de arquivos SQL de migration (CREATE TABLE, ALTER TABLE, FOREIGN KEY, INDEX)
- **Fonte 2:** Conexão live MySQL via information_schema (opcional, requer mysql2)
- Entidades: table, column, index, foreign_key
- Edges: foreign_key_to, migrates
- Segurança: read-only, allowed_hosts, blocked_schemas

### Convention Detector
- Categorias: naming, structure, pattern, testing
- Threshold: ≥3 occurrences OR 60% ratio (mínimo 2 occurrences)
- Confiança: occurrences/total_files, clamped [0.1, 1.0]
- Upsert via unique index on (repository_id, category, description)

### Session Cache
- Cache key: `context:{target}:{depth}:{purpose}:{budget}`
- Invalidação automática quando snapshot muda
- Isolamento por session_id
- TTL configurável (default: 60 min)

### Reconciliation
- Executa a cada N snapshots (config: `sync.reconciliation_interval`, default: 10)
- Remove entidades órfãs, edges quebrados, cache expirado
- Reporta knowledge stale

### Valores de Enum no Schema
- `origin`: `deterministic`, `heuristic`, `ai_generated`, `human_provided`
- `validation_status`: `unverified`, `supported_by_code`, `supported_by_tests`, `human_confirmed`, `disputed`, `superseded`, `invalidated`
- `validity`: `current`, `needs_review`, `stale`, `archived`

---

## Arquivos-Chave para Referência

| O quê | Onde |
|---|---|
| Especificação completa | `docs/especificacao-tecnica-v4.md` |
| Regras de desenvolvimento | `CLAUDE.md` |
| Tipos e interfaces | `src/shared/types.ts` |
| Constantes e pesos | `src/shared/constants.ts` |
| Schema SQLite | `migrations/001_initial.sql` |
| Config example | `ondbay.config.example.json` |
| Entry point MCP | `src/index.ts` |
| Entry point CLI | `src/cli/index.ts` |
| README completo | `README.md` |
