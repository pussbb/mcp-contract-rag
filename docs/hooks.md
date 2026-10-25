# Claude Code hooks: integrating contract-rag into a project

contract-rag is installed once and used from the projects you want to index. Claude Code hooks are how it plugs into those projects' sessions without anyone remembering to call it. The hooks are not part of this repository's own workflow; `contract-rag install-hooks` adds them to the project that uses contract-rag.

```
cd /path/to/my-project
/path/to/mcp-contract-rag/node_modules/.bin/tsx /path/to/mcp-contract-rag/src/cli.ts install-hooks
claude mcp add contract-rag -- ...        # the command install-hooks prints
```

Or from this checkout: `yarn contract-rag install-hooks /path/to/my-project`. Use `--shared` to write the committed `.claude/settings.json` instead of the untracked `.claude/settings.local.json` (the default, because the commands contain absolute paths to this checkout). `uninstall-hooks` removes only the entries it added. Both are idempotent and leave your other settings and hooks alone.

Also run `contract-rag install-skill [dir]` (or `yarn install-skill /path/to/my-project`) to write `.claude/skills/contract-rag/SKILL.md` into the project. It comes from `templates/skill/SKILL.md`, lists the project's indexed service names, and tells agents when to use the tools instead of grep. Re-run it after changing `services` in `contract-rag.yaml`.

For detailed MCP server registration examples (stdio and HTTP transport), see [`mcp-registration.md`](./mcp-registration.md).

The project needs a database (`database.url`) and, optionally, its own `contract-rag.yaml` in its root. Without one, the project directory is indexed as a single service named after the folder.

## What the hooks do

| Event | Matcher | Handler | Effect |
|---|---|---|---|
| `UserPromptSubmit` | all prompts | `hook context` | Looks the prompt up in the index and adds the best matching contracts (name, kind, location, one-line signature, summary) to Claude's context **before** it starts, so it reuses existing code without having to think of calling the MCP tool. Silent when nothing matches well enough |
| `PreToolUse` | `mcp__contract-rag__.*` | `hook sync` | Brings the index up to date (size/mtime pre-check, then MD5) right before a contract-rag tool reads it |
| `PostToolUse` | `mcp__contract-rag__.*` | `hook usage` | Records the call in `codebase_tool_usage`; `contract-rag usage` summarizes it |

### The context hook

- **Tier 1 only.** It uses the PostgreSQL keyword search and never calls the local LLM, so it adds roughly a third of a second to a prompt. The LLM triage stays in the explicit `match_internal_utilities` tool.
- **Precision over recall.** Only contracts scoring at least `hooks.context.minRelevance` (default 3: a word of the prompt appears in an entity *name*) are injected, at most `limit` (5), at most `maxChars` (1500). Filler words ("add", "fix", "function", ...) are ignored. Slash commands and very short prompts are skipped.
- **Not synced first.** It reads the index as it is; the sync happens at the next contract-rag tool call. Run `contract-rag index` (or let a tool call do it) after large changes.
- **Output.** `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` on stdout, which Claude Code adds to the prompt context.

### Safety

Every handler catches all errors, writes them to stderr and exits 0, so a down database or a missing extractor never blocks a prompt or a tool call. The sync hook has a 15 s timeout; build the C# extractor ahead of time (`yarn build:dotnet`) so the first sync is not slow.

## Settings

Hook behavior is configured in the project's `contract-rag.yaml`, see [`configuration.md`](./configuration.md) (`hooks.context.*`, `usage.*`, `sync.*`).

## Ideas not built

- A `PreToolUse` check on `Write`/`Edit` that warns when a new export duplicates an indexed one.
- A `SessionStart` hook that runs the sync once and injects a short per-service summary.
- Running the context hook through the local LLM triage when the extra latency is acceptable.
