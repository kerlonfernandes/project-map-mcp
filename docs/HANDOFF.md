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

## Estado Atual — O Que Já Foi Implementado

### Fase 1 — Foundation (100% COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Projeto TypeScript + tooling | `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | Completo |
| Regras de desenvolvimento | `CLAUDE.md` | Completo |
| Types e Constants | `src/shared/types.ts`, `constants.ts`, `errors.ts`, `utils.ts`, `schemas.ts` | Completo |
| Schema SQLite + migrations | `migrations/001_initial.sql`, `src/repository/db.ts` | Completo |
| Repository Layer completo | `src/repository/{entities,evidence,knowledge,graph,snapshots,projects,cache,audit}.ts` | Completo |
| PHP Parser (Tree-sitter) | `src/analyzer/parsers/php.ts` | Completo |
| JavaScript Parser (Tree-sitter) | `src/analyzer/parsers/javascript.ts` | Completo |
| MCP Server com 7 tools | `src/adapter/server.ts`, `src/adapter/tools/*.ts` | Completo |
| Application Services | `src/services/{sync,search,context,graph,impact,record}.ts` | Completo |
| CLI (init, sync, status, search) | `src/cli/index.ts`, `src/cli/config.ts` | Completo |
| Entry point principal | `src/index.ts` | Completo |
| Testes unitários (108 tests) | `test/unit/**/*.test.ts` | Completo |

### Fase 2 — Intelligence (EM ANDAMENTO — ~80%)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Laravel Adapter | `src/analyzer/frameworks/laravel.ts` | **COMPLETO** — Routes, Eloquent models + relationships, migrations, events, listeners, jobs, middleware, Blade views, commands, config, factories, seeders |
| Express Adapter | `src/analyzer/frameworks/express.ts` | **COMPLETO** — Routes (app/router), middleware, router mounts, error handlers |
| Integração dos adapters no pipeline | `src/analyzer/core.ts` | **COMPLETO** — Detecta framework via config e aplica adapter após parser base |
| Knowledge Manager (duplicate detection) | `src/domain/knowledge.ts` | **COMPLETO** — FTS5 similarity, entity overlap, type match, Jaccard scoring, conflict detection, audit logging |
| Integração com record service | `src/services/record.ts` | **COMPLETO** — Duplicate check antes de insert, reject/dispute/link actions |
| Context Delivery (gaps, conventions, truncation) | `src/services/context.ts` | **COMPLETO** — Gap detection, investigation plans, conventions, token budget por purpose weights, truncated_categories no meta |
| Staleness propagation | `src/services/sync.ts` | **COMPLETO** — Propagação via evidence hash comparison + BFS por incoming edges com max_depth |
| **Testes de integração Phase 2** | — | **PENDENTE** |

### Fase 2.5 — Session Continuity (COMPLETA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| Schema `work_sessions` + `work_session_checkpoints` | `migrations/002_work_sessions.sql` | **COMPLETO** — Tabelas com índices + expansão do audit_log CHECK constraint |
| Repository Layer | `src/repository/sessions.ts` | **COMPLETO** — CRUD completo: create, update, find, list, close, checkpoints |
| Application Service | `src/services/session.ts` | **COMPLETO** — checkpoint (create/update), resume, list, close com audit logging |
| Tool Handler | `src/adapter/tools/session.ts` | **COMPLETO** — Delegação ao service com sanitização de input |
| Tool Registration | `src/adapter/server.ts` | **COMPLETO** — 7ª tool registrada com schema Zod e descrição |
| Types + Error + Schema | `src/shared/types.ts`, `errors.ts`, `schemas.ts` | **COMPLETO** — WorkSessionRecord, WorkSessionCheckpointRecord, SessionNotFoundError, SessionSchema |
| Testes unitários | `test/unit/repository/sessions.test.ts`, `test/unit/services/session.test.ts` | **COMPLETO** — 21 testes (8 repository + 13 service) |

**Nota:** Documentação completa da tool `session` está na spec seção 6.7. Tabelas SQL estão documentadas após `audit_log` na seção de schema.

### Fase 3 — Advanced (NÃO INICIADA)

| Componente | Arquivo(s) | Status |
|---|---|---|
| MySQL Analyzer (information_schema + migrations) | `src/analyzer/mysql.ts` | Placeholder stub |
| Model→Table correlation | — | Não iniciado |
| Convention Detector | `src/domain/conventions.ts` | Placeholder stub |
| Session cache com delta responses | `src/repository/cache.ts` (CRUD existe) | Não integrado no context delivery |
| Investigation plans (debug purpose) | `src/services/context.ts` | Estrutura existe, precisa polir |
| Reconciliação periódica | — | Não iniciado |
| Performance tuning | — | Não iniciado |
| Documentação (README, API reference) | — | Não iniciado |
| Testes E2E | — | Não iniciado |

---

## O Que Falta Para a Primeira Release Completa

### Prioridade Alta (bloqueiam release)

1. **Testes de integração Phase 2** — Testar fluxos completos: sync→search→context, Laravel adapter detection, Express adapter detection, duplicate detection, staleness propagation. Target: ≥70% cobertura.

2. **MySQL Analyzer** (`src/analyzer/mysql.ts`) — Implementar conforme spec seção 9:
   - Conexão read-only via `information_schema` (tabelas, colunas, FKs, índices)
   - Parser de migrations SQL (`CREATE TABLE`, `ALTER TABLE`, etc.)
   - Entidades: `table`, `column`, `index`, `foreign_key`
   - Edges: `foreign_key_to`, `migrates`
   - Correlação Model→Table com Laravel adapter

3. **Convention Detector** (`src/domain/conventions.ts`) — Implementar conforme spec seção 9:
   - Categorias: naming, structure, pattern, config, testing, documentation
   - Threshold: ≥3 ocorrências ou 60% dos arquivos do mesmo tipo
   - Confiança proporcional ao número de ocorrências
   - Persistir na tabela `conventions` (já existe no schema)

4. **Session Cache com delta responses** — Integrar `src/repository/cache.ts` no context delivery:
   - Primeira chamada cacheia resultado
   - Chamadas subsequentes com mesmo session_id retornam apenas delta
   - Invalidar cache quando snapshot muda

### Prioridade Média

5. **Reconciliação periódica** — A cada N snapshots (config: `sync.reconciliation_interval`, default 10):
   - Detectar entidades órfãs
   - Verificar consistência dos edges
   - Limpar session_cache expirado
   - Atualizar occurrences das convenções

6. **Performance tuning** — Validar metas da spec:
   - Full sync (1000 arquivos): < 2 min
   - Incremental sync (10 arquivos): < 5s
   - get_context (cache hit): < 500ms
   - search: < 200ms
   - RSS: < 256 MB

7. **Testes E2E** — Com projetos reais Laravel + Express

### Prioridade Baixa

8. **README.md e API reference** — Documentação para novos desenvolvedores (meta: setup em <15 min)

9. **Segurança completa** — Revisar checklist:
   - [x] Todas SQL usa prepared statements
   - [x] Paths validados via `validatePath()`
   - [x] Rate limiting no MCP server
   - [x] Audit log implementado
   - [x] Blocked paths configuráveis
   - [ ] Testes de segurança automatizados

---

## Como Rodar

```bash
# Instalar dependências
npm install --legacy-peer-deps

# Compilar TypeScript
npx tsc

# Rodar testes (108 passando)
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
