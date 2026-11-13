-- 005: Add 'doc' to evidence.source_kind CHECK constraint.
--
-- SQLite cannot alter CHECK constraints in place, so we recreate the table.
-- The triggers must be dropped before the rename and recreated after,
-- otherwise they fire against the renamed table and break.

INSERT INTO schema_version (version, description)
VALUES (5, 'Add doc to evidence source_kind');

-- 1. Drop FTS triggers (they reference 'evidence' by name)
DROP TRIGGER IF EXISTS evidence_ai;
DROP TRIGGER IF EXISTS evidence_ad;
DROP TRIGGER IF EXISTS evidence_au;

-- 2. Drop FTS virtual table
DROP TABLE IF EXISTS evidence_fts;

-- 3. Rename → _old
ALTER TABLE evidence RENAME TO evidence_old;

-- 4. Create new table with updated CHECK
CREATE TABLE evidence (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_kind     TEXT NOT NULL CHECK(source_kind IN (
        'code', 'comment', 'docblock', 'config', 'migration',
        'test', 'git_log', 'manual', 'schema', 'doc'
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

-- 5. Copy data
INSERT INTO evidence SELECT * FROM evidence_old;

-- 6. Drop old table
DROP TABLE evidence_old;

-- 7. Recreate indexes
CREATE INDEX idx_evidence_path ON evidence(path);
CREATE INDEX idx_evidence_hash ON evidence(content_hash);
CREATE INDEX idx_evidence_snapshot ON evidence(snapshot_id);
CREATE INDEX idx_evidence_symbol ON evidence(symbol_id);

-- 8. Recreate FTS
CREATE VIRTUAL TABLE evidence_fts USING fts5(
    excerpt,
    content=evidence, content_rowid=rowid
);

INSERT INTO evidence_fts(rowid, excerpt)
    SELECT rowid, excerpt FROM evidence WHERE excerpt IS NOT NULL;

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
