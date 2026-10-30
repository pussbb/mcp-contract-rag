# Polyglot extension: services, Python, abstract contracts

Source: the "Polyglot Contract-Based MCP RAG Assistant" specification. This page records what was taken from it, how it maps onto the current TypeScript implementation, and where the original was deliberately not followed.

## What the spec adds

| Spec idea | Where it lives now |
|---|---|
| Composite keys `(service_name, file_path)` so several codebases share one database | `database/schema.sql`: every table has `service_name`; edges and exports reference `codebase_files` by the composite key |
| `language` column on files | `codebase_files.language` (`typescript` / `python`), derived from the file extension |
| Dependency table for third-party packages | `codebase_external_deps (service_name, file_path, package_name, ecosystem)`, `ecosystem` is `npm` or `pypi` |
| TypeScript `abstract class`, inheritance, abstract members in the contract | `src/parser/extract.ts`: `abstract_class` entity type; signature keeps `extends`, constructor, public members and `abstract` modifiers |
| Python class and abstract method extractor (`ABC`, `@abstractmethod`) | `src/parser/python/extract.py`, plus top-level public functions; signatures from `ast.unparse` |
| Vite/tsconfig alias resolution | `src/parser/resolve.ts` via `tsconfig-paths` (the `tsconfig.json` at the service root) |
| Python import resolution | same file: dotted and relative imports resolve to `x.py` or `x/__init__.py`; stdlib modules are dropped |
| `--service=` / `--lang=` CLI args | `yarn index [--service=NAME] [--root=PATH]`; language is per file, so no `--lang` |
| Services configured per project | `contract-rag.yaml` `services:`, see [`configuration.md`](./configuration.md) |
| React, **.NET** and Python services in one store | C# extractor built on Roslyn, see below |
| `PreToolUse` hook with a 15 s timeout | `.claude/settings.json` (scoped to `mcp__contract-rag__.*`), runs `contract-rag hook sync` (`src/hooks/`), which syncs all services and always exits 0; installed into projects by `install-hooks`, see [`hooks.md`](./hooks.md) |
| `match_internal_utilities` with local LLM triage | `src/server/tools.ts` with an optional `service` filter; triage in `src/triage/lmstudio.ts` |
| Dynamic resource `codebase://exports/high-priority` | `src/server/resources.ts` |

## .NET (C#)

`src/parser/dotnet/Extractor/` is a small Roslyn console app (`Microsoft.CodeAnalysis.CSharp`). Like the Python one it reads `{path: source}` on stdin and writes `{path: {exports, imports, references}}`; the Node indexer owns all database writes.

- **Exports**: top-level `class`, `abstract_class`, `interface`, `struct`, `record`, `enum` and `delegate` (not `private`/`file`). The signature is the declaration header (modifiers, generics, base list, constraints) plus public and protected members without bodies: methods, constructors, properties with their accessors, indexers, fields, events. Interface members are all included. Attributes and explicit interface implementations are dropped.
- **Description**: the XML doc `<summary>` with `<see cref>` flattened; `[Obsolete]` adds a `[deprecated]` prefix.
- **Edges**: C# imports are namespaces, so file-to-file edges are type based. File A depends on file B when A mentions a type that B declares and B's namespace is visible to A (a `using`, A's own namespace, or a parent of it). Because one new type can change edges in other files, any C# change re-analyzes all C# files of that service (Roslyn parses thousands of files per second).
- **Packages**: `using` namespaces are mapped to `<PackageReference>` ids from the service's `.csproj` files by longest prefix and stored as `ecosystem = 'nuget'`. `System.*` and in-repo namespaces match nothing.
- **Build**: `yarn build:dotnet`, or automatically on first use (`languages.csharp.autoBuild`). The first build restores NuGet packages and can take minutes, longer than the hook's 15 s timeout; run `yarn build:dotnet` once up front. The hook only ever delays, never blocks, the tool call.

## Data flow

