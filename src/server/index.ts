import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPool, ensureSchema } from '../db/index.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

// stdout carries the MCP protocol: log to stderr only.
const pool = createPool();
await ensureSchema(pool);

const server = new McpServer({ name: 'contract-rag', version: '0.1.0' });
registerTools(server, pool);
registerResources(server, pool);
await server.connect(new StdioServerTransport());
console.error('contract-rag MCP server ready');
