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
  const child = exec(command, args, { maxBuffer: 512 * 1024 * 1024 });
  child.child.stdin!.end(JSON.stringify(files));
  return JSON.parse((await child).stdout) as Record<string, ExtractorResult>;
}
