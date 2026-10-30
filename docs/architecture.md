# Architecture: Contract-Based Automated MCP RAG

> Status: **first implementation** (Node.js + TypeScript + PostgreSQL). Multi-service and Python support are described in [`polyglot-spec.md`](./polyglot-spec.md), which also lists open gaps. Where this page and that one differ on the schema, `polyglot-spec.md` and `database/schema.sql` win.

## 1. Paradigm

Classic codebase RAG injects raw source files or Markdown chunks into the context window. That is slow and exhausts token budgets.

This design is a **Contract-Based Graph RAG**. Raw source (`.ts`, `.tsx`) stays on local disk. The MCP client (Claude Code) only sees **contract manifests** (JSON): interface boundaries, parameter types and short descriptions. A local, fast LLM triage layer filters and compresses them before they reach the primary agent.

## 2. Workspace layout

Single lightweight Node.js runtime.

```
mcp-contract-rag/
├── .claude/
│   ├── settings.json          # PreToolUse hook registration
│   └── (hooks now live in src/hooks, see hooks.md)
├── database/schema.sql        # PostgreSQL schema
├── docs/architecture.md       # this file
└── src/
    ├── parser/indexer.js      # crawl, MD5 skip, Babel AST extraction
    ├── triage/                # LM Studio client + fallback
    └── server/                # MCP tools + dynamic resources (resources.js)
```

## 3. Storage (PostgreSQL)

See [`database/schema.sql`](../database/schema.sql).

| Table | Purpose |
|---|---|
| `codebase_files` | One row per source file, keyed by `(service_name, file_path)`: name, MD5 `content_hash` for incremental skips, `language`, timestamps. |
| `codebase_exports` | Exported entities: `entity_name`, `entity_type` (component, hook, function, interface), `signature`, cleaned JSDoc `description`, `priority_score` (weight by folder). Unique per `(service_name, file_path, entity_name)`. |
| `codebase_edges` | Import graph inside a service: `from_file` (consumer) to `to_file` (provider). |
| `codebase_external_deps` | Third-party packages (`npm` / `pypi`) imported per file. |
| `codebase_field_usage` | Per `(service_name, importer_path, file_path, entity_name, field_name)` a `usage_count`: how often the importer reads a field off the value of an imported export (`const { isViewer } = useAuth()`, `const a = useAuth(); a.user`). `file_path` is the file the import specifier resolves to, so a barrel re-export is not followed. Default exports are stored under `entity_name = 'default'` and matched through `codebase_exports.is_default`. Rows go with their importer on re-index (FK cascade). Feeds the `get_field_usage` tool (ranked fields, or with `field` the reader files), the `find_symbol` fallback that lists `fieldOwners` when the name is a field and not an export, and `ranking.fieldUsageWeight`. Scopes are ignored, and callers that pass the whole object on are not counted. |

Indexes: trigram GIN on `entity_name` for case-insensitive keyword lookup, `priority_score DESC`, and `(to_file, from_file)` on edges.

## 4. Pipelines

### A. Pre-tool synchronizer

Index state is kept aligned automatically, with no manual indexing step.

1. A prompt in Claude Code leads to an MCP tool call.
2. A `PreToolUse` hook (installed into the project's Claude Code settings by `contract-rag install-hooks`, see [`hooks.md`](./hooks.md)) runs `contract-rag hook sync`.
3. The hook walks the workspace and compares each file's MD5 with `codebase_files`. Unchanged files are skipped.
4. For changed files, Babel parses the AST and extracts exported interfaces. Imports are resolved through `tsconfig-paths`, and one transaction updates PostgreSQL.

### B. Local LLM triage and context compression

For a call such as `match_internal_utilities(query: "currency conversion")`:

1. **Tier 1, database scan.** Keyword match over code definitions. A `CASE WHEN` boosts local utility layers (`/utils/`, `/hooks/`). Return the top 12 rows.
2. **Tier 2, compression.** The rows go to LM Studio (`http://localhost:1234/v1`) running a small local model (Qwen 2.5 Coder 3B/7B), which reads the signatures and descriptions.
3. **Contract return.** The model drops noise, stale interfaces and incompatible utilities, and returns the top 2-3 contracts to Claude Code.
4. **Fallback.** If LM Studio is offline or out of memory, skip triage and return the raw, priority-ordered rows. The call never fails because of the LLM.

### C. Dynamic JSON resources

Instead of static Markdown docs, the server exposes MCP resources such as `codebase://exports/high-priority`. Each read runs a live PostgreSQL query and returns a JSON manifest of interfaces.

## 5. Intended benefits

- **Token reduction:** only typed interface objects are sent, never code bodies (target 90%+ vs. raw files).
- **Local data:** implementation source never leaves the machine; external models only see contracts.
- **Automatic freshness:** the hook keeps the graph current on every prompt.

## 6. Open points

Resolved:

- Hook cost: size+mtime pre-check skips reading unchanged files (`sync.mtimePrecheck`). A file watcher would remove the remaining stat walk.
- Triage output is validated; the model returns indexes only and any failure falls back to the Tier 1 rows.
- `priority_score` = folder weight + per-importer bonus (capped) + optional field-usage bonus (capped, off by default), all set in YAML (`ranking:`). The field-usage bonus is a correlated subquery in `recomputePriority`: Postgres rejects a `FROM`-clause join that references the `UPDATE` target, and that error rolls back the whole sync transaction, leaving the index empty.
- Python extraction now includes module-level constants, `__all__` support, and function-level imports.
- C# extraction now includes nested types (up to depth 3) and extension method detection.

Still open: HTTP transport, cross-service edges, C# `global using`. See [`polyglot-spec.md`](./polyglot-spec.md).

## 7. Configuration

All tunables, including the PostgreSQL schema name, are in `contract-rag.yaml`: [`configuration.md`](./configuration.md).
