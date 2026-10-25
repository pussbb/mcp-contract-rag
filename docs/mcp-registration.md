# MCP Server Registration

This guide shows how to register the contract-rag MCP server with Claude Code using either stdio or HTTP transport.

## Option 1: stdio transport (default)

The stdio transport is the simplest and most common for local development. The server is spawned as a subprocess and communicates over stdin/stdout.

### Example `../_.mcp.json` entry

```json
{
  "mcpServers": {
    "contract-rag": {
      "command": "node",
      "args": [
        "/path/to/mcp-contract-rag/node_modules/.bin/tsx",
        "/path/to/mcp-contract-rag/src/cli.ts",
        "serve"
      ],
      "cwd": "/path/to/your-project"
    }
  }
}
```

Or, if you have contract-rag installed globally or in your project's `node_modules`:

```json
{
  "mcpServers": {
    "contract-rag": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/path/to/mcp-contract-rag/src/cli.ts",
        "serve"
      ],
      "cwd": "/path/to/your-project"
    }
  }
}
```

### Registration command

Claude Code can generate this for you:

```bash
cd /path/to/your-project
/path/to/mcp-contract-rag/node_modules/.bin/tsx /path/to/mcp-contract-rag/src/cli.ts install-hooks
```

The `install-hooks` command prints the MCP registration command. Run it once per project:

```bash
claude mcp add contract-rag -- node /path/to/mcp-contract-rag/node_modules/.bin/tsx /path/to/mcp-contract-rag/src/cli.ts serve
```

## Option 2: HTTP transport

HTTP transport is useful when:
- You want a single server instance shared across multiple projects
- You're running in a containerized environment
- You need better separation between the server and client

### 1. Start the server

Configure `contract-rag.yaml` to use HTTP transport:

```yaml
server:
  name: contract-rag
  transport: http
  port: 4000
```

Then start the server:

```bash
# From the contract-rag directory
yarn start
```

The server will listen on `http://localhost:4000/mcp` (or your configured port).

### 2. Example `../_.mcp.json` entry

```json
{
  "mcpServers": {
    "contract-rag": {
      "transport": {
        "type": "http",
        "url": "http://localhost:4000/mcp"
      }
    }
  }
}
```

### 3. Registration command

```bash
claude mcp add contract-rag -- --transport http --url http://localhost:4000/mcp
```

## Configuration

The server reads configuration from `contract-rag.yaml` in the current working directory (`cwd` for stdio, or the server's working directory for HTTP). Key settings:

- `database.url`: PostgreSQL connection string
- `database.schema`: PostgreSQL schema name (default: `contract_rag`)
- `server.name`: MCP server name (default: `contract-rag`)
- `server.transport`: `stdio` or `http` (default: `stdio`)
- `server.port`: Port for HTTP transport (default: `3000`)
- `services[]`: List of codebases to index

See [`configuration.md`](./configuration.md) for all options.

## Database setup

The server requires PostgreSQL. Start it with:

```bash
# From the contract-rag directory
yarn db:up
```

This starts a Docker Compose Postgres instance. The default connection string is:

```
postgres://postgres:postgres@localhost:5432/contract_rag
```

You can override this in `contract-rag.yaml`:

```yaml
database:
  url: ${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/contract_rag}
```

## Initial index

After registration, run the initial index:

```bash
# From your project directory
cd /path/to/your-project
/path/to/mcp-contract-rag/node_modules/.bin/tsx /path/to/mcp-contract-rag/src/cli.ts index
```

Or use the MCP tool `contract-rag_sync` from Claude Code, which is called automatically by the `PreToolUse` hook.

## Hooks integration

The `install-hooks` command also adds Claude Code hooks to your project:

- `UserPromptSubmit`: Automatically injects matching contracts into prompts
- `PreToolUse`: Syncs the index before tool calls
- `PostToolUse`: Records tool usage

These hooks are written to `.claude/settings.json` (or `.claude/settings.local.json` with `--shared` flag). See [`hooks.md`](./hooks.md) for details.

## Troubleshooting

### Server not starting

- Check that Postgres is running: `yarn db:up`
- Verify the database URL in `contract-rag.yaml`
- Check the server logs (stderr for stdio, console output for HTTP)

### Tools not appearing in Claude Code

- Verify the `../_.mcp.json` entry is correct
- Check that the server is running (for HTTP transport)
- Look for errors in Claude Code's MCP server logs

### Index out of date

- Run `contract-rag index` manually
- Or call `contract-rag_sync` from Claude Code
- The `PreToolUse` hook syncs automatically before tool calls

### Hook not injecting context

- Check that hooks are installed in `.claude/settings.json`
- Verify `hooks.context.enabled` is true in `contract-rag.yaml`
- Adjust `hooks.context.minRelevance` if matches are too strict
