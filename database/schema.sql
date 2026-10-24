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

CREATE INDEX IF NOT EXISTS idx_exports_name_trgm ON codebase_exports USING gin (entity_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exports_priority ON codebase_exports (priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_graph_edges ON codebase_edges (service_name, to_file, from_file);
CREATE INDEX IF NOT EXISTS idx_external_deps_pkg ON codebase_external_deps (package_name);

-- Columns added after the first release; no-ops on a fresh database.
ALTER TABLE codebase_files ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE codebase_files ADD COLUMN IF NOT EXISTS mtime_ms BIGINT;

CREATE TABLE IF NOT EXISTS codebase_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
