import { createPool, ensureSchema, usageSummary } from './db/index.js';

const pool = createPool();
try {
  await ensureSchema(pool);
  const rows = await usageSummary(pool);
  if (!rows.length) console.log('No tool calls recorded yet.');
  else console.table(rows.map((r) => ({ tool: r.tool, calls: r.calls, avgResponseBytes: r.avgResponseBytes, lastCalledAt: r.lastCalledAt.toISOString() })));
} finally {
  await pool.end();
}
