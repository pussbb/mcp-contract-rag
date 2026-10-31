CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tables are created in the schema named by `database.schema` in contract-rag.yaml
-- (the connection's search_path points at it), so names here are unqualified.
--
-- Every table is namespaced by service_name so several codebases (TypeScript, Python, ...)
-- can share one database without path collisions.
CREATE TABLE IF NOT EXISTS codebase_files (
    service_name TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language     TEXT NOT NULL,
    size_bytes   BIGINT,
    mtime_ms     BIGINT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT codebase_files_pk PRIMARY KEY (service_name, file_path)
);

CREATE TABLE IF NOT EXISTS codebase_exports (
    id             SERIAL PRIMARY KEY,
    service_name   TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    entity_name    TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    signature      TEXT NOT NULL,
    description    TEXT,
    priority_score INT DEFAULT 0,
    CONSTRAINT unique_export_in_file UNIQUE (service_name, file_path, entity_name),
    CONSTRAINT fk_export_file FOREIGN KEY (service_name, file_path)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE
);

-- Import graph inside one service: from_file (consumer) -> to_file (provider).
CREATE TABLE IF NOT EXISTS codebase_edges (
    id           SERIAL PRIMARY KEY,
    service_name TEXT NOT NULL,
    from_file    TEXT NOT NULL,
    to_file      TEXT NOT NULL,
    CONSTRAINT unique_edge UNIQUE (service_name, from_file, to_file),
    CONSTRAINT fk_edge_from FOREIGN KEY (service_name, from_file)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE,
    CONSTRAINT fk_edge_to FOREIGN KEY (service_name, to_file)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE
);

-- Third-party packages imported by each file (npm for TypeScript, PyPI for Python).
CREATE TABLE IF NOT EXISTS codebase_external_deps (
    id           SERIAL PRIMARY KEY,
    service_name TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    package_name TEXT NOT NULL,
    ecosystem    TEXT NOT NULL,
    CONSTRAINT unique_external_dep UNIQUE (service_name, file_path, package_name),
    CONSTRAINT fk_dep_file FOREIGN KEY (service_name, file_path)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE
);

-- One row per MCP tool call, written by the PostToolUse hook.
CREATE TABLE IF NOT EXISTS codebase_tool_usage (
    id             SERIAL PRIMARY KEY,
    tool_name      TEXT NOT NULL,
    called_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_id     TEXT,
    input          JSONB,
    response_bytes INT
);

CREATE INDEX IF NOT EXISTS idx_exports_name_trgm ON codebase_exports USING gin (entity_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exports_priority ON codebase_exports (priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_graph_edges ON codebase_edges (service_name, to_file, from_file);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON codebase_tool_usage (tool_name, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_deps_pkg ON codebase_external_deps (package_name);

-- Columns added after the first release; no-ops on a fresh database.
ALTER TABLE codebase_files ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE codebase_files ADD COLUMN IF NOT EXISTS mtime_ms BIGINT;
ALTER TABLE codebase_exports ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS codebase_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Field-level usage: how often `importer_path` reads `field_name` off the value of `entity_name`
-- exported by `file_path`. One row per importer, so re-indexing a file replaces only its own rows.
-- The first draft of this table had no importer_path and was never populated; drop it once.
DO $$
BEGIN
    IF to_regclass('codebase_field_usage') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'codebase_field_usage' AND column_name = 'importer_path'
    ) THEN
        DROP TABLE codebase_field_usage;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS codebase_field_usage (
    id            SERIAL PRIMARY KEY,
    service_name  TEXT NOT NULL,
    importer_path TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    entity_name   TEXT NOT NULL,
    field_name    TEXT NOT NULL,
    usage_count   INT NOT NULL DEFAULT 1,
    CONSTRAINT unique_field_usage UNIQUE (service_name, importer_path, file_path, entity_name, field_name),
    CONSTRAINT fk_field_usage_importer FOREIGN KEY (service_name, importer_path)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE,
    CONSTRAINT fk_field_usage_file FOREIGN KEY (service_name, file_path)
        REFERENCES codebase_files (service_name, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_field_usage_entity ON codebase_field_usage (service_name, file_path, entity_name, field_name);

-- Documentation files: Markdown, reStructuredText, and other docs for search
CREATE TABLE IF NOT EXISTS codebase_docs (
    id             SERIAL PRIMARY KEY,
    service_name   TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    file_name      TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    content        TEXT NOT NULL,
    language       TEXT NOT NULL,
    size_bytes     BIGINT,
    mtime_ms       BIGINT,
    folder_multiplier INT DEFAULT 1,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT codebase_docs_pk PRIMARY KEY (service_name, file_path)
);

-- Full-text search on document content
CREATE INDEX IF NOT EXISTS idx_docs_content_tsv ON codebase_docs USING gin (to_tsvector('english', content));

-- Index for searching by file name
CREATE INDEX IF NOT EXISTS idx_docs_name_trgm ON codebase_docs USING gin (file_name gin_trgm_ops);

-- Index for folder multiplier
CREATE INDEX IF NOT EXISTS idx_docs_folder_multiplier ON codebase_docs (folder_multiplier DESC);
