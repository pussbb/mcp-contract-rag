import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { config } from '../config.js';
import { streamAllExports, streamEdges, streamTopExports, streamServiceExports, type Contract } from '../db/index.js';
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
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: await collectText(jsonArray(streamTopExports(pool, config.search.resourceLimit), toManifest)),
          },
        ],
      };
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
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: await collectText(jsonArray(streamServiceExports(pool, decodeURIComponent(service), config.search.resourceLimit), toManifest)),
          },
        ],
      };
    },
  );

  const readAllExports = async (uri: URL, offset: number, limit: number) => {
    const size = Math.min(config.search.maxRows, Math.max(1, limit));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: await collectText(jsonArray(streamAllExports(pool, Math.max(0, offset), size), toManifest)),
        },
      ],
    };
  };

  server.registerResource(
    'all-exports',
    'codebase://exports/all',
    {
      title: 'All exports (first page)',
      description: `First ${config.search.resourceLimit} exports in a stable order. Use codebase://exports/all?offset=N&limit=M for other pages.`,
      mimeType: 'application/json',
    },
    (uri) => readAllExports(uri, 0, config.search.resourceLimit),
  );

  server.registerResource(
    'all-exports-page',
    new ResourceTemplate('codebase://exports/all{?offset,limit}', { list: undefined }),
    {
      title: 'All exports (paged)',
      description: `Page of exports in a stable order. Both offset and limit are required (limit at most ${config.search.maxRows}); a page shorter than limit is the last one.`,
      mimeType: 'application/json',
    },
    (uri, { offset, limit }) => {
      const first = (v: string | string[] | undefined) => Number.parseInt((Array.isArray(v) ? v[0] : v) ?? '', 10);
      return readAllExports(uri, first(offset) || 0, first(limit) || config.search.resourceLimit);
    },
  );

  server.registerResource(
    'dependency-graph',
    'codebase://graph/dependencies',
    {
      title: 'Import dependency graph',
      description: 'File-to-file import edges of every service as [{service, from, to}] (from imports to).',
      mimeType: 'application/json',
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: await collectText(jsonArray(streamEdges(pool, config.search.graphLimit))),
          },
        ],
      };
    },
  );

  server.registerResource(
    'service-dependency-graph',
    new ResourceTemplate('codebase://graph/dependencies/{name}', { list: undefined }),
    {
      title: 'Service import dependency graph',
      description: 'File-to-file import edges of one service as [{service, from, to}].',
      mimeType: 'application/json',
    },
    async (uri, { name }) => {
      const service = Array.isArray(name) ? name[0] : name;
      if (!service) throw new Error('Service name is required');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: await collectText(jsonArray(streamEdges(pool, config.search.graphLimit, decodeURIComponent(service)))),
          },
        ],
      };
    },
  );
}
