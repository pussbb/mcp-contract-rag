import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config, languageOf, SOURCE_EXTENSIONS, type Language, type ServiceConfig } from '../config.js';
import {
  createPool, deleteFiles, ensureSchema, inSyncTransaction, loadStoredFiles, recomputePriority,
  replaceEdges, replaceExports, replaceExternalDeps, upsertFiles,
  type DependencyRecord, type EdgeRecord, type ExportRecord, type FileRecord,
} from '../db/index.js';
import { analyzeDotnet, packageForNamespace, resolveDotnetEdges } from './dotnet.js';
import { runExtractor } from './external.js';
import { analyzeSource, type Analysis } from './extract.js';
import { createResolver, externalPackage } from './resolve.js';

const PY_EXTRACTOR = fileURLToPath(new URL('./python/extract.py', import.meta.url));

const ECOSYSTEM: Record<Language, string> = { typescript: 'npm', python: 'pypi', csharp: 'nuget' };

export interface SyncStats {
  service: string;
  scanned: number;
  changed: number;
  removed: number;
  skipped: number;
}

export interface SyncOptions {
  pool?: pg.Pool;
  log?: (message: string) => void;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Walks `root`, skipping ignored directories, and returns relative posix paths accepted by `accept`. */
async function walkFiles(root: string, extraIgnoreDirs: string[], accept: (name: string) => boolean): Promise<string[]> {
  const ignored = new Set([...config.ignore.dirs, ...extraIgnoreDirs]);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && accept(entry.name)) {
        files.push(toPosix(path.relative(root, path.join(dir, entry.name))));
      }
    }
  }
  await walk(root);
  return files.sort();
}

export function crawl(root: string, extraIgnoreDirs: string[] = []): Promise<string[]> {
  return walkFiles(root, extraIgnoreDirs, (name) =>
    SOURCE_EXTENSIONS.includes(path.extname(name)) && !config.ignoreFiles.some((re) => re.test(name)));
}

