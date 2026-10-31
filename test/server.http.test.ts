import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { createHttpMcpApp } from '../src/server/http.js';

test('HTTP transport gives each MCP session its own server', async () => {
  const pool = new pg.Pool({ max: 1 });
  const httpServer = createHttpMcpApp(pool).listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');

  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients = [new Client({ name: 'http-test-1', version: '1' }), new Client({ name: 'http-test-2', version: '1' })];
  try {
    await Promise.all(clients.map((client) => client.connect(new StreamableHTTPClientTransport(url))));
    const tools = await Promise.all(clients.map((client) => client.listTools()));
    assert.ok(tools.every((result) => result.tools.some((tool) => tool.name === 'search_documents')));

    const health = await fetch(new URL('/health', url));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).activeSessions, 2);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    httpServer.close();
    await once(httpServer, 'close');
    await pool.end();
  }
});
