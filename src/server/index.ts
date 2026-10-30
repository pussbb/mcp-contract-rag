import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createPool, ensureSchema } from '../db/index.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

// stdout carries the MCP protocol: log to stderr only.
const pool = createPool();
await ensureSchema(pool);

// Sent to every client on connect, so agents learn this without the project skill installed.
const INSTRUCTIONS = [
  'This server is a database index of the exported contracts (signatures, JSDoc descriptions, import graph) of the configured codebases. Queries are indexed and return in milliseconds, so use it instead of grep/rg/find/ls for these questions:',
  '- find code by what it does (words from a name or description): match_internal_utilities',
  '- find a file by part of its name or path: find_file; browse a folder: list_files',
  '- find a symbol by exact name: find_symbol; filter by kind (hook, interface, ...): search_by_type',
  '- who imports a file: get_importers; which fields callers read off an export: get_field_usage',
  'It holds contracts, not source or call sites: Read the file once you have its path, and grep only for call sites or non-indexed files.',
].join('\n');

const server = new McpServer({ name: config.server.name, version: '0.1.0' }, { instructions: INSTRUCTIONS });
registerTools(server, pool);
registerResources(server, pool);

// Session management for HTTP transport
const transports = new Map<string, StreamableHTTPServerTransport>();

if (config.server.transport === 'http') {
  // HTTP/Streamable transport with persistent server
  const app = createMcpExpressApp();
  app.post('/mcp', async (req: Request, res: Response) => {
    // Get or create session ID from header
    const sessionId = req.headers['x-mcp-session-id'] as string || randomUUID();

    // Get or create transport for this session
    let transport = transports.get(sessionId);
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
      await server.connect(transport);
      transports.set(sessionId, transport);
    }

    await transport.handleRequest(req, res, req.body);

    // Clean up transport on connection close
    res.on('close', () => {
      // Keep transport alive for potential reconnection, but could add timeout logic here
      // For now, we don't immediately close to support streaming responses
    });
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', activeSessions: transports.size });
  });

  const httpServer = app.listen(config.server.port, () => {
    console.error(`${config.server.name} MCP server ready on HTTP port ${config.server.port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.error('SIGTERM received, shutting down HTTP server...');
    httpServer.close(() => {
      console.error('HTTP server closed');
      pool.end();
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.error('SIGINT received, shutting down HTTP server...');
    httpServer.close(() => {
      console.error('HTTP server closed');
      pool.end();
      process.exit(0);
    });
  });
} else {
  // stdio transport (default)
  await server.connect(new StdioServerTransport());
  console.error(`${config.server.name} MCP server ready on stdio`);
}
