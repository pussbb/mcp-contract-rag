import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { config } from '../config.js';
import { topExports, type Contract } from '../db/index.js';

export function toManifest(c: Contract) {
  return {
    service: c.service,
    language: c.language,
    path: c.path,
    name: c.name,
    type: c.type,
    signature: c.signature,
    description: c.description,
    usedBy: c.usedBy,
  };
}

export function registerResources(server: McpServer, pool: pg.Pool): void {
  server.registerResource(
    'high-priority-exports',
    'codebase://exports/high-priority',
    {
      title: 'High-priority exports',
      description: 'Top contracts ranked by folder weight and inbound imports, generated from PostgreSQL on each read.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = await topExports(pool, config.search.resourceLimit);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rows.map(toManifest), null, 2) }],
      };
    },
  );
}
