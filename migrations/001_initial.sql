-- ============================================================
-- Migration 001: Initial Schema
-- Creates all core tables, indices, FTS5 virtual tables,
-- triggers, and the audit log.
-- ============================================================

-- ============================================================
-- SCHEMA VERSION TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    description TEXT
);

-- ============================================================
-- PROJECTS & REPOSITORIES
-- ============================================================

CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    config_json TEXT DEFAULT '{}'
);

CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    remote_url      TEXT,
    default_branch  TEXT DEFAULT 'main',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(project_id, path)
);

-- ============================================================
-- SNAPSHOTS
-- ============================================================

CREATE TABLE snapshots (
    id                  TEXT PRIMARY KEY,
    repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch_name         TEXT,
    head_commit         TEXT,
    index_tree_hash     TEXT,
    working_tree_hash   TEXT,
    analyzer_version    TEXT NOT NULL,
    status              TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'completed', 'failed', 'partial'
    )),
    files_analyzed      INTEGER DEFAULT 0,
    files_total         INTEGER DEFAULT 0,
    entities_found      INTEGER DEFAULT 0,
    edges_found         INTEGER DEFAULT 0,
    duration_ms         INTEGER,
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    error_message       TEXT
);

CREATE INDEX idx_snapshots_repo_status ON snapshots(repository_id, status);
CREATE INDEX idx_snapshots_commit ON snapshots(head_commit);

-- ============================================================
-- ENTITIES
-- ============================================================

CREATE TABLE entities (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK(entity_type IN (
        'file', 'directory', 'class', 'function', 'interface', 'trait',
        'constant', 'variable', 'route', 'middleware', 'migration',
        'model', 'view', 'event', 'listener', 'job', 'command',
        'config', 'table', 'column', 'index', 'foreign_key',
        'package', 'test', 'factory', 'seeder'
    )),
    scope           TEXT NOT NULL CHECK(scope IN (
        'project', 'module', 'file', 'symbol', 'database', 'external'
    )),
    qualified_name  TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    path            TEXT,
    line_start      INTEGER,
    line_end        INTEGER,
    language        TEXT CHECK(language IN (
        'php', 'javascript', 'sql', 'json', 'yaml', 'markdown', 'other'
    )),
    signature       TEXT,
    metadata_json   TEXT DEFAULT '{}',
    snapshot_id     TEXT NOT NULL REFERENCES snapshots(id),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(repository_id, qualified_name)
);

CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_path ON entities(path);
CREATE INDEX idx_entities_scope ON entities(scope);
CREATE INDEX idx_entities_snapshot ON entities(snapshot_id);

-- ============================================================
-- EVIDENCE
-- ============================================================

