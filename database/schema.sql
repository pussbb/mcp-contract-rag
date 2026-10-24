CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE codebase_files (
    file_path    TEXT PRIMARY KEY,
    file_name    TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE codebase_exports (
    id             SERIAL PRIMARY KEY,
    file_path      TEXT REFERENCES codebase_files(file_path) ON DELETE CASCADE,
    entity_name    TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    signature      TEXT NOT NULL,
    description    TEXT,
    priority_score INT DEFAULT 0,
    CONSTRAINT unique_export_in_file UNIQUE (file_path, entity_name)
);

CREATE TABLE codebase_edges (
    id        SERIAL PRIMARY KEY,
    from_file TEXT REFERENCES codebase_files(file_path) ON DELETE CASCADE,
    to_file   TEXT REFERENCES codebase_files(file_path) ON DELETE CASCADE,
    CONSTRAINT unique_edge UNIQUE (from_file, to_file)
);

CREATE INDEX idx_exports_name_trgm ON codebase_exports USING gin (entity_name gin_trgm_ops);
CREATE INDEX idx_exports_priority ON codebase_exports (priority_score DESC);
CREATE INDEX idx_graph_edges ON codebase_edges (to_file, from_file);
