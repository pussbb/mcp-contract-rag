import type pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

// Sent to every client on connect, so agents learn this without the project skill installed.
const INSTRUCTIONS = [
  'This server is a database index of the exported contracts (signatures, JSDoc descriptions, import graph) of the configured codebases. Queries are indexed and return in milliseconds, so use it instead of grep/rg/find/ls for these questions:',
  '- find code by what it does (words from a name or description): match_internal_utilities',
  '- find a file by part of its name or path: find_file; browse a folder: list_files',
  '- find a symbol by exact name: find_symbol; filter by kind (hook, interface, ...): search_by_type',
  '- who imports a file: get_importers; which fields callers read off an export: get_field_usage',
  'It holds contracts, not source or call sites: Read the file once you have its path, and grep only for call sites or non-indexed files.',
].join('\n');

/** Create an MCP server with the contract-rag tools and resources registered. */
export function createMcpServer(pool: pg.Pool): McpServer {
  const server = new McpServer({ name: config.server.name, version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, pool);
  registerResources(server, pool);
  return server;
}