CREATE TABLE evidence (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_kind     TEXT NOT NULL CHECK(source_kind IN (
        'code', 'comment', 'docblock', 'config', 'migration',
        'test', 'git_log', 'manual', 'schema'
    )),
    path            TEXT,
    line_start      INTEGER,
    line_end        INTEGER,
    symbol_id       TEXT REFERENCES entities(id),
    content_hash    TEXT,
    snapshot_id     TEXT REFERENCES snapshots(id),
    commit_sha      TEXT,
    excerpt         TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_evidence_path ON evidence(path);
CREATE INDEX idx_evidence_hash ON evidence(content_hash);
CREATE INDEX idx_evidence_snapshot ON evidence(snapshot_id);
CREATE INDEX idx_evidence_symbol ON evidence(symbol_id);

-- ============================================================
-- EDGES (RELATIONSHIP GRAPH)
-- ============================================================

CREATE TABLE edges (
    id                  TEXT PRIMARY KEY,
    repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    edge_type           TEXT NOT NULL CHECK(edge_type IN (
        'imports', 'extends', 'implements', 'uses_trait', 'calls',
        'instantiates', 'references', 'belongs_to', 'has_many',
        'belongs_to_model', 'has_one', 'many_to_many', 'maps_to_table',
        'handles_route', 'dispatches', 'listens_to', 'renders',
        'migrates', 'foreign_key_to', 'depends_on', 'tests'
    )),
    weight              REAL NOT NULL DEFAULT 0.5 CHECK(weight >= 0.0 AND weight <= 1.0),
    resolution_status   TEXT NOT NULL DEFAULT 'resolved' CHECK(resolution_status IN (
        'resolved', 'ambiguous', 'unresolved'
    )),
    evidence_id         TEXT REFERENCES evidence(id),
    snapshot_id         TEXT NOT NULL REFERENCES snapshots(id),
    metadata_json       TEXT DEFAULT '{}',
    UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_type ON edges(edge_type);

-- ============================================================
-- KNOWLEDGE
-- ============================================================

CREATE TABLE knowledge (
    id                  TEXT PRIMARY KEY,
    repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    subject             TEXT NOT NULL,
    knowledge_type      TEXT NOT NULL CHECK(knowledge_type IN (
        'business_rule', 'architectural_decision', 'data_flow',
        'api_contract', 'constraint', 'pattern', 'dependency_note',
        'security_note', 'performance_note', 'todo', 'explanation', 'convention'
    )),
    content             TEXT NOT NULL,
    origin              TEXT NOT NULL CHECK(origin IN (
        'deterministic', 'heuristic', 'ai_generated', 'human_provided'
    )),
    validation_status   TEXT NOT NULL DEFAULT 'unverified' CHECK(validation_status IN (
        'unverified', 'supported_by_code', 'supported_by_tests',
        'human_confirmed', 'disputed', 'superseded', 'invalidated'
    )),
    confidence          REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    validity            TEXT NOT NULL DEFAULT 'current' CHECK(validity IN (
        'current', 'needs_review', 'stale', 'archived'
    )),
    snapshot_id         TEXT REFERENCES snapshots(id),
    supersedes_id       TEXT REFERENCES knowledge(id),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    validated_at        TEXT
);

CREATE INDEX idx_knowledge_type ON knowledge(knowledge_type);
CREATE INDEX idx_knowledge_validity ON knowledge(validity);
CREATE INDEX idx_knowledge_supersedes ON knowledge(supersedes_id);
CREATE INDEX idx_knowledge_subject ON knowledge(subject);

-- M:N junction: knowledge <-> entities
CREATE TABLE knowledge_entities (
    knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY(knowledge_id, entity_id)
);

-- M:N junction: knowledge <-> evidence
CREATE TABLE knowledge_evidence (
    knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    evidence_id  TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    PRIMARY KEY(knowledge_id, evidence_id)
);

-- ============================================================
-- CONVENTIONS
-- ============================================================

CREATE TABLE conventions (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    category        TEXT NOT NULL CHECK(category IN (
        'naming', 'structure', 'pattern', 'config', 'testing', 'documentation'
    )),
    description     TEXT NOT NULL,
    regex_pattern   TEXT,
    confidence      REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
    occurrences     INTEGER NOT NULL DEFAULT 0,
    snapshot_id     TEXT REFERENCES snapshots(id),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- M:N junction: conventions <-> evidence
CREATE TABLE convention_evidence (
    convention_id TEXT NOT NULL REFERENCES conventions(id) ON DELETE CASCADE,
    evidence_id   TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    PRIMARY KEY(convention_id, evidence_id)
);

-- ============================================================
-- SUMMARIES (cached per-module context)
-- ============================================================

CREATE TABLE summaries (
    id                      TEXT PRIMARY KEY,
    repository_id           TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    scope                   TEXT NOT NULL CHECK(scope IN ('project', 'module', 'file')),
    target_path             TEXT NOT NULL,
    depth                   TEXT NOT NULL CHECK(depth IN ('summary', 'structure', 'detail', 'full')),
    content                 TEXT NOT NULL,
    token_count             INTEGER NOT NULL,
    dependency_fingerprint  TEXT,
    snapshot_id             TEXT NOT NULL REFERENCES snapshots(id),
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(repository_id, target_path, depth)
);

CREATE INDEX idx_summaries_scope ON summaries(scope);
CREATE INDEX idx_summaries_target ON summaries(target_path);

-- ============================================================
-- SESSION CACHE
-- ============================================================

CREATE TABLE session_cache (
    session_id  TEXT NOT NULL,
    cache_key   TEXT NOT NULL,
    content     TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at  TEXT,
    PRIMARY KEY(session_id, cache_key)
);

CREATE INDEX idx_session_cache_expires ON session_cache(expires_at);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    operation           TEXT NOT NULL CHECK(operation IN (
        'knowledge_create', 'knowledge_update', 'knowledge_validate',
        'knowledge_invalidate', 'knowledge_dispute',
        'sync_incremental', 'sync_full', 'sync_analyze_schema',
        'entity_create', 'entity_update', 'entity_delete',
        'edge_create', 'edge_delete',
        'convention_create', 'convention_update'
    )),
    tool_name           TEXT NOT NULL,
    parameters_hash     TEXT NOT NULL,
    result_summary      TEXT,
    entities_affected   INTEGER DEFAULT 0,
    duration_ms         INTEGER
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_operation ON audit_log(operation);

-- ============================================================
-- FULL-TEXT SEARCH (FTS5)
-- ============================================================

CREATE VIRTUAL TABLE entities_fts USING fts5(
    qualified_name, display_name, path,
    content=entities, content_rowid=rowid
);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    subject, content,
    content=knowledge, content_rowid=rowid
);

CREATE VIRTUAL TABLE evidence_fts USING fts5(
    excerpt,
    content=evidence, content_rowid=rowid
);

-- ============================================================
-- FTS SYNC TRIGGERS
-- Keep FTS indices in sync with source tables automatically.
-- ============================================================

-- entities → entities_fts
CREATE TRIGGER entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, qualified_name, display_name, path)
    VALUES (new.rowid, new.qualified_name, new.display_name, new.path);
END;

CREATE TRIGGER entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, qualified_name, display_name, path)
    VALUES ('delete', old.rowid, old.qualified_name, old.display_name, old.path);
