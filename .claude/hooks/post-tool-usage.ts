import { config } from '../../src/config.js';
import { createPool, ensureSchema, recordToolUsage } from '../../src/db/index.js';

// PostToolUse: record one row per contract-rag tool call. Never blocks or fails the tool call.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  if (config.usage.enabled) {
    const event = JSON.parse(await readStdin()) as {
      tool_name?: string;
      tool_input?: unknown;
      tool_response?: unknown;
      session_id?: string;
    };
    if (event.tool_name?.startsWith('mcp__contract-rag__')) {
      const pool = createPool();
      try {
        await ensureSchema(pool);
        await recordToolUsage(pool, {
          tool: event.tool_name.replace('mcp__contract-rag__', ''),
          sessionId: event.session_id,
          input: config.usage.storeInput ? event.tool_input : undefined,
          responseBytes: event.tool_response === undefined ? null : Buffer.byteLength(JSON.stringify(event.tool_response)),
        });
      } finally {
        await pool.end();
      }
    }
  }
} catch (err) {
  console.error(`[post-tool-usage] skipped: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
