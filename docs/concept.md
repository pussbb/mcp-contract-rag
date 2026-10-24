# Concept: Contract-Based Automated MCP RAG

> Status: **draft concept, not a finished architecture.** Parts of this are undecided or unverified (see [Open questions](#open-questions)). Nothing is implemented yet. The more detailed working design is in [`architecture.md`](./architecture.md).

## Idea

Classic codebase RAG puts raw source files or Markdown chunks into the LLM context. That is slow and burns the token budget.

This project instead exposes a **contract layer**. Raw source (`.ts`, `.tsx`) stays on local disk. The MCP client (Claude Code) only receives **contract manifests** in JSON: exported entities, signatures, parameter types and short descriptions. A small local LLM filters and compresses the candidates before they reach the primary agent.

## Building blocks

1. **Contract-based dynamic JSON resources.** MCP resources such as `codebase://exports/high-priority` are generated from live PostgreSQL queries and returned as JSON. No pre-written Markdown docs.
2. **Local LLM triage layer (LM Studio).** Tool results (e.g. `match_internal_utilities(query: "currency conversion")`) are narrowed from the top 12 database matches to the best 2-3 contracts by a small local model (Qwen 2.5 Coder 3B/7B) at `http://localhost:1234/v1`. If LM Studio is unavailable, the server falls back to the raw priority-ordered rows.
3. **Automated `PreToolUse` sync hook.** Before an MCP tool call, a hook runs `node .claude/hooks/pre-tool-sync.js`. It compares MD5 hashes of workspace files with the database, skips unchanged files, and re-indexes changed ones (Babel AST for exports, `tsconfig-paths` for import resolution).

## Data model (PostgreSQL)

| Table | Holds |
|---|---|
| `codebase_files` | `file_path`, `file_name`, MD5 `content_hash`, `updated_at` |
| `codebase_exports` | per-file exported entities: name, type (`component`/`hook`/`function`/`interface`), `signature`, cleaned JSDoc `description`, `priority_score` |
| `codebase_edges` | import graph: `from_file` (consumer) to `to_file` (provider) |

Full DDL: [`../database/schema.sql`](../database/schema.sql).

## Request flow

```
Claude Code prompt
   -> MCP tool call
   -> PreToolUse hook: hash check, re-index changed files
   -> Tier 1: Postgres keyword match + folder priority (top 12)
   -> Tier 2: LM Studio triage (top 2-3 contracts), fallback to Tier 1 rows
   -> JSON contracts back to Claude Code
```

## Intended benefits

- **Fewer tokens:** only typed interface objects cross the wire, not code blocks. (The "90%+" reduction figure is a hypothesis; measure it.)
- **Local data:** implementation code never leaves the machine; the external model sees contracts only.
- **No manual indexing:** the index is refreshed on tool use.

## Open questions

- **Hook cost:** a full-workspace hash walk on every matching tool call may be slow on large repos. Consider a file-watcher or `git diff`-based change set.
- **Hook config location:** the hook is registered in `.claude/settings.json`; the original draft said `.claude/config.json`. Confirm the matcher scopes it to this server's tools only.
- **Index definition:** the draft `idx_exports_perf` used `entity_name ILIKE` inside a btree index, which is not valid. Needs a trigram (`pg_trgm`) GIN index or full-text search instead.
- **Ranking:** how `priority_score` is computed (folder weights, import fan-in from `codebase_edges`) is not specified.
- **Triage quality:** no evaluation of whether a 3B/7B model drops relevant contracts. Needs a small test set and a recall check.
- **Triage output contract:** the model's response must be schema-constrained JSON, with validation and fallback on malformed output.
- **Scope of parsing:** Babel handles TS/TSX; re-exports, barrel files, default exports and path aliases need explicit handling.
- **Deletions and renames:** the sync must remove rows for files that no longer exist.
- **Concurrency:** two simultaneous hook runs could race on the same transaction; needs locking or a single-writer rule.

## Next steps (not committed to)

- `src/parser/indexer.js`: file crawl, MD5 hashing, Babel export extraction.
- `src/server/resources.js`: dynamic JSON resource handlers.
- `src/triage/`: LM Studio client with fallback.
