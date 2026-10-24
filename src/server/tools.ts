import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { searchExports, streamSymbols, streamFileExports, getImporters, searchByType } from '../db/index.js';
import { triage } from '../triage/lmstudio.js';
import { collectText, jsonArray } from './json-stream.js';
import { toManifest } from './resources.js';

export function registerTools(server: McpServer, pool: pg.Pool): void {
  server.registerTool(
    'match_internal_utilities',
    {
      description:
        'Find existing internal functions, hooks, components and types that match a need, before writing new code. Returns signatures and descriptions only (no source).',
      inputSchema: {
        query: z.string().min(2).describe('What you need, e.g. "currency conversion"'),
        service: z.string().optional().describe('Limit to one indexed service (e.g. a frontend or backend name)'),
      },
    },
    async ({ query, service }) => {
      const candidates = await searchExports(pool, query, config.search.tier1Limit, service);
      const { mode, contracts } = await triage(query, candidates);
      const payload = { query, triage: mode, contracts: contracts.map(toManifest) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    'find_symbol',
    {
      description: 'Find a specific function, component, or type by exact name match',
      inputSchema: {
        name: z.string().describe('Exact symbol name to find'),
        service: z.string().optional().describe('Limit to one indexed service'),
      },
    },
    async ({ name, service }) => {
      const text = await collectText(jsonArray(streamSymbols(pool, name, config.search.maxRows, service), toManifest));
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'list_file_exports',
    {
      description: 'List all exported contracts from a specific file',
      inputSchema: {
        service: z.string().describe('Service name'),
        path: z.string().describe('File path relative to service root'),
      },
    },
    async ({ service, path }) => {
      const text = await collectText(jsonArray(streamFileExports(pool, service, path, config.search.maxRows), toManifest));
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_importers',
    {
      description:
        'Find all files that import a given file (who depends on it). The import graph is file-level, so this does not narrow to a single export.',
      inputSchema: {
        service: z.string().describe('Service name'),
        path: z.string().describe('File path relative to the service root'),
      },
    },
    async ({ service, path }) => {
      const importers = await getImporters(pool, service, path);
      return { content: [{ type: 'text', text: JSON.stringify({ service, path, importers }, null, 2) }] };
    },
  );

  server.registerTool(
    'search_by_type',
    {
      description: 'Search exports by entity type (function, component, hook, interface, type, enum, class, abstract_class, const)',
      inputSchema: {
        type: z.string().describe('Entity type to filter by'),
        query: z.string().optional().describe('Optional keyword search'),
        service: z.string().optional().describe('Limit to one indexed service'),
      },
    },
    async ({ type, query, service }) => {
      const contracts = await searchByType(pool, type, query, service);
      return { content: [{ type: 'text', text: JSON.stringify(contracts.map(toManifest), null, 2) }] };
    },
  );
}
