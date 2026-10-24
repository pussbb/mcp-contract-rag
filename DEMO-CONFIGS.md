# Demo Configuration Files

This directory contains example configuration files for contract-rag.

## Files

### `contract-rag-demo.yaml`
A minimal, simplified configuration for getting started quickly. Use this for:
- Single-project setups
- Quick testing
- Learning the configuration structure

**To use:**
```bash
cp contract-rag-demo.yaml contract-rag.yaml
# Edit contract-rag.yaml to customize
```

### `contract-rag-full-demo.yaml`
A comprehensive example showing all configuration options with a multi-service setup. Use this for:
- Monorepos with multiple services
- Polyglot projects (TypeScript, Python, C#)
- Production-ready configurations

**To use:**
```bash
cp contract-rag-full-demo.yaml contract-rag.yaml
# Edit contract-rag.yaml to customize services and paths
```

## Configuration Overview

### Environment Variables
All string values support `${ENV_VAR}` or `${ENV_VAR:-default}` syntax:
```yaml
database:
  url: ${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/contract_rag}
```

### Key Sections

- **database**: PostgreSQL connection and schema settings
- **triage**: Local LLM configuration for smart contract filtering (optional)
- **search**: Limits for database queries
- **sync**: Optimization settings for file indexing
- **ranking**: Rules for prioritizing exports by folder location and usage
- **ignore**: Files and directories to skip during indexing
- **languages**: Per-language settings (extensions, commands)
- **services**: List of codebases to index with their roots

## Quick Start

1. Start PostgreSQL:
```bash
yarn db:up
```

2. Copy a demo config:
```bash
cp contract-rag-demo.yaml contract-rag.yaml
```

3. Index your code:
```bash
yarn index
```

4. Start the MCP server:
```bash
yarn start
```

## Customization

After copying a demo config, customize these values:

- `services[].name`: Your service name
- `services[].root`: Path to your code (relative to the YAML file)
- `database.schema`: Unique schema name for your project
- `ranking.folderWeights`: Adjust based on your project structure
- `ignore.dirs` / `ignore.files`: Add project-specific exclusions

## Full Documentation

See [`docs/configuration.md`](docs/configuration.md) for complete configuration reference.
