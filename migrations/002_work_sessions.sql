-- ============================================================
-- EXPAND AUDIT_LOG OPERATIONS (add session operations)
-- SQLite does not support altering CHECK constraints, so we
-- recreate the table preserving existing data.
-- ============================================================

CREATE TABLE audit_log_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    operation           TEXT NOT NULL CHECK(operation IN (
        'knowledge_create', 'knowledge_update', 'knowledge_validate',
        'knowledge_invalidate', 'knowledge_dispute',
        'knowledge_duplicate_rejected',
        'sync_incremental', 'sync_full', 'sync_analyze_schema',
        'entity_create', 'entity_update', 'entity_delete',
        'edge_create', 'edge_delete',
        'convention_create', 'convention_update',
        'session_checkpoint_create', 'session_checkpoint_update',
        'session_resume', 'session_list', 'session_close'
    )),
    tool_name           TEXT NOT NULL,
    parameters_hash     TEXT NOT NULL,
    result_summary      TEXT,
    entities_affected   INTEGER DEFAULT 0,
    duration_ms         INTEGER
);

INSERT INTO audit_log_new (id, timestamp, operation, tool_name, parameters_hash, result_summary, entities_affected, duration_ms)
SELECT id, timestamp, operation, tool_name, parameters_hash, result_summary, entities_affected, duration_ms
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_operation ON audit_log(operation);

-- ============================================================
-- SESSÕES DE TRABALHO (Continuidade entre sessões de IA)
-- ============================================================

CREATE TABLE work_sessions (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    session_name    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN (
        'in_progress', 'completed', 'abandoned'
    )),
    task_description TEXT NOT NULL,
    current_status  TEXT,
    completed_steps TEXT DEFAULT '[]',
    pending_steps   TEXT DEFAULT '[]',
    files_involved  TEXT DEFAULT '[]',
    notes           TEXT,
    checkpoints_count INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    closed_at       TEXT
);

CREATE INDEX idx_work_sessions_repo ON work_sessions(repository_id);
CREATE INDEX idx_work_sessions_status ON work_sessions(status);

CREATE TABLE work_session_checkpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
    checkpoint_number INTEGER NOT NULL,
    current_status  TEXT,
    completed_steps TEXT DEFAULT '[]',
    pending_steps   TEXT DEFAULT '[]',
    files_involved  TEXT DEFAULT '[]',
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_checkpoints_session ON work_session_checkpoints(session_id);

-- ============================================================
-- Mark this migration as applied
-- ============================================================

INSERT INTO schema_version (version, description)
VALUES (2, 'Work sessions and checkpoints for AI session continuity');
