---
name: contract-rag
description: Look up internal code in the contract-rag index before grepping or writing new code. Use for "who uses X", "where is X defined", "what does this file export", "is there already a helper for Y", and for finding types or hooks by kind. The index holds signatures and the file-level import graph, not source.
---

# contract-rag

The `contract-rag` MCP server indexes the exported interfaces of this codebase (signatures, descriptions, file-level imports). It answers *who uses* and *what exists* questions in one call, where grep needs several. Its tools are deferred: load their schemas first with `ToolSearch` query `select:mcp__contract-rag__find_symbol,mcp__contract-rag__get_importers,mcp__contract-rag__list_file_exports,mcp__contract-rag__match_internal_utilities,mcp__contract-rag__search_by_type`.

## Indexed services

`service` is the **index name**, not the repo folder name. Valid values here:

{{SERVICES}}

`path` is relative to the service root, with no `src/` prefix (`hooks/useAuth.ts`). An unknown service returns an error listing the valid names.

## Which tool for which question

| Question | Tool |
|---|---|
| Where is `useAuth` defined? What is its signature? | `find_symbol` (name only, no service needed) |
| Who imports this file / uses this hook? | `get_importers` (`service` + `path`; get `path` from `find_symbol`) |
| What does this file export? | `list_file_exports` |
| Is there already a helper for X? (before writing new code) | `match_internal_utilities` (free-text need, optional `service`) |
| All hooks / interfaces / enums matching a keyword | `search_by_type` (`type` + optional `query`) |

## Workflow

1. **Before writing a new helper, hook or type**, call `match_internal_utilities` with the need in plain words. Reuse a match instead of duplicating it.
2. **For "who uses X"**, run `find_symbol` to get the file, then `get_importers` on it. `usedBy` in the `find_symbol` result is the importer-file count.
3. **Read the source** with Read once you know the file. The index returns contracts, never bodies.

## Limits: when to use grep instead

- The import graph is **file-level**. It does not say which export of a file an importer uses, nor where it is called.
- There is no field-level or call-site data. For "which properties of `user` are read" or "every call of `logout()`", use grep.
- The index can trail the repo by a few files until the next sync (it syncs right before each contract-rag tool call). If a count looks low, run grep as a cross-check.
