# Architecture: Contract-Based Automated MCP RAG

> Status: **concept**. Nothing here is implemented yet; this is the design the code will follow.

## 1. Paradigm

Classic codebase RAG injects raw source files or Markdown chunks into the context window. That is slow and exhausts token budgets.

This design is a **Contract-Based Graph RAG**. Raw source (`.ts`, `.tsx`) stays on local disk. The MCP client (Claude Code) only sees **contract manifests** (JSON): interface boundaries, parameter types and short descriptions. A local, fast LLM triage layer filters and compresses them before they reach the primary agent.

## 2. Workspace layout

Single lightweight Node.js runtime.

```
mcp-contract-rag/
├── .claude/
│   ├── settings.json          # PreToolUse hook registration
│   └── hooks/pre-tool-sync.js # incremental sync before MCP tool calls
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
| `codebase_files` | One row per source file: path, name, MD5 `content_hash` for incremental skips, `updated_at`. |
| `codebase_exports` | Exported entities: `entity_name`, `entity_type` (component, hook, function, interface), `signature`, cleaned JSDoc `description`, `priority_score` (weight by folder). Unique per `(file_path, entity_name)`. |
| `codebase_edges` | Import graph: `from_file` (consumer) to `to_file` (provider). Unique per pair. |

Indexes: trigram GIN on `entity_name` for case-insensitive keyword lookup, `priority_score DESC`, and `(to_file, from_file)` on edges.

## 4. Pipelines

### A. Pre-tool synchronizer

Index state is kept aligned automatically, with no manual indexing step.

1. A prompt in Claude Code leads to an MCP tool call.
2. A `PreToolUse` hook (in `.claude/settings.json`) runs `node .claude/hooks/pre-tool-sync.js`.
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

- Hook matcher: `PreToolUse` fires per tool call, so the hash pass must stay fast on large trees (consider a file-watcher or mtime pre-check).
- Triage output must be validated as JSON before it is returned; fall back to Tier 1 rows if it is not.
- Decide how `priority_score` is computed (folder weight only, or also inbound edge count).

## 7. Next steps

1. `src/parser/indexer.js`: file crawl and MD5 hashing, then AST extraction.
2. `src/server/resources.js`: dynamic JSON manifests.
