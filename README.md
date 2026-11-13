# Project Map MCP

> Persistent, verifiable, shared technical memory for software projects — powered by Tree-sitter and SQLite.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-purple.svg)](https://modelcontextprotocol.io/)

Project Map MCP is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that indexes your codebase, tracks relationships between components, stores knowledge with traceable evidence, and delivers progressive context to AI clients. It uses **Tree-sitter** for deterministic AST parsing and **SQLite + FTS5** for persistence and full-text search. It never executes your project's code and never calls external LLMs — every assertion traces back to source.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Setup with AI Clients](#setup-with-ai-clients)
  - [Automated Setup](#automated-setup-recommended)
  - [Claude Desktop](#claude-desktop-manual)
  - [Claude Code (CLI)](#claude-code-cli)
  - [Cursor](#cursor)
  - [Windsurf](#windsurf)
- [MCP Tools Reference](#mcp-tools-reference)
  - [get_context](#get_context)
  - [search](#search)
  - [graph](#graph)
  - [impact](#impact)
  - [record](#record)
  - [sync](#sync)
  - [session](#session)
  - [export](#export)
- [CLI Usage](#cli-usage)
- [Development](#development)
- [Security](#security)
- [License](#license)
- [Documentacao em Portugues](#documentacao-em-portugues)

---

## Features

### Code Analysis
- **PHP and JavaScript parsing** via Tree-sitter AST — deterministic, no heuristics for structure extraction.
- **Laravel framework detection** — routes, Eloquent models with relationships (hasMany, belongsTo, etc.), migrations, events, listeners, jobs, middleware, Blade views, commands, config, factories, and seeders.
- **Express.js framework detection** — routes (app/router), middleware, router mounts, and error handlers.
- **MySQL schema analysis** — migration SQL parsing and live `information_schema` queries (read-only).

### Knowledge Management
- **Evidence-backed knowledge records** — every assertion links to code, comments, docblocks, configs, migrations, tests, or manual entries.
- **Duplicate detection** with Jaccard similarity scoring (FTS5 + word-set overlap).
- **Validation lifecycle** — records move through `unverified` -> `supported_by_code` -> `human_confirmed` (or `disputed` / `invalidated`).
- **12 knowledge types**: `business_rule`, `architectural_decision`, `data_flow`, `api_contract`, `constraint`, `pattern`, `dependency_note`, `security_note`, `performance_note`, `todo`, `explanation`, `convention`.

### Progressive Context Delivery
- **4 depth levels**: `summary`, `structure`, `detail`, `full` — controls how much information is returned.
- **5 purpose modes**: `understand`, `implement`, `debug`, `review`, `plan` — each prioritizes different content types with weighted allocation.
- **Token budgets** — responses respect configurable token limits (default: 2,000, max: 200,000).
- **Session cache with delta responses** — repeated queries in the same session return only what changed.

### Dependency Graph
- **21 relationship types**: `imports`, `extends`, `implements`, `uses_trait`, `calls`, `instantiates`, `references`, `belongs_to`, `has_many`, `belongs_to_model`, `has_one`, `many_to_many`, `maps_to_table`, `handles_route`, `dispatches`, `listens_to`, `renders`, `migrates`, `foreign_key_to`, `depends_on`, `tests`.
- **Weighted edges** — each relationship type has a coupling weight (0.2 to 0.9) for impact analysis.
- **Staleness propagation** — when a file changes, dependent entities are marked stale through BFS traversal up to configurable depth.

### Convention Detection
- **6 categories**: `naming`, `structure`, `pattern`, `config`, `testing`, `documentation`.
- Detected when a pattern appears in at least 3 occurrences or 60% of matching files.

### Portable & Shareable Databases
- **Per-project database** — each project gets its own `.project-map/knowledge.db` with all indexed data.
- **Portable by design** — all paths are stored as relative, making the database transferable across machines.
- **Export/Import** — export a `.pmap.db` file and share it with teammates. They import it and instantly have the full project knowledge base without re-analyzing.
- **Schema compatibility** — imports validate schema version to prevent loading incompatible databases.

### Infrastructure
- **Full-text search** via SQLite FTS5 across entities, knowledge, and evidence.
- **Audit logging** — every tool call is logged with parameters, results, and duration.
- **Rate limiting** — configurable per-minute limit (default: 60 requests/min).
- **Work session continuity** — save and resume task progress across AI chat sessions.

---

## Architecture

```
Entry Points
  adapter/server.ts  — MCP server (STDIO transport)
  cli/index.ts       — Command-line interface
      |
      v
Application Services (services/)
  context.ts, search.ts, graph.ts, impact.ts, record.ts, sync.ts, session.ts
      |
      v
Domain Services (domain/)
  knowledge.ts   — Duplicate detection, Jaccard similarity
  conventions.ts — Convention detection
      |
      v
Repository Layer (repository/)
  entities.ts, evidence.ts, knowledge.ts, graph.ts, snapshots.ts,
  projects.ts, cache.ts, sessions.ts, audit.ts, db.ts
      |
      v
SQLite + FTS5 (better-sqlite3)
```

Dependencies always point inward. Entry points contain zero business logic. The repository layer is the only code that touches SQLite.

**Code Analysis** (`analyzer/`) runs as a separate pipeline:

```
analyzer/core.ts
  |-- parsers/php.ts        (Tree-sitter PHP)
  |-- parsers/javascript.ts (Tree-sitter JavaScript)
  |-- frameworks/laravel.ts (Laravel adapter)
  |-- frameworks/express.ts (Express adapter)
  |-- mysql.ts              (MySQL schema analyzer)
```

---

## Installation

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** (comes with Node.js)
- A C++ build toolchain (for native Tree-sitter bindings): `build-essential` on Debian/Ubuntu, Xcode Command Line Tools on macOS, or Visual Studio Build Tools on Windows.

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/kerlonfernandes/project-map-mcp.git
cd project-map-mcp

# 2. Install dependencies
npm install

# 3. Build the TypeScript project
npm run build

# 4. (Optional) Initialize a project for analysis
pmap init /path/to/your/project

# 5. (Optional) Run the first full sync
pmap sync --full
```

After `init`, a `.project-map/` directory is created in the target project containing the SQLite database, and a `project-map.config.json` configuration file is placed at the project root.

---

## Configuration

Project Map MCP uses a JSON configuration file (`project-map.config.json`) at the project root. An example is provided in `project-map.config.example.json`.

### Full Configuration Reference

```jsonc
{
  // Project identity
  "project": {
    "name": "my-project",       // Human-readable project name
    "root": "."                  // Project root (relative to config file)
  },

  // Analysis settings
  "analysis": {
    "languages": ["php", "javascript"],   // Languages to parse
    "frameworks": ["laravel", "express"], // Framework adapters to activate
    "exclude_patterns": [                  // Glob patterns to skip
      "node_modules/**",
      "vendor/**",
      "dist/**",
      "build/**",
      ".git/**",
      "storage/**",
      "public/build/**"
    ],
    "max_file_size_mb": 2,        // Skip files larger than this (MB)
    "max_directory_depth": 20,    // Max recursion depth for directory scan
    "max_files_per_sync": 500,    // Max files per incremental sync
    "parse_timeout_ms": 30000     // Per-file parse timeout (ms)
  },

  // Database settings
  "database": {
    "path": ".project-map/knowledge.db",  // SQLite database location
    "max_size_mb": 500,              // Max database size
    "cache_size_mb": 64              // SQLite cache size
  },

  // Security settings
  "security": {
    "blocked_paths": [".env*", "*.pem", "*.key", "*.p12", "*.pfx"],
    "mysql": {
      "allow_connection": true,                // Allow MySQL live schema queries
      "allowed_hosts": ["localhost", "127.0.0.1"], // Whitelist for MySQL hosts
      "blocked_schemas": ["mysql", "performance_schema", "sys", "information_schema"]
    },
    "rate_limit": {
      "enabled": true,
      "max_per_minute": 60       // Max tool calls per minute
    }
  },

  // Sync behavior
  "sync": {
    "reconciliation_interval": 10,  // Full reconciliation every N snapshots
    "staleness_max_depth": 3        // Max BFS depth for staleness propagation
  },

  // Context delivery defaults
  "context": {
    "default_depth": "structure",      // summary | structure | detail | full
    "default_purpose": "understand",   // understand | implement | debug | review | plan
    "default_token_budget": 2000,      // Default token limit per response
    "max_token_budget": 200000         // Maximum allowed token budget
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PROJECT_MAP_PROJECT_ROOT` | Path to the project to analyze | Required for MCP server |
| `PROJECT_MAP_DB_PATH` | Override database location | `{project_root}/.project-map/knowledge.db` |

---

## Setup with AI Clients

### Automated Setup (Recommended)

Run the included setup script to configure Project Map MCP for your preferred IDE/client automatically:

```bash
# Interactive mode — detects your OS, finds installed clients, and configures them
./setup.sh

# Or specify the target project directly
./setup.sh --project /path/to/your/project

# Configure a specific client only
./setup.sh --client claude-desktop --project /path/to/your/project
./setup.sh --client claude-code --project /path/to/your/project
./setup.sh --client cursor --project /path/to/your/project
./setup.sh --client windsurf --project /path/to/your/project
```

The script works on **macOS**, **Linux**, and **Windows** (Git Bash / WSL / PowerShell). It:
1. Detects installed MCP-compatible clients
2. Resolves absolute paths for the server binary
3. Writes or merges the MCP configuration into the correct config file
4. Validates the setup with a dry-run

### Claude Desktop (Manual)

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code (CLI)

Add to your project's `.claude/settings.json` or global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root (or global settings):

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Other MCP Clients

Any MCP-compatible client that supports STDIO transport can connect to Project Map MCP. The server binary is `dist/index.js` and it communicates via stdin/stdout JSON-RPC. Set the environment variable `PROJECT_MAP_PROJECT_ROOT` to point to the project you want to analyze.

---

## MCP Tools Reference

Project Map MCP exposes 8 tools through the MCP protocol. Each tool returns JSON with a `meta` field containing token usage, depth, purpose, and other metadata.

### get_context

Delivers progressive context about any part of the project — files, classes, modules, routes. The core tool for understanding code.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | Yes | — | Path, entity name, or query. Examples: `"src/controllers/"`, `"UserService"`, `"POST /api/users"` |
| `depth` | enum | No | `"structure"` | Level of detail: `summary`, `structure`, `detail`, `full` |
| `purpose` | enum | No | `"understand"` | Content prioritization: `understand`, `implement`, `debug`, `review`, `plan` |
| `token_budget` | number | No | 2000 | Maximum tokens in response (max: 200,000) |
| `session_id` | string | No | — | For delta responses across repeated queries |
| `include` | string[] | No | — | Additional sections: `knowledge`, `evidence`, `edges`, `conventions`, `gaps` |

**Examples:**

```json
// Understand a controller directory
{
  "target": "src/controllers/",
  "depth": "structure",
  "purpose": "understand"
}

// Get full detail for implementing a feature
{
  "target": "App\\Services\\PaymentService",
  "depth": "detail",
  "purpose": "implement",
  "token_budget": 5000,
  "include": ["knowledge", "edges"]
}

// Debug a specific route
{
  "target": "POST /api/payments",
  "depth": "full",
  "purpose": "debug",
  "include": ["edges", "evidence", "gaps"]
}
```

**Purpose Modes** adjust content weighting:

| Purpose | Prioritizes |
|---|---|
| `understand` | Knowledge (30%), Edges (25%), Symbols (25%) |
| `implement` | Symbols (30%), Edges (30%), Knowledge (20%) |
| `debug` | Edges (30%), Symbols (25%), Knowledge (20%) |
| `review` | Knowledge (35%), Gaps (25%), Edges (20%) |
| `plan` | Edges (30%), Knowledge (25%), Symbols (20%) |

---

### search

Full-text and structural search across entities, knowledge records, and evidence. Uses SQLite FTS5 for ranked results.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | Yes | — | Search text or structural pattern |
| `scope` | enum | No | `"all"` | Where to search: `entities`, `knowledge`, `evidence`, `all` |
| `filters` | object | No | — | Narrow results (see below) |
| `limit` | number | No | 20 | Max results (max: 500) |
| `token_budget` | number | No | 1500 | Max tokens in response |

**Filter options:**

| Filter | Type | Description |
|---|---|---|
| `entity_type` | string | `class`, `function`, `route`, `model`, `migration`, `table`, etc. |
| `language` | string | `php`, `javascript`, `sql`, `json`, `yaml`, `markdown` |
| `path_prefix` | string | Filter by file path prefix |
| `knowledge_type` | string | `business_rule`, `architectural_decision`, `api_contract`, etc. |
| `validation_status` | string | `unverified`, `supported_by_code`, `human_confirmed`, `disputed`, etc. |
| `origin` | string | `deterministic`, `heuristic`, `ai_generated`, `human_provided` |

**Examples:**

```json
// Find all payment-related entities
{
  "query": "payment",
  "scope": "entities",
  "filters": { "entity_type": "class" },
  "limit": 10
}

// Search business rules about authentication
{
  "query": "authentication login",
  "scope": "knowledge",
  "filters": { "knowledge_type": "business_rule" }
}

// Search everything in a specific directory
{
  "query": "validation",
  "filters": { "path_prefix": "src/services/" }
}
```

---

### graph

Navigates the dependency graph from a starting entity. Shows incoming/outgoing relationships with configurable depth and edge type filters.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `entity_id` | string | Yes | — | Starting entity UUID |
| `direction` | enum | No | `"both"` | `incoming`, `outgoing`, or `both` |
| `edge_types` | string[] | No | all types | Filter by relationship type |
| `max_depth` | number | No | 2 | Maximum traversal depth (max: 10) |
| `include_unresolved` | boolean | No | `false` | Include unresolved/ambiguous edges |
| `token_budget` | number | No | 1500 | Max tokens |

**Examples:**

```json
// See what depends on a service class
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "direction": "incoming",
  "max_depth": 3
}

// Explore only inheritance and trait relationships
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "edge_types": ["extends", "implements", "uses_trait"],
  "direction": "outgoing"
}

// Full dependency tree including unresolved references
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "direction": "both",
  "max_depth": 5,
  "include_unresolved": true,
  "token_budget": 5000
}
```

**Available edge types:** `imports`, `extends`, `implements`, `uses_trait`, `calls`, `instantiates`, `references`, `belongs_to`, `has_many`, `belongs_to_model`, `has_one`, `many_to_many`, `maps_to_table`, `handles_route`, `dispatches`, `listens_to`, `renders`, `migrates`, `foreign_key_to`, `depends_on`, `tests`.

---

### impact

Analyzes the impact of modifying, deleting, or renaming an entity. Shows affected components, tests, routes, and knowledge records. Essential before refactoring.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `entity_id` | string | Yes | — | Entity that will be changed |
| `change_type` | enum | No | `"modify"` | `modify`, `delete`, or `rename` |
| `max_depth` | number | No | 3 | Propagation depth through the graph |
| `include_tests` | boolean | No | `true` | Include affected tests in results |
| `token_budget` | number | No | 2000 | Max tokens |

**Examples:**

```json
// What breaks if I modify this model?
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "modify",
  "include_tests": true
}

// Impact of deleting a service class
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "delete",
  "max_depth": 5,
  "token_budget": 5000
}

// Rename impact (shows all references that need updating)
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "rename"
}
```

---

### record

Creates, updates, validates, invalidates, or disputes knowledge records. Each record is linked to evidence and entities for full traceability.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum | Yes | — | `create`, `update`, `validate`, `invalidate`, `dispute` |
| `knowledge_type` | string | For `create` | — | One of the 12 knowledge types (see below) |
| `subject` | string | For `create` | — | Subject entity or area |
| `content` | string | For `create` | — | The assertion / knowledge content |
| `evidence` | array | No | — | Array of evidence objects (see below) |
| `entity_ids` | string[] | No | — | Linked entity UUIDs |
| `knowledge_id` | string | For `update`/`validate`/`invalidate`/`dispute` | — | ID of existing record |
| `validation_status` | string | No | — | New validation status |
| `confidence` | number | No | — | Confidence score (0.0 - 1.0) |

**Evidence object:**

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | File path |
| `line_start` | number | No | Starting line |
| `line_end` | number | No | Ending line |
| `excerpt` | string | No | Code excerpt |
| `source_kind` | string | Yes | `code`, `comment`, `docblock`, `config`, `migration`, `test`, `git_log`, `manual`, `schema` |

**Knowledge types:** `business_rule`, `architectural_decision`, `data_flow`, `api_contract`, `constraint`, `pattern`, `dependency_note`, `security_note`, `performance_note`, `todo`, `explanation`, `convention`.

**Examples:**

```json
// Record a business rule discovered in code
{
  "action": "create",
  "knowledge_type": "business_rule",
  "subject": "PaymentService",
  "content": "Payments over $10,000 require manual approval from a manager before processing.",
  "evidence": [
    {
      "path": "src/services/PaymentService.php",
      "line_start": 142,
      "line_end": 155,
      "excerpt": "if ($amount > 10000) { $this->requireApproval(); }",
      "source_kind": "code"
    }
  ],
  "entity_ids": ["550e8400-e29b-41d4-a716-446655440000"],
  "confidence": 0.95
}

// Validate an existing knowledge record with test evidence
{
  "action": "validate",
  "knowledge_id": "660e8400-e29b-41d4-a716-446655440001",
  "validation_status": "supported_by_tests",
  "evidence": [
    {
      "path": "tests/PaymentServiceTest.php",
      "line_start": 89,
      "source_kind": "test"
    }
  ]
}

// Dispute a knowledge record
{
  "action": "dispute",
  "knowledge_id": "660e8400-e29b-41d4-a716-446655440001",
  "content": "The threshold was changed to $5,000 in commit abc1234."
}
```

---

### sync

Controls repository synchronization — indexing files with Tree-sitter, tracking changes, and analyzing MySQL schemas.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum | Yes | — | `status`, `incremental`, `full`, `analyze_file`, `analyze_schema` |
| `path` | string | For `analyze_file` | — | File path to analyze |
| `connection` | object | For `analyze_schema` | — | MySQL connection details (see below) |
| `force` | boolean | No | `false` | Force re-analysis even without detected changes |

**MySQL connection object:**

| Field | Type | Description |
|---|---|---|
| `host` | string | MySQL host |
| `port` | number | MySQL port |
| `user` | string | MySQL user |
| `password` | string | MySQL password |
| `database` | string | Database name |

**Examples:**

```json
// Check current sync status
{ "action": "status" }

// Incremental sync (only changed files)
{ "action": "incremental" }

// Full re-index of the entire project
{ "action": "full" }

// Force full re-index (ignore cached state)
{ "action": "full", "force": true }

// Analyze a single file
{
  "action": "analyze_file",
  "path": "app/Models/User.php"
}

// Analyze MySQL database schema
{
  "action": "analyze_schema",
  "connection": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "",
    "database": "my_app"
  }
}
```

---

### session

Manages work session continuity across AI chat sessions. Saves checkpoints of task progress so another AI instance (or the same one in a new conversation) can resume exactly where work left off.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum | Yes | — | `checkpoint`, `resume`, `list`, `close` |
| `session_name` | string | For `checkpoint` | — | Human-readable session identifier |
| `task_description` | string | For `checkpoint` | — | Natural language description of the task |
| `current_status` | string | No | — | What is being done right now |
| `completed_steps` | string[] | No | — | Steps already finished |
| `pending_steps` | string[] | No | — | Steps remaining |
| `files_involved` | string[] | No | — | Files being modified or analyzed |
| `notes` | string | No | — | Free-form notes, decisions, context |
| `session_id` | string | For `resume`/`close` | — | Session UUID |

**Examples:**

```json
// Save a checkpoint of current work
{
  "action": "checkpoint",
  "session_name": "refactoring-auth-module",
  "task_description": "Refactor authentication module to use JWT instead of sessions",
  "current_status": "Implementing token refresh logic",
  "completed_steps": [
    "Replaced session middleware with JWT middleware",
    "Updated User model with token methods",
    "Created TokenService class"
  ],
  "pending_steps": [
    "Implement token refresh endpoint",
    "Update all auth tests",
    "Update API documentation"
  ],
  "files_involved": [
    "app/Http/Middleware/AuthenticateWithJwt.php",
    "app/Services/TokenService.php",
    "app/Models/User.php"
  ],
  "notes": "Decided to use RS256 algorithm. Refresh tokens stored in database with 30-day expiry."
}

// List available sessions
{ "action": "list" }

// Resume a previous session
{
  "action": "resume",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}

// Close a completed session
{
  "action": "close",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### export

Manages portable database sharing. Export your indexed project database as a `.pmap.db` file and share it with teammates. They can import it to instantly have the full knowledge base without re-analyzing the project.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | enum | Yes | — | `export` (create shareable file), `import` (load shared DB), `list` (show exports) |
| `label` | string | No | project name | Human-readable label for the export, used in filename |
| `path` | string | For `import` | — | Path to the `.pmap.db` file to import |

**Examples:**

```json
// Export the current database for sharing
{
  "action": "export",
  "label": "sprint-42-complete"
}

// Import a database shared by a teammate
{
  "action": "import",
  "path": "/path/to/shared-project.pmap.db"
}

// List available exports
{ "action": "list" }
```

**Sharing workflow:**

1. You index a project: `sync` with `action: "full"`
2. Export the database: `export` with `action: "export"`
3. Send the `.pmap.db` file to your teammate (Slack, email, shared drive)
4. Teammate imports it: `export` with `action: "import"` and the file path
5. Teammate now has all entities, knowledge, edges, and conventions — no re-analysis needed

**Notes:**
- The exported file is a complete SQLite database with all project data.
- Paths are stored as relative, so the database works on any machine regardless of directory structure.
- Import validates schema compatibility and creates a backup of the current database before replacing it.
- Exports are saved in `.project-map/exports/` inside the project directory.

---

## CLI Usage

Project Map MCP also provides a command-line interface for common operations outside of MCP:

```bash
# Initialize a new project (creates .project-map/ and config file)
pmap init [path]

# Incremental sync (only changed files)
pmap sync

# Full re-index
pmap sync --full

# Show project status and latest snapshot
pmap status

# Search entities and knowledge
pmap search "PaymentService"

# Export database for sharing with team
pmap export [label]

# Import a shared database file
pmap import /path/to/shared.pmap.db

# List available exports
pmap exports

# Help
pmap --help
```

If installed globally or linked via npm, use `pmap` directly. Otherwise:

```bash
node dist/cli/index.js init /path/to/project
node dist/cli/index.js sync --full
node dist/cli/index.js search "UserController"
node dist/cli/index.js export "sprint-42"
node dist/cli/index.js import /path/to/shared.pmap.db
node dist/cli/index.js exports
```

Environment variables `PROJECT_MAP_PROJECT_ROOT` and `PROJECT_MAP_DB_PATH` can override the default project root (current directory) and database location.

---

## Development

### Prerequisites

- Node.js >= 18
- npm
- C++ build toolchain (for Tree-sitter native modules)

### Setup

```bash
git clone https://github.com/kerlonfernandes/project-map-mcp.git
cd project-map-mcp
npm install
```

### Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run MCP server with tsx (no build required) |
| `npm run dev:cli` | Run CLI with tsx |
| `npm test` | Run all tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check code formatting |
| `npm run typecheck` | Type-check without emitting |
| `npm run clean` | Remove `dist/` directory |

### Project Structure

```
src/
  adapter/              # MCP protocol layer (entry point)
    server.ts           # McpServer setup, tool registration
    tools/              # Individual tool handlers
      get-context.ts
      search.ts
      graph.ts
      impact.ts
      record.ts
      sync.ts
      session.ts
      export.ts
  analyzer/             # Code analysis (Tree-sitter, frameworks)
    core.ts             # Analysis pipeline orchestrator
    parsers/
      php.ts            # PHP AST parser
      javascript.ts     # JavaScript AST parser
    frameworks/
      laravel.ts        # Laravel framework adapter
      express.ts        # Express.js framework adapter
    mysql.ts            # MySQL schema analyzer
  cli/                  # Command-line interface
    index.ts            # CLI commands (init, sync, status, search, export, import)
    config.ts           # Configuration loading
  domain/               # Domain services (business logic)
    knowledge.ts        # Duplicate detection, Jaccard similarity
    conventions.ts      # Convention detection
  repository/           # Data access layer (SQLite)
    db.ts               # Database initialization, migrations
    entities.ts         # Entity CRUD
    evidence.ts         # Evidence CRUD
    knowledge.ts        # Knowledge record CRUD
    graph.ts            # Edge/relationship CRUD
    snapshots.ts        # Snapshot tracking
    projects.ts         # Project and repository management
    cache.ts            # Session cache
    sessions.ts         # Work session CRUD
    audit.ts            # Audit log
  services/             # Application services (orchestration)
    context.ts          # Context delivery with progressive depth
    search.ts           # Full-text search via FTS5
    graph.ts            # Dependency graph traversal
    impact.ts           # Change impact analysis
    record.ts           # Knowledge record management
    sync.ts             # Repository synchronization
    session.ts          # Work session management
    export.ts           # Database export/import for team sharing
  shared/               # Shared utilities and types
    types.ts            # All TypeScript interfaces and type unions
    constants.ts        # Application-wide constants
    errors.ts           # Typed error hierarchy
    schemas.ts          # Zod validation schemas
    utils.ts            # Utility functions (sanitize, hash, etc.)
  index.ts              # Main entry point (MCP server)

migrations/
  001_initial.sql       # Core schema (entities, edges, knowledge, etc.)
  002_work_sessions.sql # Work sessions and checkpoints
  003_conventions_unique.sql
  004_portable_db.sql   # Portable database: db_metadata, relative paths

test/
  unit/                 # Unit tests (pure functions, in-memory SQLite)
  integration/          # Integration tests (full pipeline)
```

### Testing

Tests use [Vitest](https://vitest.dev/) with in-memory SQLite for isolation:

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run test/unit/repository/entities.test.ts

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage
```

---

## Security

Project Map MCP treats all repository content as untrusted data. Security measures include:

- **Path traversal protection** — all file paths are validated and resolved against the project root. Symlinks that escape the root are blocked.
- **Blocked paths** — sensitive files (`.env*`, `*.pem`, `*.key`, etc.) are never read. Configurable via `security.blocked_paths`.
- **Prepared statements only** — all SQL uses parameterized queries. No string interpolation.
- **Rate limiting** — configurable per-minute limit to prevent abuse (default: 60 req/min).
- **MySQL safety** — connections restricted to allowed hosts (default: localhost only). System schemas are blocked. Read-only queries only.
- **Audit logging** — every tool call is logged with operation, parameters hash, result summary, entities affected, and duration.
- **Generic error responses** — internal error details never leak to clients. Details are logged server-side only.
- **No code execution** — Project Map MCP never executes project code. Analysis is purely structural (AST parsing).
- **No LLM calls** — all analysis is deterministic. Same input always produces the same output.

---

## License

[MIT](LICENSE)

---

---

# Documentacao em Portugues

> Memoria tecnica persistente, verificavel e compartilhada para projetos de software — com Tree-sitter e SQLite.

O Project Map MCP e um servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) que indexa seu codigo-fonte, rastreia relacionamentos entre componentes, armazena conhecimento com evidencias rastreaveis e entrega contexto progressivo para clientes de IA. Utiliza **Tree-sitter** para parsing AST deterministico e **SQLite + FTS5** para persistencia e busca full-text. Nunca executa codigo do seu projeto e nunca chama LLMs externas — toda afirmacao e rastreavel ate o codigo-fonte.

---

## Indice

- [Funcionalidades](#funcionalidades)
- [Arquitetura](#arquitetura)
- [Instalacao](#instalacao)
- [Configuracao](#configuracao-1)
- [Configurar com Clientes IA](#configurar-com-clientes-ia)
  - [Claude Desktop](#claude-desktop-1)
  - [Claude Code (CLI)](#claude-code-cli-1)
  - [Cursor](#cursor-1)
  - [Windsurf](#windsurf-1)
- [Referencia das Tools MCP](#referencia-das-tools-mcp)
  - [get_context](#get_context-1)
  - [search](#search-1)
  - [graph](#graph-1)
  - [impact](#impact-1)
  - [record](#record-1)
  - [sync](#sync-1)
  - [session](#session-1)
  - [export](#export-1)
- [Uso via CLI](#uso-via-cli)
- [Desenvolvimento](#desenvolvimento)
- [Seguranca](#seguranca)
- [Licenca](#licenca)

---

## Funcionalidades

### Analise de Codigo
- **Parsing de PHP e JavaScript** via Tree-sitter AST — deterministico, sem heuristicas para extracao de estrutura.
- **Deteccao de framework Laravel** — rotas, modelos Eloquent com relacionamentos (hasMany, belongsTo, etc.), migrations, events, listeners, jobs, middleware, views Blade, commands, config, factories e seeders.
- **Deteccao de framework Express.js** — rotas (app/router), middleware, router mounts e error handlers.
- **Analise de schema MySQL** — parsing de SQL de migrations e consultas ao `information_schema` (somente leitura).

### Gestao de Conhecimento
- **Registros de conhecimento com evidencia** — toda afirmacao esta vinculada a codigo, comentarios, docblocks, configs, migrations, testes ou entradas manuais.
- **Deteccao de duplicatas** com scoring de similaridade Jaccard (FTS5 + sobreposicao de conjuntos de palavras).
- **Ciclo de vida de validacao** — registros passam por `unverified` -> `supported_by_code` -> `human_confirmed` (ou `disputed` / `invalidated`).
- **12 tipos de conhecimento**: `business_rule`, `architectural_decision`, `data_flow`, `api_contract`, `constraint`, `pattern`, `dependency_note`, `security_note`, `performance_note`, `todo`, `explanation`, `convention`.

### Entrega Progressiva de Contexto
- **4 niveis de profundidade**: `summary`, `structure`, `detail`, `full` — controla quanta informacao e retornada.
- **5 modos de proposito**: `understand`, `implement`, `debug`, `review`, `plan` — cada um prioriza diferentes tipos de conteudo com alocacao ponderada.
- **Orcamentos de tokens** — respostas respeitam limites configuraveis (padrao: 2.000, maximo: 200.000).
- **Cache de sessao com respostas delta** — consultas repetidas na mesma sessao retornam apenas o que mudou.

### Grafo de Dependencias
- **21 tipos de relacionamento**: `imports`, `extends`, `implements`, `uses_trait`, `calls`, `instantiates`, `references`, `belongs_to`, `has_many`, `belongs_to_model`, `has_one`, `many_to_many`, `maps_to_table`, `handles_route`, `dispatches`, `listens_to`, `renders`, `migrates`, `foreign_key_to`, `depends_on`, `tests`.
- **Arestas ponderadas** — cada tipo de relacionamento tem um peso de acoplamento (0.2 a 0.9) para analise de impacto.
- **Propagacao de obsolescencia** — quando um arquivo muda, entidades dependentes sao marcadas como obsoletas via travessia BFS ate profundidade configuravel.

### Deteccao de Convencoes
- **6 categorias**: `naming`, `structure`, `pattern`, `config`, `testing`, `documentation`.
- Detectadas quando um padrao aparece em pelo menos 3 ocorrencias ou 60% dos arquivos correspondentes.

### Bancos de Dados Portaveis e Compartilhaveis
- **Banco de dados por projeto** — cada projeto tem seu proprio `.project-map/knowledge.db` com todos os dados indexados.
- **Portavel por design** — todos os caminhos sao armazenados como relativos, permitindo transferir o banco entre maquinas.
- **Export/Import** — exporte um arquivo `.pmap.db` e compartilhe com colegas. Eles importam e tem instantaneamente toda a base de conhecimento sem re-analisar.
- **Compatibilidade de schema** — imports validam a versao do schema para prevenir carregamento de bancos incompativeis.

### Infraestrutura
- **Busca full-text** via SQLite FTS5 em entidades, conhecimento e evidencias.
- **Log de auditoria** — toda chamada de tool e registrada com parametros, resultados e duracao.
- **Rate limiting** — limite configuravel por minuto (padrao: 60 requisicoes/min).
- **Continuidade de sessao de trabalho** — salve e retome o progresso de tarefas entre sessoes de chat com IA.

---

## Arquitetura

```
Pontos de Entrada
  adapter/server.ts  — Servidor MCP (transporte STDIO)
  cli/index.ts       — Interface de linha de comando
      |
      v
Servicos de Aplicacao (services/)
  context.ts, search.ts, graph.ts, impact.ts, record.ts, sync.ts, session.ts
      |
      v
Servicos de Dominio (domain/)
  knowledge.ts   — Deteccao de duplicatas, similaridade Jaccard
  conventions.ts — Deteccao de convencoes
      |
      v
Camada de Repositorio (repository/)
  entities.ts, evidence.ts, knowledge.ts, graph.ts, snapshots.ts,
  projects.ts, cache.ts, sessions.ts, audit.ts, db.ts
      |
      v
SQLite + FTS5 (better-sqlite3)
```

Dependencias sempre apontam para dentro. Pontos de entrada nao contem logica de negocio. A camada de repositorio e o unico codigo que toca o SQLite.

**Analise de Codigo** (`analyzer/`) roda como pipeline separado:

```
analyzer/core.ts
  |-- parsers/php.ts        (Tree-sitter PHP)
  |-- parsers/javascript.ts (Tree-sitter JavaScript)
  |-- frameworks/laravel.ts (Adaptador Laravel)
  |-- frameworks/express.ts (Adaptador Express)
  |-- mysql.ts              (Analisador de schema MySQL)
```

---

## Instalacao

### Pre-requisitos

- **Node.js** >= 18.0.0
- **npm** (incluido com o Node.js)
- Toolchain de compilacao C++ (para bindings nativos do Tree-sitter): `build-essential` no Debian/Ubuntu, Xcode Command Line Tools no macOS, ou Visual Studio Build Tools no Windows.

### Passos

```bash
# 1. Clonar o repositorio
git clone https://github.com/kerlonfernandes/project-map-mcp.git
cd project-map-mcp

# 2. Instalar dependencias
npm install

# 3. Compilar o projeto TypeScript
npm run build

# 4. (Opcional) Inicializar um projeto para analise
pmap init /caminho/para/seu/projeto

# 5. (Opcional) Rodar o primeiro sync completo
pmap sync --full
```

Apos o `init`, um diretorio `.project-map/` e criado no projeto alvo contendo o banco SQLite, e um arquivo de configuracao `project-map.config.json` e colocado na raiz do projeto.

---

## Configuracao

O Project Map MCP usa um arquivo de configuracao JSON (`project-map.config.json`) na raiz do projeto. Um exemplo e fornecido em `project-map.config.example.json`.

### Referencia Completa de Configuracao

```jsonc
{
  // Identidade do projeto
  "project": {
    "name": "meu-projeto",      // Nome legivel do projeto
    "root": "."                  // Raiz do projeto (relativo ao arquivo de config)
  },

  // Configuracoes de analise
  "analysis": {
    "languages": ["php", "javascript"],   // Linguagens para parsear
    "frameworks": ["laravel", "express"], // Adaptadores de framework a ativar
    "exclude_patterns": [                  // Padroes glob para ignorar
      "node_modules/**",
      "vendor/**",
      "dist/**",
      "build/**",
      ".git/**",
      "storage/**",
      "public/build/**"
    ],
    "max_file_size_mb": 2,        // Pular arquivos maiores que isso (MB)
    "max_directory_depth": 20,    // Profundidade maxima de recursao no scan
    "max_files_per_sync": 500,    // Maximo de arquivos por sync incremental
    "parse_timeout_ms": 30000     // Timeout de parse por arquivo (ms)
  },

  // Configuracoes do banco de dados
  "database": {
    "path": ".project-map/knowledge.db",  // Localizacao do banco SQLite
    "max_size_mb": 500,              // Tamanho maximo do banco
    "cache_size_mb": 64              // Tamanho do cache SQLite
  },

  // Configuracoes de seguranca
  "security": {
    "blocked_paths": [".env*", "*.pem", "*.key", "*.p12", "*.pfx"],
    "mysql": {
      "allow_connection": true,                // Permitir consultas ao MySQL
      "allowed_hosts": ["localhost", "127.0.0.1"], // Whitelist de hosts MySQL
      "blocked_schemas": ["mysql", "performance_schema", "sys", "information_schema"]
    },
    "rate_limit": {
      "enabled": true,
      "max_per_minute": 60       // Maximo de chamadas de tool por minuto
    }
  },

  // Comportamento de sincronizacao
  "sync": {
    "reconciliation_interval": 10,  // Reconciliacao completa a cada N snapshots
    "staleness_max_depth": 3        // Profundidade maxima BFS para propagacao de obsolescencia
  },

  // Padroes de entrega de contexto
  "context": {
    "default_depth": "structure",      // summary | structure | detail | full
    "default_purpose": "understand",   // understand | implement | debug | review | plan
    "default_token_budget": 2000,      // Limite padrao de tokens por resposta
    "max_token_budget": 200000         // Maximo permitido de orcamento de tokens
  }
}
```

### Variaveis de Ambiente

| Variavel | Descricao | Padrao |
|---|---|---|
| `PROJECT_MAP_PROJECT_ROOT` | Caminho para o projeto a analisar | Obrigatorio para o servidor MCP |
| `PROJECT_MAP_DB_PATH` | Sobrescrever localizacao do banco | `{raiz_do_projeto}/.project-map/knowledge.db` |

---

## Configurar com Clientes IA

### Setup Automatizado (Recomendado)

Execute o script de setup incluido para configurar o Project Map MCP automaticamente:

```bash
# Modo interativo — detecta seu SO, encontra clientes instalados e configura
./setup.sh

# Ou especifique o projeto alvo diretamente
./setup.sh --project /caminho/para/seu/projeto

# Configurar apenas um cliente especifico
./setup.sh --client claude-desktop --project /caminho/para/seu/projeto
./setup.sh --client cursor --project /caminho/para/seu/projeto
```

O script funciona em **macOS**, **Linux** e **Windows** (Git Bash / WSL / PowerShell).

### Claude Desktop

Localizacao do config:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/caminho/absoluto/para/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/caminho/absoluto/para/seu/projeto"
      }
    }
  }
}
```

Reinicie o Claude Desktop apos salvar.

### Claude Code (CLI)

Adicione ao `.claude/settings.json` do seu projeto ou global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/caminho/absoluto/para/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/caminho/absoluto/para/seu/projeto"
      }
    }
  }
}
```

### Cursor

Adicione ao `.cursor/mcp.json` na raiz do projeto (ou configuracoes globais):

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/caminho/absoluto/para/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/caminho/absoluto/para/seu/projeto"
      }
    }
  }
}
```

### Windsurf

Adicione ao `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "project-map-mcp": {
      "command": "node",
      "args": ["/caminho/absoluto/para/project-map-mcp/dist/index.js"],
      "env": {
        "PROJECT_MAP_PROJECT_ROOT": "/caminho/absoluto/para/seu/projeto"
      }
    }
  }
}
```

### Outros Clientes MCP

Qualquer cliente compativel com MCP que suporte transporte STDIO pode conectar ao Project Map MCP. O binario do servidor e `dist/index.js` e ele se comunica via stdin/stdout JSON-RPC. Defina a variavel de ambiente `PROJECT_MAP_PROJECT_ROOT` apontando para o projeto que deseja analisar.

---

## Referencia das Tools MCP

O Project Map MCP expoe 8 tools atraves do protocolo MCP. Cada tool retorna JSON com um campo `meta` contendo uso de tokens, profundidade, proposito e outros metadados.

### get_context

Entrega contexto progressivo sobre qualquer parte do projeto — arquivos, classes, modulos, rotas. A tool principal para entender codigo.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `target` | string | Sim | — | Caminho, nome de entidade ou query. Ex: `"src/controllers/"`, `"UserService"`, `"POST /api/users"` |
| `depth` | enum | Nao | `"structure"` | Nivel de detalhe: `summary`, `structure`, `detail`, `full` |
| `purpose` | enum | Nao | `"understand"` | Priorizacao de conteudo: `understand`, `implement`, `debug`, `review`, `plan` |
| `token_budget` | number | Nao | 2000 | Maximo de tokens na resposta (max: 200.000) |
| `session_id` | string | Nao | — | Para respostas delta entre consultas repetidas |
| `include` | string[] | Nao | — | Secoes adicionais: `knowledge`, `evidence`, `edges`, `conventions`, `gaps` |

**Exemplos:**

```json
// Entender um diretorio de controllers
{
  "target": "src/controllers/",
  "depth": "structure",
  "purpose": "understand"
}

// Detalhe completo para implementar uma feature
{
  "target": "App\\Services\\PaymentService",
  "depth": "detail",
  "purpose": "implement",
  "token_budget": 5000,
  "include": ["knowledge", "edges"]
}

// Debug de uma rota especifica
{
  "target": "POST /api/payments",
  "depth": "full",
  "purpose": "debug",
  "include": ["edges", "evidence", "gaps"]
}
```

**Modos de Proposito** ajustam a ponderacao de conteudo:

| Proposito | Prioriza |
|---|---|
| `understand` | Conhecimento (30%), Arestas (25%), Simbolos (25%) |
| `implement` | Simbolos (30%), Arestas (30%), Conhecimento (20%) |
| `debug` | Arestas (30%), Simbolos (25%), Conhecimento (20%) |
| `review` | Conhecimento (35%), Lacunas (25%), Arestas (20%) |
| `plan` | Arestas (30%), Conhecimento (25%), Simbolos (20%) |

---

### search

Busca full-text e estrutural em entidades, registros de conhecimento e evidencias. Usa SQLite FTS5 para resultados ranqueados.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `query` | string | Sim | — | Texto de busca ou padrao estrutural |
| `scope` | enum | Nao | `"all"` | Onde buscar: `entities`, `knowledge`, `evidence`, `all` |
| `filters` | object | Nao | — | Filtrar resultados (ver abaixo) |
| `limit` | number | Nao | 20 | Maximo de resultados (max: 500) |
| `token_budget` | number | Nao | 1500 | Maximo de tokens na resposta |

**Opcoes de filtro:**

| Filtro | Tipo | Descricao |
|---|---|---|
| `entity_type` | string | `class`, `function`, `route`, `model`, `migration`, `table`, etc. |
| `language` | string | `php`, `javascript`, `sql`, `json`, `yaml`, `markdown` |
| `path_prefix` | string | Filtrar por prefixo de caminho |
| `knowledge_type` | string | `business_rule`, `architectural_decision`, `api_contract`, etc. |
| `validation_status` | string | `unverified`, `supported_by_code`, `human_confirmed`, `disputed`, etc. |
| `origin` | string | `deterministic`, `heuristic`, `ai_generated`, `human_provided` |

**Exemplos:**

```json
// Encontrar todas as entidades relacionadas a pagamento
{
  "query": "payment",
  "scope": "entities",
  "filters": { "entity_type": "class" },
  "limit": 10
}

// Buscar regras de negocio sobre autenticacao
{
  "query": "authentication login",
  "scope": "knowledge",
  "filters": { "knowledge_type": "business_rule" }
}

// Buscar tudo em um diretorio especifico
{
  "query": "validation",
  "filters": { "path_prefix": "src/services/" }
}
```

---

### graph

Navega o grafo de dependencias a partir de uma entidade inicial. Mostra relacionamentos de entrada/saida com profundidade e filtros de tipo de aresta configuraveis.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `entity_id` | string | Sim | — | UUID da entidade inicial |
| `direction` | enum | Nao | `"both"` | `incoming`, `outgoing` ou `both` |
| `edge_types` | string[] | Nao | todos os tipos | Filtrar por tipo de relacionamento |
| `max_depth` | number | Nao | 2 | Profundidade maxima de travessia (max: 10) |
| `include_unresolved` | boolean | Nao | `false` | Incluir arestas nao resolvidas/ambiguas |
| `token_budget` | number | Nao | 1500 | Maximo de tokens |

**Exemplos:**

```json
// Ver o que depende de uma classe de servico
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "direction": "incoming",
  "max_depth": 3
}

// Explorar apenas heranca e traits
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "edge_types": ["extends", "implements", "uses_trait"],
  "direction": "outgoing"
}

// Arvore completa de dependencias incluindo referencias nao resolvidas
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "direction": "both",
  "max_depth": 5,
  "include_unresolved": true,
  "token_budget": 5000
}
```

**Tipos de aresta disponiveis:** `imports`, `extends`, `implements`, `uses_trait`, `calls`, `instantiates`, `references`, `belongs_to`, `has_many`, `belongs_to_model`, `has_one`, `many_to_many`, `maps_to_table`, `handles_route`, `dispatches`, `listens_to`, `renders`, `migrates`, `foreign_key_to`, `depends_on`, `tests`.

---

### impact

Analisa o impacto de modificar, excluir ou renomear uma entidade. Mostra componentes afetados, testes, rotas e registros de conhecimento. Essencial antes de refatoracao.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `entity_id` | string | Sim | — | Entidade que sera alterada |
| `change_type` | enum | Nao | `"modify"` | `modify`, `delete` ou `rename` |
| `max_depth` | number | Nao | 3 | Profundidade de propagacao no grafo |
| `include_tests` | boolean | Nao | `true` | Incluir testes afetados nos resultados |
| `token_budget` | number | Nao | 2000 | Maximo de tokens |

**Exemplos:**

```json
// O que quebra se eu modificar este model?
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "modify",
  "include_tests": true
}

// Impacto de excluir uma classe de servico
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "delete",
  "max_depth": 5,
  "token_budget": 5000
}

// Impacto de renomear (mostra todas as referencias que precisam ser atualizadas)
{
  "entity_id": "550e8400-e29b-41d4-a716-446655440000",
  "change_type": "rename"
}
```

---

### record

Cria, atualiza, valida, invalida ou disputa registros de conhecimento. Cada registro e vinculado a evidencias e entidades para rastreabilidade completa.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `action` | enum | Sim | — | `create`, `update`, `validate`, `invalidate`, `dispute` |
| `knowledge_type` | string | Para `create` | — | Um dos 12 tipos de conhecimento |
| `subject` | string | Para `create` | — | Entidade ou area sujeito |
| `content` | string | Para `create` | — | A afirmacao / conteudo do conhecimento |
| `evidence` | array | Nao | — | Array de objetos de evidencia (ver abaixo) |
| `entity_ids` | string[] | Nao | — | UUIDs de entidades vinculadas |
| `knowledge_id` | string | Para `update`/`validate`/`invalidate`/`dispute` | — | ID do registro existente |
| `validation_status` | string | Nao | — | Novo status de validacao |
| `confidence` | number | Nao | — | Score de confianca (0.0 - 1.0) |

**Objeto de evidencia:**

| Campo | Tipo | Obrigatorio | Descricao |
|---|---|---|---|
| `path` | string | Sim | Caminho do arquivo |
| `line_start` | number | Nao | Linha inicial |
| `line_end` | number | Nao | Linha final |
| `excerpt` | string | Nao | Trecho do codigo |
| `source_kind` | string | Sim | `code`, `comment`, `docblock`, `config`, `migration`, `test`, `git_log`, `manual`, `schema` |

**Tipos de conhecimento:** `business_rule`, `architectural_decision`, `data_flow`, `api_contract`, `constraint`, `pattern`, `dependency_note`, `security_note`, `performance_note`, `todo`, `explanation`, `convention`.

**Exemplos:**

```json
// Registrar uma regra de negocio descoberta no codigo
{
  "action": "create",
  "knowledge_type": "business_rule",
  "subject": "PaymentService",
  "content": "Pagamentos acima de R$10.000 exigem aprovacao manual de um gerente antes do processamento.",
  "evidence": [
    {
      "path": "src/services/PaymentService.php",
      "line_start": 142,
      "line_end": 155,
      "excerpt": "if ($amount > 10000) { $this->requireApproval(); }",
      "source_kind": "code"
    }
  ],
  "entity_ids": ["550e8400-e29b-41d4-a716-446655440000"],
  "confidence": 0.95
}

// Validar um registro de conhecimento existente com evidencia de teste
{
  "action": "validate",
  "knowledge_id": "660e8400-e29b-41d4-a716-446655440001",
  "validation_status": "supported_by_tests",
  "evidence": [
    {
      "path": "tests/PaymentServiceTest.php",
      "line_start": 89,
      "source_kind": "test"
    }
  ]
}

// Disputar um registro de conhecimento
{
  "action": "dispute",
  "knowledge_id": "660e8400-e29b-41d4-a716-446655440001",
  "content": "O limite foi alterado para R$5.000 no commit abc1234."
}
```

---

### sync

Controla a sincronizacao do repositorio — indexacao de arquivos com Tree-sitter, rastreamento de mudancas e analise de schemas MySQL.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `action` | enum | Sim | — | `status`, `incremental`, `full`, `analyze_file`, `analyze_schema` |
| `path` | string | Para `analyze_file` | — | Caminho do arquivo para analisar |
| `connection` | object | Para `analyze_schema` | — | Detalhes de conexao MySQL (ver abaixo) |
| `force` | boolean | Nao | `false` | Forcar re-analise mesmo sem mudancas detectadas |

**Objeto de conexao MySQL:**

| Campo | Tipo | Descricao |
|---|---|---|
| `host` | string | Host MySQL |
| `port` | number | Porta MySQL |
| `user` | string | Usuario MySQL |
| `password` | string | Senha MySQL |
| `database` | string | Nome do banco |

**Exemplos:**

```json
// Verificar status atual do sync
{ "action": "status" }

// Sync incremental (apenas arquivos alterados)
{ "action": "incremental" }

// Re-indexacao completa de todo o projeto
{ "action": "full" }

// Forcar re-indexacao completa (ignorar estado cacheado)
{ "action": "full", "force": true }

// Analisar um unico arquivo
{
  "action": "analyze_file",
  "path": "app/Models/User.php"
}

// Analisar schema do banco MySQL
{
  "action": "analyze_schema",
  "connection": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "",
    "database": "minha_app"
  }
}
```

---

### session

Gerencia continuidade de sessoes de trabalho entre sessoes de chat com IA. Salva checkpoints do progresso de tarefas para que outra instancia de IA (ou a mesma em uma nova conversa) possa retomar exatamente de onde o trabalho parou.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `action` | enum | Sim | — | `checkpoint`, `resume`, `list`, `close` |
| `session_name` | string | Para `checkpoint` | — | Identificador legivel da sessao |
| `task_description` | string | Para `checkpoint` | — | Descricao em linguagem natural da tarefa |
| `current_status` | string | Nao | — | O que esta sendo feito agora |
| `completed_steps` | string[] | Nao | — | Etapas ja concluidas |
| `pending_steps` | string[] | Nao | — | Etapas restantes |
| `files_involved` | string[] | Nao | — | Arquivos sendo modificados ou analisados |
| `notes` | string | Nao | — | Notas livres, decisoes, contexto |
| `session_id` | string | Para `resume`/`close` | — | UUID da sessao |

**Exemplos:**

```json
// Salvar um checkpoint do trabalho atual
{
  "action": "checkpoint",
  "session_name": "refatorando-modulo-auth",
  "task_description": "Refatorar modulo de autenticacao para usar JWT ao inves de sessoes",
  "current_status": "Implementando logica de refresh de token",
  "completed_steps": [
    "Substituido middleware de sessao por middleware JWT",
    "Atualizado model User com metodos de token",
    "Criada classe TokenService"
  ],
  "pending_steps": [
    "Implementar endpoint de refresh de token",
    "Atualizar todos os testes de auth",
    "Atualizar documentacao da API"
  ],
  "files_involved": [
    "app/Http/Middleware/AuthenticateWithJwt.php",
    "app/Services/TokenService.php",
    "app/Models/User.php"
  ],
  "notes": "Decidido usar algoritmo RS256. Refresh tokens armazenados no banco com expiracao de 30 dias."
}

// Listar sessoes disponiveis
{ "action": "list" }

// Retomar uma sessao anterior
{
  "action": "resume",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}

// Fechar uma sessao concluida
{
  "action": "close",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### export

Gerencia compartilhamento portatil de bancos de dados. Exporte seu banco de dados indexado como um arquivo `.pmap.db` e compartilhe com colegas de equipe. Eles podem importa-lo para ter instantaneamente toda a base de conhecimento sem re-analisar o projeto.

**Parametros:**

| Parametro | Tipo | Obrigatorio | Padrao | Descricao |
|---|---|---|---|---|
| `action` | enum | Sim | — | `export` (criar arquivo compartilhavel), `import` (carregar DB compartilhado), `list` (listar exports) |
| `label` | string | Nao | nome do projeto | Label legivel para o export, usado no nome do arquivo |
| `path` | string | Para `import` | — | Caminho para o arquivo `.pmap.db` a importar |

**Exemplos:**

```json
// Exportar o banco atual para compartilhar
{
  "action": "export",
  "label": "sprint-42-completa"
}

// Importar um banco compartilhado por um colega
{
  "action": "import",
  "path": "/caminho/para/projeto-compartilhado.pmap.db"
}

// Listar exports disponiveis
{ "action": "list" }
```

**Fluxo de compartilhamento:**

1. Voce indexa o projeto: `sync` com `action: "full"`
2. Exporta o banco: `export` com `action: "export"`
3. Envia o arquivo `.pmap.db` para seu colega (Slack, email, drive compartilhado)
4. Colega importa: `export` com `action: "import"` e o caminho do arquivo
5. Colega agora tem todas as entidades, conhecimento, arestas e convencoes — sem re-analise

**Notas:**
- O arquivo exportado e um banco SQLite completo com todos os dados do projeto.
- Caminhos sao armazenados como relativos, entao o banco funciona em qualquer maquina independente da estrutura de diretorios.
- O import valida compatibilidade de schema e cria backup do banco atual antes de substituir.
- Exports sao salvos em `.project-map/exports/` dentro do diretorio do projeto.

---

## Uso via CLI

O Project Map MCP tambem fornece uma interface de linha de comando para operacoes comuns fora do MCP:

```bash
# Inicializar um novo projeto (cria .project-map/ e arquivo de config)
pmap init [caminho]

# Sync incremental (apenas arquivos alterados)
pmap sync

# Re-indexacao completa
pmap sync --full

# Mostrar status do projeto e ultimo snapshot
pmap status

# Buscar entidades e conhecimento
pmap search "PaymentService"

# Exportar banco de dados para compartilhar com a equipe
pmap export "sprint-42"

# Importar banco compartilhado por um colega
pmap import caminho/para/arquivo.pmap.db

# Listar exports disponiveis
pmap exports

# Ajuda
pmap --help
```

Se instalado globalmente ou vinculado via npm, use `pmap` diretamente. Caso contrario:

```bash
node dist/cli/index.js init /caminho/para/projeto
node dist/cli/index.js sync --full
node dist/cli/index.js search "UserController"
node dist/cli/index.js export "minha-label"
node dist/cli/index.js import caminho/para/arquivo.pmap.db
node dist/cli/index.js exports
```

As variaveis de ambiente `PROJECT_MAP_PROJECT_ROOT` e `PROJECT_MAP_DB_PATH` podem sobrescrever a raiz padrao do projeto (diretorio atual) e a localizacao do banco.

---

## Desenvolvimento

### Pre-requisitos

- Node.js >= 18
- npm
- Toolchain de compilacao C++ (para modulos nativos do Tree-sitter)

### Setup

```bash
git clone https://github.com/kerlonfernandes/project-map-mcp.git
cd project-map-mcp
npm install
```

### Scripts

| Script | Descricao |
|---|---|
| `npm run build` | Compilar TypeScript para `dist/` |
| `npm run dev` | Rodar servidor MCP com tsx (sem build) |
| `npm run dev:cli` | Rodar CLI com tsx |
| `npm test` | Rodar todos os testes (vitest) |
| `npm run test:watch` | Rodar testes em modo watch |
| `npm run test:coverage` | Rodar testes com relatorio de cobertura |
| `npm run lint` | Rodar ESLint |
| `npm run lint:fix` | Rodar ESLint com auto-fix |
| `npm run format` | Formatar codigo com Prettier |
| `npm run format:check` | Verificar formatacao do codigo |
| `npm run typecheck` | Verificar tipos sem emitir arquivos |
| `npm run clean` | Remover diretorio `dist/` |

### Estrutura do Projeto

```
src/
  adapter/              # Camada de protocolo MCP (ponto de entrada)
    server.ts           # Setup do McpServer, registro de tools
    tools/              # Handlers individuais de tools
      get-context.ts
      search.ts
      graph.ts
      impact.ts
      record.ts
      sync.ts
      session.ts
      export.ts         # Export/import de bancos de dados portaveis
  analyzer/             # Analise de codigo (Tree-sitter, frameworks)
    core.ts             # Orquestrador do pipeline de analise
    parsers/
      php.ts            # Parser AST de PHP
      javascript.ts     # Parser AST de JavaScript
    frameworks/
      laravel.ts        # Adaptador de framework Laravel
      express.ts        # Adaptador de framework Express.js
    mysql.ts            # Analisador de schema MySQL
  cli/                  # Interface de linha de comando
    index.ts            # Comandos CLI (init, sync, status, search, export, import, exports)
    config.ts           # Carregamento de configuracao
  domain/               # Servicos de dominio (logica de negocio)
    knowledge.ts        # Deteccao de duplicatas, similaridade Jaccard
    conventions.ts      # Deteccao de convencoes
  repository/           # Camada de acesso a dados (SQLite)
    db.ts               # Inicializacao do banco, migrations
    entities.ts         # CRUD de entidades
    evidence.ts         # CRUD de evidencias
    knowledge.ts        # CRUD de registros de conhecimento
    graph.ts            # CRUD de arestas/relacionamentos
    snapshots.ts        # Rastreamento de snapshots
    projects.ts         # Gerenciamento de projetos e repositorios
    cache.ts            # Cache de sessao
    sessions.ts         # CRUD de sessoes de trabalho
    audit.ts            # Log de auditoria
  services/             # Servicos de aplicacao (orquestracao)
    context.ts          # Entrega de contexto com profundidade progressiva
    search.ts           # Busca full-text via FTS5
    graph.ts            # Travessia do grafo de dependencias
    impact.ts           # Analise de impacto de mudancas
    record.ts           # Gerenciamento de registros de conhecimento
    sync.ts             # Sincronizacao de repositorio
    session.ts          # Gerenciamento de sessoes de trabalho
    export.ts           # Export/import de bancos de dados portaveis
  shared/               # Utilitarios e tipos compartilhados
    types.ts            # Todas as interfaces e unioes de tipo TypeScript
    constants.ts        # Constantes globais da aplicacao
    errors.ts           # Hierarquia tipada de erros
    schemas.ts          # Schemas de validacao Zod
    utils.ts            # Funcoes utilitarias (sanitize, hash, etc.)
  index.ts              # Ponto de entrada principal (servidor MCP)

migrations/
  001_initial.sql       # Schema principal (entidades, arestas, conhecimento, etc.)
  002_work_sessions.sql # Sessoes de trabalho e checkpoints
  003_conventions_unique.sql  # Indice unico para convencoes
  004_portable_db.sql   # Tabela db_metadata + paths relativos para portabilidade

test/
  unit/                 # Testes unitarios (funcoes puras, SQLite em memoria)
  integration/          # Testes de integracao (pipeline completo)
```

### Testes

Os testes usam [Vitest](https://vitest.dev/) com SQLite em memoria para isolamento:

```bash
# Rodar todos os testes
npm test

# Rodar arquivo de teste especifico
npx vitest run test/unit/repository/entities.test.ts

# Modo watch para desenvolvimento
npm run test:watch

# Relatorio de cobertura
npm run test:coverage
```

---

## Seguranca

O Project Map MCP trata todo conteudo do repositorio como dados nao confiaveis. As medidas de seguranca incluem:

- **Protecao contra path traversal** — todos os caminhos de arquivo sao validados e resolvidos contra a raiz do projeto. Symlinks que escapam da raiz sao bloqueados.
- **Caminhos bloqueados** — arquivos sensiveis (`.env*`, `*.pem`, `*.key`, etc.) nunca sao lidos. Configuravel via `security.blocked_paths`.
- **Apenas prepared statements** — todo SQL usa queries parametrizadas. Sem interpolacao de strings.
- **Rate limiting** — limite configuravel por minuto para prevenir abuso (padrao: 60 req/min).
- **Seguranca MySQL** — conexoes restritas a hosts permitidos (padrao: apenas localhost). Schemas de sistema sao bloqueados. Apenas consultas de leitura.
- **Log de auditoria** — toda chamada de tool e registrada com operacao, hash de parametros, resumo do resultado, entidades afetadas e duracao.
- **Respostas de erro genericas** — detalhes internos de erro nunca vazam para clientes. Detalhes sao logados apenas no servidor.
- **Sem execucao de codigo** — o Project Map MCP nunca executa codigo do projeto. A analise e puramente estrutural (parsing AST).
- **Sem chamadas de LLM** — toda analise e deterministica. Mesma entrada sempre produz a mesma saida.

---

## Licenca

[MIT](LICENSE)
