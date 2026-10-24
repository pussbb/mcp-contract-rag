import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { Analysis } from './extract.js';
import { runExtractor } from './external.js';

const exec = promisify(execFile);
const PROJECT_DIR = fileURLToPath(new URL('./dotnet/Extractor/', import.meta.url));
const DLL = `${PROJECT_DIR}out/Extractor.dll`;

/** Builds the Roslyn extractor when missing. The first build restores NuGet packages and can take minutes. */
export async function ensureExtractorBuilt(log: (m: string) => void): Promise<void> {
  if (existsSync(DLL)) return;
  if (!config.languages.csharp.autoBuild) {
    throw new Error('C# extractor is not built; run `yarn build:dotnet` or set languages.csharp.autoBuild: true');
  }
  log('building C# extractor (first run)...');
  await exec(config.languages.csharp.command, ['build', '-c', 'Release', '-o', 'out', '--nologo', '-v', 'q'], { cwd: PROJECT_DIR });
}

export async function analyzeDotnet(files: Record<string, string>, log: (m: string) => void): Promise<Map<string, Analysis>> {
  await ensureExtractorBuilt(log);
  const parsed = await runExtractor(config.languages.csharp.command, [DLL], files);
  const out = new Map<string, Analysis>();
  for (const [rel, result] of Object.entries(parsed)) {
    if (result.error) {
      log(`parse failed: ${rel}: ${result.error}`);
      out.set(rel, { exports: [], imports: [] });
    } else {
      out.set(rel, { exports: result.exports, imports: result.imports, references: result.references });
    }
  }
  return out;
}

/**
 * C# imports are namespaces, not files. File A depends on file B when A references a type B
 * declares and B's namespace is visible to A: imported by a using, or A's own namespace or
 * one of its parents. Returns from-file -> provider files.
 */
export function resolveDotnetEdges(analyses: Map<string, Analysis>): Map<string, Set<string>> {
  const providers = new Map<string, { file: string; ns: string }[]>();
  for (const [file, a] of analyses) {
    for (const e of a.exports) {
      const list = providers.get(e.name) ?? [];
      list.push({ file, ns: e.namespace ?? '' });
      providers.set(e.name, list);
    }
  }
  const edges = new Map<string, Set<string>>();
  for (const [file, a] of analyses) {
    const own = new Set<string>();
    for (const e of a.exports) {
      const parts = (e.namespace ?? '').split('.').filter(Boolean);
      for (let i = 0; i <= parts.length; i++) own.add(parts.slice(0, i).join('.'));
    }
    const visible = new Set([...own, ...a.imports]);
    const targets = new Set<string>();
    for (const ref of a.references ?? []) {
      for (const p of providers.get(ref) ?? []) {
        if (p.file !== file && visible.has(p.ns)) targets.add(p.file);
      }
    }
    edges.set(file, targets);
  }
  return edges;
}

/** Longest NuGet package id that prefixes the namespace, or null (System.* and in-repo namespaces match nothing). */
export function packageForNamespace(ns: string, packages: string[]): string | null {
  const lower = ns.toLowerCase();
  let best: string | null = null;
  for (const pkg of packages) {
    const p = pkg.toLowerCase();
    if ((lower === p || lower.startsWith(`${p}.`)) && (!best || pkg.length > best.length)) best = pkg;
  }
  return best;
}