```
contract-rag.yaml -> services[]
  per service:
    crawl (extensions from YAML) -> size+mtime unchanged? skip; else MD5 -> compare with codebase_files
    changed or added/removed files:
      TS  -> Babel AST (in process)
      PY  -> python3 src/parser/python/extract.py (one call, JSON in/out)
      C#  -> dotnet Extractor.dll (Roslyn, one call; all C# files if any changed)
      -> exports, import specifiers
      specifier -> file in same service -> codebase_edges
      specifier -> package             -> codebase_external_deps
      C# type references -> providing file -> codebase_edges
    priority_score = folder weight + 2 per inbound edge (cap 40)
```

All database writes happen in Node, in one transaction per service under an advisory lock. Python never touches the database.

## Deliberate deviations from the spec

| Spec | Problem | Done instead |
|---|---|---|
| `DROP TABLE ... CASCADE` at the top of `schema.sql` | wipes the index every time the schema is applied | `CREATE TABLE IF NOT EXISTS`, idempotent |
| `codebase_edges (from_file, to_file)` without service | two services with `src/index.ts` collide | edges carry `service_name` and are FK-bound to files |
| Hard-coded `'src/'` prefix and `PROJECT_ROOT = ../../src` | only works for one layout | paths are relative to each service `root` |
| Hard-coded DB credentials | secrets in code | `database.url` in YAML, usually `${DATABASE_URL}` |
| `idx_exports_perf ON (entity_name, ...)` for `ILIKE '%x%'` | a btree cannot serve a leading wildcard | `pg_trgm` GIN index on `entity_name` |
| `WHERE entity_name ILIKE $1 OR file_path ILIKE $1` with the raw query as one pattern | "currency conversion" matches nothing | query is tokenized; name, description and signature are scored |
| Tier 1 ordered only by folder `CASE` | no relevance | `relevance * 10 + priority_score` |
| LLM returns free text that is passed on as the answer | model can rewrite or invent signatures | model returns indexes only; contracts are mapped back from DB rows |
| `response.choices.message.content` | bug: `choices` is an array | JSON-schema response and `choices[0]` handling |
| Fallback returns names only | loses the contract | fallback returns the full Tier 1 contracts |
| Indexer deletes nothing when a file disappears | stale rows | removed files are deleted (cascade) |
| Per-file `BEGIN/COMMIT`, files parsed one by one | slow, no cross-process safety | one transaction per service, bulk `unnest` inserts, advisory lock |
| Only `ClassDeclaration` is extracted | functions, hooks, components, types are the main reusable surface | all exported declarations, default exports and `export { a as b }` |
| `.claude/config.json` for the hook | Claude Code reads hooks from `settings.json` | `.claude/settings.json` |
| Python snippet: broken string literal for `contract_sig`, no DB write | does not run | rewritten, outputs JSON, see above |
| Express SSE server with one global transport | a second client replaces the first; SSE transport is deprecated in the MCP SDK | stdio server today (see below) |

## Not implemented yet

- **HTTP transport.** The spec wants a persistent server on port 3001. The server currently speaks stdio, launched by `../_.mcp.json`. Streamable HTTP (one transport per session) is the follow-up if a shared long-running server is needed.
- **Cross-service links.** Edges stay inside one service. Frontend-to-backend API relations are not modelled.
- **Python details.** Imports inside functions are now tracked. Module-level constants and `__all__` are now extracted. Absolute imports resolve from the service root or `src/`.
- **.NET depth.** Nested types (up to depth 3) and extension methods are now indexed. Type references are matched by simple name, so two same-named types in visible namespaces both get an edge. `global using` is not yet tracked.
- **Hook cost.** Unchanged files are skipped by size and mtime without reading them (`sync.mtimePrecheck`); every sync still stats each file. A file watcher would remove that last walk.

## Running it

```
yarn db:up                       # Postgres 18 in docker
$EDITOR contract-rag.yaml        # list your services, see configuration.md
yarn build:dotnet                # once, only if you index C#
yarn index                       # or: yarn index --service=NAME --root=../app
yarn start                       # MCP server on stdio (.mcp.json registers it for Claude Code)
```

The `triage:` section of the YAML (also settable through `LM_STUDIO_URL`, `LM_STUDIO_MODEL`, `TRIAGE_ENABLED` via `${...}`) controls the triage tier; with LM Studio offline the tool returns `"triage": "fallback"` and the ranked database rows.
