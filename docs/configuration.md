# Configuration

Everything configurable lives in one YAML file, `contract-rag.yaml`, read from the working directory (override the path with `CONTRACT_RAG_CONFIG`). Every key is optional; defaults are in `src/config.ts` (a zod schema, so a bad value fails at startup with a readable message). The file in the repo root is a complete, commented example.

String values may use `${ENV_VAR}` or `${ENV_VAR:-default}`, so secrets and per-machine values stay out of the file:

```yaml
database:
  url: ${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/contract_rag}
```

## Keys

| Key | Default | Meaning |
|---|---|---|
| `server.name` | `contract-rag` | MCP server name reported to clients |
| `server.transport` | `stdio` | Transport: `stdio` (default) or `http` |
| `server.port` | `3000` | Port for HTTP transport (only used when transport is `http`) |
| `database.url` | local docker Postgres | connection string |
| `database.schema` | `contract_rag` | PostgreSQL schema holding all tables. Created on first use; must be a plain identifier. Use a different schema per environment or project to share one database |
| `database.poolSize` | `4` | pg pool size |
| `triage.enabled` / `url` / `model` / `timeoutMs` / `keep` | on, LM Studio on `:1234`, `local-model`, `8000`, `3` | Tier 2 local LLM; any failure falls back to ranked rows |
| `search.tier1Limit` / `resourceLimit` | `12` / `50` | rows fetched before triage / rows in the high-priority resource |
| `search.maxRows` / `streamBatchSize` | `500` / `100` | SQL `LIMIT` for list-style tools / rows per round trip when streaming from PostgreSQL |
| `search.graphLimit` | `5000` | SQL `LIMIT` for the dependency graph resources |
| `hooks.context.*` | on, 5 contracts, relevance 3, 1500 chars | `UserPromptSubmit` context injection, see [`hooks.md`](./hooks.md) |
| `usage.enabled` / `storeInput` | `true` / `true` | `PostToolUse` hook records tool calls in `codebase_tool_usage`; `storeInput` also keeps the arguments. Read it with `yarn usage` |
| `sync.mtimePrecheck` | `true` | skip reading files whose size and mtime match the stored values |
| `ranking.folderWeights` | utils/helpers 50, extensions/hooks 40, ... | `priority_score` bonus by case-insensitive path fragment, first match wins |
| `ranking.inboundEdgeWeight` / `inboundEdgeCap` | `2` / `40` | bonus per importing file, and its cap |
| `ignore.dirs` / `ignore.files` | build output, VCS, venvs, tests, generated code | directory names and file-name regexes to skip |
| `languages.<lang>.extensions` | ts/tsx/js/jsx/mjs, py, cs | language is chosen per file by extension |
| `languages.python.command` | `python3` | interpreter for the Python extractor |
| `languages.csharp.command` / `autoBuild` | `dotnet` / `true` | .NET SDK and whether the Roslyn extractor is built on first use |
| `services[]` | one service named after the working directory | `name`, `root` (relative to the YAML file), optional `ignoreDirs` |

## What stays outside YAML

- **DDL**: `database/schema.sql` is plain SQL and unqualified; the YAML `database.schema` decides which PostgreSQL schema it lands in (through the connection's `search_path`). `codebase_meta` stores a schema version, and the file, which is idempotent, is re-applied when the version in code is newer.
- **MCP registration**: `../_.mcp.json` (how Claude Code launches the server) and `.claude/settings.json` (the `PreToolUse` hook) are Claude Code files with their own formats.
- **Which tools exist**: tool and resource names are part of the server code.
