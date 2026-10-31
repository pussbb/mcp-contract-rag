import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createMcpServer } from './mcp.js';

/** Create the stateful Streamable HTTP endpoint, using one MCP server per session. */
export function createHttpMcpApp(pool: pg.Pool) {
  const app = createMcpExpressApp();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (req: Request, res: Response) => {
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (sessionId && !transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: req.body?.id ?? null,
      });
      return;
    }

    if (!transport) {
      if (req.method !== 'POST' || req.body?.method !== 'initialize') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'A new MCP session must start with an initialize request' },
          id: req.body?.id ?? null,
        });
        return;
      }

      const server = createMcpServer(pool);
      let newTransport: StreamableHTTPServerTransport;
      newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          transports.set(id, newTransport);
        },
      });
      newTransport.onclose = () => {
        const id = newTransport.sessionId;
        if (id && transports.get(id) === newTransport) transports.delete(id);
      };
      await server.connect(newTransport);
      transport = newTransport;
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', activeSessions: transports.size });
  });

  return app;
}
