import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from '../config.js';
import { createPool, ensureSchema } from '../db/index.js';
import { createHttpMcpApp } from './http.js';
import { createMcpServer } from './mcp.js';

// stdout carries the MCP protocol: log to stderr only.
const pool = createPool();
await ensureSchema(pool);

if (config.server.transport === 'http') {
  const app = createHttpMcpApp(pool);
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
  const server = createMcpServer(pool);
  await server.connect(new StdioServerTransport());
  console.error(`${config.server.name} MCP server ready on stdio`);
}
