import { config } from '../config.js';
import { createPool, ensureSchema, recordToolUsage, searchExports, type Contract } from '../db/index.js';
import { syncAll } from '../parser/indexer.js';

/** Hook input as sent by Claude Code on stdin (only the fields used here). */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export const TOOL_PREFIX = 'mcp__contract-rag__';

/** PreToolUse (contract-rag tools): bring the index up to date before the tool reads it. */
export async function syncHook(): Promise<void> {
  const results = await syncAll({ log: (m) => console.error(`[contract-rag sync] ${m}`) });
  for (const s of results) {
    if (s.changed || s.removed) console.error(`[contract-rag sync] ${s.service}: changed=${s.changed} removed=${s.removed}`);
  }
}

/** PostToolUse (contract-rag tools): record the call for `contract-rag usage`. */
export async function usageHook(event: HookEvent): Promise<void> {
  if (!config.usage.enabled || !event.tool_name?.startsWith(TOOL_PREFIX)) return;
  const pool = createPool();
  try {
    await ensureSchema(pool);
    await recordToolUsage(pool, {
      tool: event.tool_name.slice(TOOL_PREFIX.length),
      sessionId: event.session_id,
      input: config.usage.storeInput ? event.tool_input : undefined,
      responseBytes: event.tool_response === undefined ? null : Buffer.byteLength(JSON.stringify(event.tool_response)),
    });
  } finally {
    await pool.end();
  }
}

/** Compact one-line-per-contract text for injection into a prompt. */
export function formatContext(contracts: Contract[], maxChars: number): string {
  const lines = contracts.map((c) => {
    const signature = (c.signature.split('\n')[0] ?? '').slice(0, 160);
    const doc = c.description ? ` // ${c.description.slice(0, 100)}` : '';
    return `- ${c.name} [${c.type}] ${c.service}:${c.path} :: ${signature}${doc}`;
  });
  const text = [
    'contract-rag: existing internal code that may match this request (signatures only, from the index).',
    'Prefer reusing these over writing new code; call match_internal_utilities or list_file_exports for more.',
    ...lines,
  ].join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * UserPromptSubmit: look the prompt up in the index (Tier 1 only, no LLM, so it stays fast) and
 * return text to add to the context, or null when nothing matches well enough.
 */
export async function contextHook(event: HookEvent): Promise<string | null> {
  const { enabled, limit, minRelevance, minPromptChars, maxChars } = config.hooks.context;
  const prompt = event.prompt?.trim() ?? '';
  if (!enabled || prompt.length < minPromptChars || prompt.startsWith('/')) return null;
  const pool = createPool();
  try {
    await ensureSchema(pool);
    const contracts = await searchExports(pool, prompt, limit, undefined, minRelevance);
    return contracts.length ? formatContext(contracts, maxChars) : null;
  } finally {
    await pool.end();
  }
}
