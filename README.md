# mcp-contract-rag

Contract-based Graph RAG MCP server (Node.js + TypeScript + PostgreSQL). Source code stays local; the MCP client receives only JSON interface contracts (name, type, signature, description).

- `database/schema.sql`: files, exports, import edges, external deps (namespaced by `service_name`)
- `contract-rag.yaml`: all configuration (database and PG schema, triage, ranking, ignores, languages, services)
- `src/db/`: all SQL (pool and schema, search queries, sync writes)
- `src/parser/`: crawler, mtime+MD5 incremental skip, Babel AST (TS/JS), Python `ast` and Roslyn (C#) extraction, import resolution
- `src/triage/`: optional LM Studio compression (`http://localhost:1234/v1`), falls back to ranked rows
- `src/server/`: MCP tools `list_services`, `list_files`, `find_file`, `match_internal_utilities`, `find_symbol`, `list_file_exports`, `get_importers`, `get_dependencies`, `get_field_usage`, `search_by_type`; resources `codebase://exports/high-priority`, `codebase://exports/service/{name}`, `codebase://exports/all` (paged with `?offset=&limit=`), `codebase://graph/dependencies[/{service}]`. List results stream from PostgreSQL through a cursor
- `src/hooks/` and `src/cli.ts`: Claude Code hooks (`UserPromptSubmit` context injection, `PreToolUse` sync, `PostToolUse` usage log) and `contract-rag install-hooks <project>` to add them to a project; see `docs/hooks.md`

```
yarn install
yarn db:up
yarn build:dotnet   # only if you index C#
yarn index
yarn typecheck && yarn test
```

Docs: `docs/hooks.md`, `docs/mcp-registration.md`, `docs/configuration.md`, `docs/architecture.md`, `docs/polyglot-spec.md`, `docs/concept.md`. Agent instructions: `AGENTS.md`.
