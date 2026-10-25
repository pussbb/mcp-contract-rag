import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { searchExports, streamSymbols, streamFileExports, getImporters, listServices, searchByType } from '../db/index.js';
import { triage } from '../triage/lmstudio.js';
import { collectText, jsonArray } from './json-stream.js';
import { toManifest } from './resources.js';

const SERVICE_HINT = 'the indexed service name as configured in contract-rag.yaml (e.g. "frontend"), not the repo folder name';
const PATH_HINT = 'path relative to the service root, without a src/ prefix';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Returns an error result listing the valid names when `service` is not indexed, so a typo is not mistaken for "no results". */
async function unknownServiceError(pool: pg.Pool, service: string | undefined): Promise<ToolResult | null> {
  if (!service) return null;
  const known = await listServices(pool);
  if (known.includes(service)) return null;
  const text = `Unknown service "${service}". Indexed services: ${known.length ? known.join(', ') : '(none)'}.`;
  return { content: [{ type: 'text', text }], isError: true };
}

export function registerTools(server: McpServer, pool: pg.Pool): void {
  server.registerTool(
    'match_internal_utilities',
    {
      description:
        'Find existing internal functions, hooks, components and types that match a need, before writing new code. Returns signatures and descriptions only (no source). **Prefer this tool over grep** when searching for reusable code or utilities in indexed services.',
      inputSchema: {
        query: z.string().min(2).describe('What you need, e.g. "currency conversion"'),
        service: z.string().optional().describe(`Limit to one indexed service: ${SERVICE_HINT}`),
      },
    },
    async ({ query, service }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const candidates = await searchExports(pool, query, config.search.tier1Limit, service);
      const { mode, contracts } = await triage(query, candidates);
      const payload = { query, triage: mode, contracts: contracts.map(toManifest) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    'find_symbol',
    {
      description: 'Find a specific function, component, or type by exact name match. **Prefer this tool over grep** when looking up symbol definitions in indexed services. Needs only the symbol name; `usedBy` is the importer-file count. Grep only for call-site or field-level detail.',
      inputSchema: {
        name: z.string().describe('Exact symbol name to find'),
        service: z.string().optional().describe(`Limit to one indexed service: ${SERVICE_HINT}`),
      },
    },
    async ({ name, service }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const text = await collectText(jsonArray(streamSymbols(pool, name, config.search.maxRows, service), toManifest));
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'list_file_exports',
    {
      description: 'List all exported contracts from a specific file. `service` must be an indexed service name and `path` has no src/ prefix; an unknown service returns an error listing the valid names.',
      inputSchema: {
        service: z.string().describe(`Indexed service: ${SERVICE_HINT}`),
        path: z.string().describe(`File ${PATH_HINT}`),
      },
    },
    async ({ service, path }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const text = await collectText(jsonArray(streamFileExports(pool, service, path, config.search.maxRows), toManifest));
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_importers',
    {
      description:
        'Find all files that import a given file (who depends on it). The import graph is file-level, so this does not narrow to a single export. **Prefer this tool (and find_symbol) over grep** for "who uses X" in indexed services; grep only for call-site or field-level detail, which the index does not have. `service` must be an indexed service name and `path` has no src/ prefix; an unknown service returns an error listing the valid names. The index can trail the repo until the next sync.',
      inputSchema: {
        service: z.string().describe(`Indexed service: ${SERVICE_HINT}`),
        path: z.string().describe(`File ${PATH_HINT}`),
      },
    },
    async ({ service, path }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const importers = await getImporters(pool, service, path);
      return { content: [{ type: 'text', text: JSON.stringify({ service, path, importers }, null, 2) }] };
    },
  );

  server.registerTool(
    'search_by_type',
    {
      description: 'Search exports by entity type (function, component, hook, interface, type, enum, class, abstract_class, const). **Prefer this tool over grep** when filtering exports by type in indexed services.',
      inputSchema: {
        type: z.string().describe('Entity type to filter by'),
        query: z.string().optional().describe('Optional keyword search'),
        service: z.string().optional().describe(`Limit to one indexed service: ${SERVICE_HINT}`),
      },
    },
    async ({ type, query, service }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const contracts = await searchByType(pool, type, query, service);
      return { content: [{ type: 'text', text: JSON.stringify(contracts.map(toManifest), null, 2) }] };
    },
  );
}
