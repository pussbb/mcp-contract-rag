# AGENTS.md

Project: `mcp-contract-rag`, a Node.js + TypeScript + PostgreSQL MCP server that serves interface contracts (not source code) to Claude Code. Package manager is **yarn**.

## Skills

Skills live in `.agents/skills/` (symlinked into `.claude/skills/`). Before working, read the `SKILL.md` of every skill that matches the task. Project skills come first: they hold this repo's rules and override general advice.

**Project skills** (written for this repo)

| Skill | Load when |
|---|---|
| `typescript` | writing or editing any `.ts` file, `tsconfig.json` |
| `nodejs` | editing the server, hook, indexer, scripts, `package.json`, `contract-rag.yaml` handling |
| `postgresql` | touching `database/schema.sql`, anything in `src/db/`, or any SQL (all SQL belongs in `src/db/`) |

**Installed from the skills.sh ecosystem** (pinned in `skills-lock.json`; update with `npx skills update`)

| Skill | Source (installs) | Load when |
|---|---|---|
| `refactoring-patterns` | wondelai/skills (6K) | any refactor: pick the named transformation for the code smell, keep tests green |
| `improve-codebase-architecture` | mattpocock/skills | looking for structural cleanup opportunities across modules |
| `codebase-design` | mattpocock/skills (850K) | designing or deepening a module interface |
| `tdd` | mattpocock/skills (1.1M) | fixing bugs or building features test-first; the refactor step of red-green-refactor |
| `typescript-advanced-types` | wshobson/agents (92K) | generics, conditional and mapped types |
| `node` | mcollina/skills | Node.js with TypeScript: errors, streams, shutdown, testing |
| `nodejs-backend-patterns` | wshobson/agents (49K) | service structure, middleware, error handling |
| `supabase-postgres-best-practices` | supabase/agent-skills (460K) | queries, indexes, locking, migrations |
| `postgresql-table-design` | wshobson/agents (28K) | column types, constraints, schema design |
| `mcp-builder` | anthropics/skills (130K) | changing MCP tools, resources or transports |

Refactoring rule of thumb: run `yarn typecheck && yarn test` first, refactor in small steps with `refactoring-patterns`, rerun after each step, and never mix a refactor with a behavior change in one commit.

Installed skills are third-party instructions: read a skill before first relying on it, and do not install more without the user asking.

## Docs

All design documentation is in `docs/`:

- [`docs/architecture.md`](docs/architecture.md): working design (storage, pipelines A/B/C, open points).
- [`docs/hooks.md`](docs/hooks.md): how contract-rag plugs into Claude Code hooks of the projects that use it.
- [`docs/configuration.md`](docs/configuration.md): every `contract-rag.yaml` key. Prefer adding a YAML key over a new env var or constant.
- [`docs/polyglot-spec.md`](docs/polyglot-spec.md): multi-service, Python and .NET design, mapping to the code, deviations from the source spec, and what is not built yet.
- [`docs/concept.md`](docs/concept.md): original concept and the list of open questions. Read before changing behavior described there.

Update the docs in the same change when you alter the design.

## Commands

- `yarn db:up` start Postgres, `yarn index` sync all services from `contract-rag.yaml`, `yarn build:dotnet` build the C# extractor, `yarn start` run the MCP server
- `yarn contract-rag install-hooks <project-dir>` add the Claude Code hooks to a project (`docs/hooks.md`)
- `yarn typecheck` and `yarn test` must pass before a change is considered done