END;

CREATE TRIGGER entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, qualified_name, display_name, path)
    VALUES ('delete', old.rowid, old.qualified_name, old.display_name, old.path);
    INSERT INTO entities_fts(rowid, qualified_name, display_name, path)
    VALUES (new.rowid, new.qualified_name, new.display_name, new.path);
END;

-- knowledge → knowledge_fts
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, subject, content)
    VALUES (new.rowid, new.subject, new.content);
END;

CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, subject, content)
    VALUES ('delete', old.rowid, old.subject, old.content);
END;

CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, subject, content)
    VALUES ('delete', old.rowid, old.subject, old.content);
    INSERT INTO knowledge_fts(rowid, subject, content)
    VALUES (new.rowid, new.subject, new.content);
END;

-- evidence → evidence_fts
CREATE TRIGGER evidence_ai AFTER INSERT ON evidence BEGIN
    INSERT INTO evidence_fts(rowid, excerpt)
    VALUES (new.rowid, new.excerpt);
END;

CREATE TRIGGER evidence_ad AFTER DELETE ON evidence BEGIN
    INSERT INTO evidence_fts(evidence_fts, rowid, excerpt)
    VALUES ('delete', old.rowid, old.excerpt);
END;

CREATE TRIGGER evidence_au AFTER UPDATE ON evidence BEGIN
    INSERT INTO evidence_fts(evidence_fts, rowid, excerpt)
    VALUES ('delete', old.rowid, old.excerpt);
    INSERT INTO evidence_fts(rowid, excerpt)
    VALUES (new.rowid, new.excerpt);
END;

-- ============================================================
-- Mark this migration as applied
-- ============================================================

INSERT INTO schema_version (version, description)
VALUES (1, 'Initial schema: all core tables, FTS5, triggers, audit log');
