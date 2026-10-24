# mcp-contract-rag

Contract-based Graph RAG MCP server. Source code stays local; the MCP client receives only JSON interface contracts (name, type, signature, description) stored in PostgreSQL.

- `database/schema.sql` — files, exports, import-edge tables
- `src/parser/` — crawler, MD5 incremental skip, Babel AST extraction
- `src/triage/` — optional LM Studio (`http://localhost:1234/v1`) compression, falls back to raw ranked rows
- `src/server/` — MCP tools (`match_internal_utilities`) and `codebase://exports/high-priority` resource
- `.claude/hooks/pre-tool-sync.js` — incremental sync before MCP tool calls

Status: scaffold only.
