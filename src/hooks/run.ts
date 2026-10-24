import { contextHook, syncHook, usageHook, type HookEvent } from './handlers.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readEvent(): Promise<HookEvent> {
  const raw = await readStdin();
  return raw.trim() ? (JSON.parse(raw) as HookEvent) : {};
}

/**
 * Entry for `contract-rag hook <name>`. A hook must never break the user's session: every
 * failure is logged to stderr and the process still exits 0.
 */
export async function runHook(name: string | undefined): Promise<void> {
  try {
    switch (name) {
      case 'sync':
        await syncHook();
        break;
      case 'usage':
        await usageHook(await readEvent());
        break;
      case 'context': {
        const additionalContext = await contextHook(await readEvent());
        if (additionalContext) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
        }
        break;
      }
      default:
        console.error(`[contract-rag] unknown hook: ${name ?? '(none)'}`);
    }
  } catch (err) {
    console.error(`[contract-rag ${name}] skipped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  process.exit(0);
}
