-- ============================================================
-- Migration 004: Portable Database
--
-- Makes the database shareable across machines by:
-- 1. Adding a db_metadata table for export/import tracking.
-- 2. Converting projects.root_path and repositories.path from
--    absolute to relative paths ('.').
--
-- After this migration, all project/repo paths are stored as '.'
-- (relative to where the database file lives). The application
-- resolves them to absolute paths at runtime using the
-- PROJECT_MAP_PROJECT_ROOT environment variable.
-- ============================================================

-- ============================================================
-- DATABASE METADATA (key-value store for portability info)
-- ============================================================

CREATE TABLE IF NOT EXISTS db_metadata (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Seed with initial metadata
INSERT OR IGNORE INTO db_metadata (key, value) VALUES
    ('format_version', '1'),
    ('created_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    ('schema_version', '4'),
    ('portable', 'true');

-- ============================================================
-- CONVERT ABSOLUTE PATHS TO RELATIVE
-- ============================================================

-- Projects: root_path becomes '.'
UPDATE projects SET root_path = '.';

-- Repositories: path becomes '.'
UPDATE repositories SET path = '.';

-- ============================================================
-- Mark this migration as applied
-- ============================================================

INSERT INTO schema_version (version, description)
VALUES (4, 'Portable database: db_metadata table, relative paths');
