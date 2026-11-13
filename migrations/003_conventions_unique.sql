-- Migration 003: Add unique index on conventions for upsert support.
-- Convention detection needs to update existing conventions per category+description.

CREATE UNIQUE INDEX IF NOT EXISTS idx_conventions_repo_cat_desc
    ON conventions(repository_id, category, description);

INSERT INTO schema_version (version, description)
VALUES (3, 'Add unique index on conventions for upsert');
