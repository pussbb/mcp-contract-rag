import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { searchExports } from '../db/index.js';
import { triage } from '../triage/lmstudio.js';
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
}
