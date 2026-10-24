---
name: postgresql
description: PostgreSQL conventions for this repo (pg driver, configurable schema, idempotent DDL, indexing, transactions, advisory locks). Load when touching database/schema.sql, src/db.ts, or any SQL.
---

# PostgreSQL in this repo

- **All SQL lives in `src/db/`** (`pool.ts` connection and schema, `search.ts` read queries for the MCP tools, `sync.ts` writes for the indexer). Other modules call those functions and never run `query()` themselves. Add new SQL there and export it from `src/db/index.ts`.
- Driver: `pg` (`Pool`). Connection and schema name come from `database.url` / `database.schema` in `contract-rag.yaml`. Local DB: `yarn db:up` (docker compose, Postgres 18).
- Tables live in the PostgreSQL schema named by `database.schema`; the pool sets `search_path`, so SQL uses **unqualified** table names. The name is validated as a plain identifier before it is ever interpolated.
- `database/schema.sql` must stay **idempotent** (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). When you change it, bump `SCHEMA_VERSION` in `src/db/pool.ts`; `ensureSchema()` re-applies the file when `codebase_meta` holds an older version.
- Tables: `codebase_files` (PK `(service_name, file_path)`, MD5 `content_hash`, `size_bytes`, `mtime_ms`), `codebase_exports`, `codebase_edges`, `codebase_external_deps`, `codebase_meta`. Everything is keyed by `service_name` and cascades from `codebase_files`.
- Always use parameterized queries (`$1`, `$2`). Never interpolate user or query text into SQL. Constant fragments built in code (e.g. the `CASE` for folder weights) still pass values as parameters.
- Bulk writes use `INSERT ... SELECT * FROM unnest($1::text[], $2::text[])` with one array per column, not per-row inserts.
- Keyword search uses `ILIKE '%token%'`; escape `%`, `_` and `\` in tokens. A `pg_trgm` GIN index on `entity_name` backs it. `ILIKE` is not valid inside a btree index definition.
- The sync runs in one transaction guarded by `pg_advisory_xact_lock` so concurrent hook runs serialize. Keep new write paths inside that transaction.
- `priority_score` = folder weight + per-importer bonus (capped), from `ranking:` in the YAML; recomputed only after a sync that changed something.
- Release pool clients in `finally`; end a pool you created yourself.

For general Postgres guidance also load `supabase-postgres-best-practices` (queries, indexes, locking) and `postgresql-table-design` (types, constraints).
