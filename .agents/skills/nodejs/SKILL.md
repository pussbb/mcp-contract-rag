---
name: nodejs
description: Node.js runtime conventions for this repo (ESM, yarn, YAML config, out-of-process extractors, MCP stdio server, Claude Code hooks, fetch with timeouts). Load when editing the server, hook, indexer, or package scripts.
---

# Node.js in this repo

- Package manager: **yarn** (v1). Use `yarn add`, `yarn add -D`, `yarn <script>`. Never create `package-lock.json`. Commit `yarn.lock`.
- ESM only (`"type": "module"`). Use `node:` prefixes for built-ins (`node:fs/promises`, `node:path`).
- Scripts: `yarn build:dotnet` (C# extractor), `yarn index` (sync the DB), `yarn start` (MCP server over stdio), `yarn typecheck`, `yarn test` (`node:test` via tsx).
- **MCP stdio server: stdout is the protocol channel.** Never `console.log` in server or hook code; log to stderr (`console.error`).
- Configuration comes from `contract-rag.yaml`, parsed and validated (zod) in `src/config.ts` only; values may use `${ENV:-default}`. Add new settings as YAML keys with a default in the schema and document them in `docs/configuration.md`. Do not read `process.env` elsewhere.
- Languages are separate extractors behind one `{path: source}` -> `{path: {exports, imports}}` JSON contract: TypeScript in process, Python (`src/parser/python/extract.py`) and C# (`src/parser/dotnet/Extractor`, Roslyn) out of process via `src/parser/external.ts`. Only Node writes to the database.
- The `PreToolUse` hook (`.claude/hooks/pre-tool-sync.ts`) must **never block a tool call**: catch everything, log to stderr, exit 0. It must close its pool.
- Network calls (LM Studio at `http://localhost:1234/v1`) use global `fetch` with an `AbortSignal.timeout(...)`. Any failure falls back to raw Tier 1 rows; the tool call must not fail because of the LLM.
- Validate anything that comes from the LLM (parse JSON, check ids are integers within range) before use; map ids back to real DB rows instead of trusting model-written contract text.
- Files are keyed by posix-style relative paths from the service `root`.

For MCP server design (tool naming, schemas, transports) load `mcp-builder`; for general Node patterns, `node` and `nodejs-backend-patterns`.
