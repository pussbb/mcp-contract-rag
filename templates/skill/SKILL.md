---
name: contract-rag
description: Look up internal code in the contract-rag index before grepping or writing new code. Use for "who uses X", "where is X defined", "what does this file export", "is there already a helper for Y", and for finding types or hooks by kind. The index is a database, so lookups are far faster than grep, and it searches descriptions as well as names. It holds signatures and the file-level import graph, not source.
---

# contract-rag

The `contract-rag` MCP server indexes the exported interfaces of this codebase (signatures, descriptions, file-level imports). It answers *who uses* and *what exists* questions in one call, where grep needs several. Its tools are deferred: load their schemas first with `ToolSearch` query `select:mcp__contract-rag__list_services,mcp__contract-rag__list_files,mcp__contract-rag__find_file,mcp__contract-rag__find_symbol,mcp__contract-rag__get_importers,mcp__contract-rag__get_dependencies,mcp__contract-rag__get_field_usage,mcp__contract-rag__list_file_exports,mcp__contract-rag__match_internal_utilities,mcp__contract-rag__search_by_type`.

## Indexed services

`service` is the **index name**, not the repo folder name. Valid values here:

{{SERVICES}}

`path` is relative to the service root, exactly as the index returns it (take it from a previous tool result, do not build it by hand). An unknown service returns an error listing the valid names.

## Which tool for which question

| Question | Tool |
|---|---|
| Where is a symbol defined? What is its signature? | `find_symbol` (name only, no service needed) |
| What services are indexed? How big? | `list_services` |
| What is in this folder? What does the project look like? | `list_files` (`service` + optional `prefix`, e.g. a folder; start at the root, then go deeper) |
| Is there a file called roughly X? | `find_file` (part of the name or path, optional `service`) |
| Who imports this file / uses this hook? | `get_importers` (`service` + `path`; get `path` from `find_symbol`) |
| What does this file import? | `get_dependencies` (`service` + `path`) |
| Which fields of an export do callers read? | `get_field_usage` (`service` + `path` + `entity`; get `path` from `find_symbol`) |
| What does this file export? | `list_file_exports` |
| Is there already a helper for X? (before writing new code) | `match_internal_utilities` (free-text need, optional `service`) |
| All hooks / interfaces / enums matching a keyword | `search_by_type` (`type` + optional `query`) |

## Workflow

0. **Start from the index, not the shell.** `match_internal_utilities` searches names, JSDoc descriptions and signatures (find code by what it does, like a semantic grep) and `find_file` searches file names and paths; both are database queries and much faster than `grep`/`find`. Do not run `grep`, `rg`, `find`, `ls` or similar to locate a symbol, a file or the project layout. The tools above already answer it: `list_services` and `list_files` show the structure, `find_file` and `find_symbol` locate a file or symbol, `list_file_exports` shows what a file contains, `search_by_type` and `match_internal_utilities` browse by kind or by need. Start with `list_services` or `list_files` if you do not know the layout yet.
1. **Before writing a new helper, hook or type**, call `match_internal_utilities` with the need in plain words. Reuse a match instead of duplicating it.
2. **For "who uses X"**, run `find_symbol` to get the file, then `get_importers` on it. `usedBy` in the `find_symbol` result is the importer-file count.
3. **Read the source** with Read once you know the file. The index returns contracts, never bodies.

## Limits: when to use grep instead

- The import graph is **file-level**. It does not say which export of a file an importer uses, nor where it is called.
- Field-level data covers destructured or indexed reads of an export's result (`get_field_usage`). There is no call-site data: for "every call of `logout()`" or a field read some other way, use grep.
- Only indexed files appear. Files outside the configured roots, non-exporting files and non-code files (config, docs, assets) are not in the index; use Glob or grep for those.
- The index can trail the repo by a few files until the next sync (it syncs right before each contract-rag tool call). If a count looks low, run grep as a cross-check.
