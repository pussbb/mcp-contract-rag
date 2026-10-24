import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Analysis } from './extract.js';

const exec = promisify(execFile);

export type ExtractorResult = Analysis & { error?: string };

/**
 * Runs an out-of-process extractor: sends {path: source} as JSON on stdin and reads
 * {path: {exports, imports, ...} | {error}} from stdout. One process handles all files.
 */
export async function runExtractor(command: string, args: string[], files: Record<string, string>): Promise<Record<string, ExtractorResult>> {
  try {
    const child = exec(command, args, { maxBuffer: 512 * 1024 * 1024 });
    child.child.stdin!.end(JSON.stringify(files));
    const result = await child;
    return JSON.parse(result.stdout) as Record<string, ExtractorResult>;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const stderr = err instanceof Error && 'stderr' in err ? (err as any).stderr : undefined;
    console.error(`Extractor command failed: ${command} ${args.join(' ')}`);
    console.error(`Error: ${errorMessage}`);
    if (errorStack) console.error(errorStack);
    if (stderr) console.error(`Stderr: ${stderr}`);
    throw new Error(`Extractor failed: ${errorMessage}`);
  }
}
