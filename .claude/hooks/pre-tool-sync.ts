import { syncAll } from '../../src/parser/indexer.js';

// Never block the tool call: any failure is logged to stderr and the hook exits 0.
try {
  const results = await syncAll({ log: (m) => console.error(`[pre-tool-sync] ${m}`) });
  for (const s of results) {
    if (s.changed || s.removed) console.error(`[pre-tool-sync] ${s.service}: changed=${s.changed} removed=${s.removed}`);
  }
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorStack = err instanceof Error ? err.stack : undefined;
  console.error(`[pre-tool-sync] skipped: ${errorMessage}`);
  if (errorStack) console.error(errorStack);
}
process.exit(0);