/** NuGet package ids declared in the service's .csproj files. */
async function readPackageReferences(root: string, extraIgnoreDirs: string[]): Promise<string[]> {
  const projects = await walkFiles(root, extraIgnoreDirs, (name) => name.endsWith('.csproj'));
  const ids = new Set<string>();
  for (const proj of projects) {
    const xml = await readFile(path.join(root, proj), 'utf8');
    for (const m of xml.matchAll(/<PackageReference\s+[^>]*Include="([^"]+)"/g)) ids.add(m[1]!);
  }
  return [...ids];
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const EMPTY: Analysis = { exports: [], imports: [] };

/** TypeScript is parsed in-process; Python and C# go through one extractor process each. */
async function analyzeAll(rels: string[], textOf: (rel: string) => string, log: (m: string) => void): Promise<Map<string, Analysis>> {
  const out = new Map<string, Analysis>();
  const py: Record<string, string> = {};
  const cs: Record<string, string> = {};
  for (const rel of rels) {
    const lang = languageOf(rel);
    if (lang === 'python') py[rel] = textOf(rel);
    else if (lang === 'csharp') cs[rel] = textOf(rel);
    else {
      try {
        out.set(rel, analyzeSource(textOf(rel), rel));
      } catch (err) {
        log(`parse failed: ${rel}: ${(err as Error).message}`);
        out.set(rel, EMPTY);
      }
    }
  }
  if (Object.keys(py).length) {
    try {
      const parsed = await runExtractor(config.languages.python.command, [PY_EXTRACTOR], py);
      for (const [rel, r] of Object.entries(parsed)) {
        if (r.error) log(`parse failed: ${rel}: ${r.error}`);
        out.set(rel, r.error ? EMPTY : { exports: r.exports, imports: r.imports });
      }
    } catch (err) {
      log(`python extractor failed: ${(err as Error).message}`);
      for (const rel of Object.keys(py)) out.set(rel, EMPTY);
    }
  }
  if (Object.keys(cs).length) {
    try {
      for (const [rel, a] of await analyzeDotnet(cs, log)) out.set(rel, a);
    } catch (err) {
      log(`C# extractor failed: ${(err as Error).message}`);
      for (const rel of Object.keys(cs)) out.set(rel, EMPTY);
    }
  }
  return out;
}

/**
 * Bring the database in line with one service's files on disk. Unchanged files are skipped:
 * first by size + mtime (no read), then by MD5. Runs in one transaction under an advisory lock.
 */
export async function syncService(service: ServiceConfig, { pool, log = () => {} }: SyncOptions = {}): Promise<SyncStats> {
  const { name, root } = service;
  const ownPool = !pool;
  pool ??= createPool();
  try {
    await ensureSchema(pool);
    const rels = await crawl(root, service.ignoreDirs);

    return await inSyncTransaction(pool, async (client) => {
      const stored = await loadStoredFiles(client, name);

      const texts = new Map<string, string>();
      const hashes = new Map<string, string>();
      const meta = new Map<string, { size: number; mtime: number }>();
      await Promise.all(rels.map(async (rel) => {
        const abs = path.join(root, rel);
        const st = await stat(abs);
        const m = { size: st.size, mtime: Math.floor(st.mtimeMs) };
        meta.set(rel, m);
        const prev = stored.get(rel);
        if (config.sync.mtimePrecheck && prev && prev.size === m.size && prev.mtime === m.mtime) {
          hashes.set(rel, prev.hash);
          return;
        }
        const text = await readFile(abs, 'utf8');
        texts.set(rel, text);
        hashes.set(rel, md5(text));
      }));
      const textOf = (rel: string): string => {
        const t = texts.get(rel);
        if (t === undefined) throw new Error(`source not loaded: ${rel}`);
        return t;
      };

      const removed = [...stored.keys()].filter((p) => !hashes.has(p));
      const added = rels.filter((p) => !stored.has(p));
      const changed = rels.filter((p) => stored.get(p)?.hash !== hashes.get(p));
      // Same content, new mtime/size (e.g. after a checkout): refresh the stored stat only.
      const touched = rels.filter((p) => {
        const prev = stored.get(p);
        const m = meta.get(p)!;
        return prev && prev.hash === hashes.get(p) && (prev.size !== m.size || prev.mtime !== m.mtime);
      });
      const stats: SyncStats = { service: name, scanned: rels.length, changed: changed.length, removed: removed.length, skipped: rels.length - changed.length };

      const record = (p: string): FileRecord => ({ path: p, hash: hashes.get(p)!, language: languageOf(p), size: meta.get(p)!.size, mtime: meta.get(p)!.mtime });

      await upsertFiles(client, name, touched.map(record));
      if (!changed.length && !removed.length) return stats;

      // Adding or removing a file can make previously unresolved imports resolvable (or dangling),
      // so edges are rebuilt for every file then. C# edges are type-based across files, so any
      // C# change re-analyzes all C# files of the service.
      const structural = added.length > 0 || removed.length > 0;
      const csChanged = changed.some((p) => languageOf(p) === 'csharp') || (structural && rels.some((p) => languageOf(p) === 'csharp'));
      const edgeSources = rels.filter((p) => structural || changed.includes(p) || (csChanged && languageOf(p) === 'csharp'));
      for (const rel of edgeSources) {
        if (!texts.has(rel)) texts.set(rel, await readFile(path.join(root, rel), 'utf8'));
      }
      const resolve = createResolver(root, new Set(rels));
      const analyses = await analyzeAll(edgeSources, textOf, log);
      const packages = csChanged ? await readPackageReferences(root, service.ignoreDirs) : [];

      await deleteFiles(client, name, removed);

      const exportRows: ExportRecord[] = [];
      const edgeKeys = new Set<string>();
      const depKeys = new Set<string>();
      const changedSet = new Set(changed);
      for (const rel of edgeSources) {
        const analysis = analyses.get(rel) ?? EMPTY;
        if (changedSet.has(rel)) {
          for (const e of analysis.exports) exportRows.push({ path: rel, name: e.name, type: e.type, signature: e.signature, description: e.description });
        }
        const language = languageOf(rel);
        if (!language) continue;
        for (const spec of analysis.imports) {
          if (language === 'csharp') {
            const pkg = packageForNamespace(spec, packages);
            if (pkg) depKeys.add(`${rel}\u0000${pkg}\u0000${ECOSYSTEM.csharp}`);
            continue;
          }
          const to = resolve(rel, spec);
          if (to) {
            if (to !== rel) edgeKeys.add(`${rel}\u0000${to}`);
            continue;
          }
          const pkg = externalPackage(spec, language);
          if (pkg) depKeys.add(`${rel}\u0000${pkg}\u0000${ECOSYSTEM[language]}`);
        }
      }
      if (csChanged) {
        const csAnalyses = new Map([...analyses].filter(([rel]) => languageOf(rel) === 'csharp'));
        for (const [from, tos] of resolveDotnetEdges(csAnalyses)) for (const to of tos) edgeKeys.add(`${from}\u0000${to}`);
      }

      await upsertFiles(client, name, changed.map(record));
      await replaceExports(client, name, changed, exportRows);
      const edges: EdgeRecord[] = [...edgeKeys].map((k) => { const [from, to] = k.split('\u0000'); return { from: from!, to: to! }; });
      await replaceEdges(client, name, edgeSources, edges);
      const deps: DependencyRecord[] = [...depKeys].map((k) => { const [path, packageName, ecosystem] = k.split('\u0000'); return { path: path!, packageName: packageName!, ecosystem: ecosystem! }; });
      await replaceExternalDeps(client, name, edgeSources, deps);

      await recomputePriority(client, name);
      return stats;
    });
  } finally {
    if (ownPool) await pool.end();
  }
}

/** Sync every configured service over one shared pool. */
export async function syncAll({ pool, log, services = config.services }: SyncOptions & { services?: ServiceConfig[] } = {}): Promise<SyncStats[]> {
  const ownPool = !pool;
  pool ??= createPool();
  try {
    const results: SyncStats[] = [];
    for (const service of services) results.push(await syncService(service, { pool, log }));
    return results;
  } finally {
    if (ownPool) await pool.end();
  }
}

/** CLI: `yarn index [--service=NAME] [--root=PATH]`. --root defines an ad-hoc single service. */
function parseArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k!, v.join('=')];
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  let services = config.services;
  if (args.root) services = [{ name: args.service ?? path.basename(path.resolve(args.root)), root: path.resolve(args.root), ignoreDirs: [] }];
  else if (args.service) services = services.filter((s) => s.name === args.service);
  syncAll({ services, log: (m) => console.error(m) })
    .then((stats) => console.log(stats))
    .catch((err) => { console.error(err); process.exit(1); });
}
