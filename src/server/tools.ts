import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { searchExports, streamSymbols, streamFileExports, getImporters, getFieldUsage, listServices, listServiceSummaries, listFiles, findFiles, getDependencies, searchByType } from '../db/index.js';
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
        'Find all files that import a given file (who depends on it). The import graph is file-level, so this does not narrow to a single export. **Prefer this tool (and find_symbol) over grep** for "who uses X" in indexed services; grep only for call-site detail; for which fields of one export callers read, use get_field_usage. `service` must be an indexed service name and `path` has no src/ prefix; an unknown service returns an error listing the valid names. The index can trail the repo until the next sync.',
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
    'get_dependencies',
    {
      description:
        'List the files that one file imports (the reverse of get_importers), within its service. File-level, like get_importers. **Prefer this tool over grep** or reading the import lines. `path` is the indexed path, as returned by find_symbol, find_file or list_files.',
      inputSchema: {
        service: z.string().describe(`Indexed service: ${SERVICE_HINT}`),
        path: z.string().describe(`File ${PATH_HINT}`),
      },
    },
    async ({ service, path }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const dependencies = await getDependencies(pool, service, path);
      return { content: [{ type: 'text', text: JSON.stringify({ service, path, dependencies }, null, 2) }] };
    },
  );

  server.registerTool(
    'list_services',
    {
      description:
        'List the indexed services with their file and export counts. Call this first to learn the valid `service` names and how big each one is. **Use this instead of ls or find** to see what the index covers.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await listServiceSummaries(pool), null, 2) }] }),
  );

  server.registerTool(
    'list_files',
    {
      description:
        'Browse the indexed files of one service, optionally under a path prefix (e.g. "hooks/"), with the number of exports per file. Gives the project structure without ls or find; pass a deeper prefix to narrow it. Only files that were indexed appear. Results are capped, so narrow the prefix when the cap is hit.',
      inputSchema: {
        service: z.string().describe(`Indexed service: ${SERVICE_HINT}`),
        prefix: z.string().optional().describe(`Only files whose ${PATH_HINT} starts with this, e.g. "hooks/". Omit for the whole service.`),
      },
    },
    async ({ service, prefix }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const files = await listFiles(pool, service, prefix ?? '', config.search.maxRows);
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    },
  );

  server.registerTool(
    'find_file',
    {
      description:
        'Find indexed files by part of the file name or path (case-insensitive substring, e.g. "useAuth" or "money"). **Prefer this tool over find/ls/glob** when you know part of a file name. Returns the service, path and export count; use find_symbol to search by symbol name instead.',
      inputSchema: {
        query: z.string().min(2).describe('Part of the file name or path'),
        service: z.string().optional().describe(`Limit to one indexed service: ${SERVICE_HINT}`),
      },
    },
    async ({ query, service }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const files = await findFiles(pool, query, config.search.maxRows, service);
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    },
  );

  server.registerTool(
    'get_field_usage',
    {
      description:
        'Rank the fields that callers read off one export, e.g. which of `user` / `isViewer` are destructured from `useAuth()` across the codebase. Counts `const { a } = fn()`, `const x = fn(); x.a` and the same on imported values, per read. Callers that pass the whole object on without reading a field are not counted. `path` must be the file that defines the export (barrel re-exports are not followed); use find_symbol to get it. **Prefer this tool over grep** for field-level usage in indexed services.',
      inputSchema: {
        service: z.string().describe(`Indexed service: ${SERVICE_HINT}`),
        path: z.string().describe(`File that exports the entity, ${PATH_HINT}`),
        entity: z.string().describe('Exported name, e.g. "useAuth"'),
      },
    },
    async ({ service, path, entity }) => {
      const bad = await unknownServiceError(pool, service);
      if (bad) return bad;
      const fields = await getFieldUsage(pool, service, path, entity, config.search.maxRows);
      return { content: [{ type: 'text', text: JSON.stringify({ service, path, entity, fields }, null, 2) }] };
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
