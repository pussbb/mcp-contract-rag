import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { config } from '../config.js';
import { streamTopExports, streamServiceExports, type Contract } from '../db/index.js';
import { collectText, jsonArray } from './json-stream.js';

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
      const text = await collectText(jsonArray(streamTopExports(pool, config.search.resourceLimit), toManifest));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );

  server.registerResource(
    'service-exports',
    new ResourceTemplate('codebase://exports/service/{name}', { list: undefined }),
    {
      title: 'Service exports',
      description: 'Exports of one indexed service, ranked by priority',
      mimeType: 'application/json',
    },
    async (uri, { name }) => {
      const service = Array.isArray(name) ? name[0] : name;
      if (!service) throw new Error('Service name is required');
      const text = await collectText(jsonArray(streamServiceExports(pool, decodeURIComponent(service), config.search.resourceLimit), toManifest));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );
}
