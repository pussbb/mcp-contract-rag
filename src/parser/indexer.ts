import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config, languageOf, SOURCE_EXTENSIONS, type Language, type ServiceConfig } from '../config.js';
import {
  createPool, deleteFiles, deleteService, deleteAll, ensureSchema, inSyncTransaction, loadStoredFiles, recomputePriority,
  replaceEdges, replaceExports, replaceExternalDeps, replaceFieldUsage, upsertFiles,
  type DependencyRecord, type EdgeRecord, type ExportRecord, type FieldUsageRecord, type FileRecord, type StoredFile,
  loadStoredDocs, upsertDocs, deleteDocs, type DocRecord,
} from '../db/index.js';
import { analyzeDotnet, packageForNamespace, resolveDotnetEdges } from './dotnet.js';
import { runExtractor } from './external.js';
import { analyzeSource, type Analysis } from './extract.js';
import { createResolver, externalPackage, type Resolver } from './resolve.js';
import { crawlDocs, extractDocs, getChangedDocPaths } from './docs.js';

const PY_EXTRACTOR = fileURLToPath(new URL('./python/extract.py', import.meta.url));

// Maps languages to their package ecosystems for dependency tracking
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

// Converts platform-specific path separators to POSIX-style (forward slashes)
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

/** Extracts NuGet package IDs from .csproj files in the service. */
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
const EMPTY: Analysis = { exports: [], imports: [], fieldUsage: [] };

/** Collects file metadata (text, hash, size, mtime) for all files, using mtime precheck when enabled. */
async function collectFileMetadata(
  rels: string[],
  root: string,
  stored: Map<string, StoredFile>,
  log: (m: string) => void,
): Promise<{ texts: Map<string, string>; hashes: Map<string, string>; meta: Map<string, { size: number; mtime: number }> }> {
  const texts = new Map<string, string>();
  const hashes = new Map<string, string>();
  const meta = new Map<string, { size: number; mtime: number }>();

  await Promise.all(rels.map(async (rel) => {
    const abs = path.join(root, rel);
    const st = await stat(abs);
    const m = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    meta.set(rel, m);
    const prev = stored.get(rel);
    // Skip reading file if size and mtime match (optimization)
    if (config.sync.mtimePrecheck && prev && prev.size === m.size && prev.mtime === m.mtime) {
      hashes.set(rel, prev.hash);
      return;
    }
    const text = await readFile(abs, 'utf8');
    texts.set(rel, text);
    hashes.set(rel, md5(text));
  }));

  return { texts, hashes, meta };
}

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
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? err.stack : undefined;
        log(`parse failed: ${rel}: ${errorMessage}`);
        if (errorStack) log(errorStack);
        out.set(rel, EMPTY);
      }
    }
  }
  if (Object.keys(py).length) {
    try {
      const parsed = await runExtractor(config.languages.python.command, [PY_EXTRACTOR], py);
      for (const [rel, r] of Object.entries(parsed)) {
        if (r.error) log(`parse failed: ${rel}: ${r.error}`);
        out.set(rel, r.error ? EMPTY : { exports: r.exports, imports: r.imports, fieldUsage: [] });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      log(`python extractor failed: ${errorMessage}`);
      if (errorStack) log(errorStack);
      for (const rel of Object.keys(py)) out.set(rel, EMPTY);
    }
  }
  if (Object.keys(cs).length) {
    try {
      for (const [rel, a] of await analyzeDotnet(cs, log)) out.set(rel, a);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      log(`C# extractor failed: ${errorMessage}`);
      if (errorStack) log(errorStack);
      for (const rel of Object.keys(cs)) out.set(rel, EMPTY);
    }
  }
  return out;
}

/** Builds edge and dependency records from file analyses. */
function buildEdgesAndDeps(
  edgeSources: string[],
  analyses: Map<string, Analysis>,
  resolve: Resolver,
  packages: string[],
): { edges: EdgeRecord[]; deps: DependencyRecord[] } {
  const edgeKeys = new Set<string>();
  const depKeys = new Set<string>();

  for (const rel of edgeSources) {
    const analysis = analyses.get(rel) ?? EMPTY;
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

  const edges: EdgeRecord[] = [...edgeKeys].map((k) => {
    const [from, to] = k.split('\u0000');
    return { from: from!, to: to! };
  });

  const deps: DependencyRecord[] = [...depKeys].map((k) => {
    const [path, packageName, ecosystem] = k.split('\u0000');
    return { path: path!, packageName: packageName!, ecosystem: ecosystem! };
  });

  return { edges, deps };
}

interface FileChanges {
  removed: string[];
  added: string[];
  changed: string[];
  touched: string[];
}

/** Detects which files were added, removed, changed, or touched (same content, new mtime/size). */
function detectFileChanges(
  rels: string[],
  stored: Map<string, StoredFile>,
  hashes: Map<string, string>,
  meta: Map<string, { size: number; mtime: number }>,
): FileChanges {
  const removed = [...stored.keys()].filter((p) => !hashes.has(p));
  const added = rels.filter((p) => !stored.has(p));
  const changed = rels.filter((p) => stored.get(p)?.hash !== hashes.get(p));
  const touched = rels.filter((p) => {
    const prev = stored.get(p);
    const m = meta.get(p)!;
    return prev && prev.hash === hashes.get(p) && (prev.size !== m.size || prev.mtime !== m.mtime);
  });
  return { removed, added, changed, touched };
}

/** Determines which files need edge analysis based on structural changes and language-specific rules. */
function determineEdgeSources(
  rels: string[],
  added: string[],
  removed: string[],
  changed: string[],
): { structural: boolean; csChanged: boolean; edgeSources: string[] } {
  const structural = added.length > 0 || removed.length > 0;
  const csChanged = changed.some((p) => languageOf(p) === 'csharp') || (structural && rels.some((p) => languageOf(p) === 'csharp'));
  const edgeSources = rels.filter((p) => structural || changed.includes(p) || (csChanged && languageOf(p) === 'csharp'));
  return { structural, csChanged, edgeSources };
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
      const { texts, hashes, meta } = await collectFileMetadata(rels, root, stored, log);

      const textOf = (rel: string): string => {
        const t = texts.get(rel);
        if (t === undefined) throw new Error(`source not loaded: ${rel}`);
        return t;
      };

      const { removed, added, changed, touched } = detectFileChanges(rels, stored, hashes, meta);
      const stats: SyncStats = { service: name, scanned: rels.length, changed: changed.length, removed: removed.length, skipped: rels.length - changed.length };

      const record = (p: string): FileRecord => ({ path: p, hash: hashes.get(p)!, language: languageOf(p), size: meta.get(p)!.size, mtime: meta.get(p)!.mtime });

      await upsertFiles(client, name, touched.map(record));
      if (!changed.length && !removed.length) return stats;

      const { structural, csChanged, edgeSources } = determineEdgeSources(rels, added, removed, changed);

      // Load any missing file contents for edge analysis
      for (const rel of edgeSources) {
        if (!texts.has(rel)) texts.set(rel, await readFile(path.join(root, rel), 'utf8'));
      }
      const resolve = createResolver(root, new Set(rels));
      const analyses = await analyzeAll(edgeSources, textOf, log);
      const packages = csChanged ? await readPackageReferences(root, service.ignoreDirs) : [];

      // Remove deleted files from the database
      await deleteFiles(client, name, removed);

      // Collect export rows for changed files
      const changedSet = new Set(changed);
      const exportRows: ExportRecord[] = [];
      for (const rel of edgeSources) {
        const analysis = analyses.get(rel) ?? EMPTY;
        if (changedSet.has(rel)) {
          for (const e of analysis.exports) exportRows.push({ path: rel, name: e.name, type: e.type, signature: e.signature, description: e.description, isDefault: e.name === analysis.defaultExport });
        }
      }

      // Field usage: which fields each file reads off values imported from another indexed file
      const fieldUsageRows: FieldUsageRecord[] = [];
      for (const rel of edgeSources) {
        for (const fu of analyses.get(rel)?.fieldUsage ?? []) {
          const exporter = resolve(rel, fu.source);
          if (!exporter || exporter === rel) continue;
          for (const { name: fieldName, count } of fu.fields) {
            fieldUsageRows.push({ importer: rel, path: exporter, entityName: fu.entityName, fieldName, usageCount: count });
          }
        }
      }

      // Build edge and dependency records
      const { edges, deps } = buildEdgesAndDeps(edgeSources, analyses, resolve, packages);

      // Add C# type-reference edges if any C# files changed
      if (csChanged) {
        const csAnalyses = new Map([...analyses].filter(([rel]) => languageOf(rel) === 'csharp'));
        for (const [from, tos] of resolveDotnetEdges(csAnalyses)) {
          for (const to of tos) edges.push({ from, to });
        }
      }

      // Write all changes to the database
      await upsertFiles(client, name, changed.map(record));
      await replaceExports(client, name, changed, exportRows);
      await replaceEdges(client, name, edgeSources, edges);
      await replaceExternalDeps(client, name, edgeSources, deps);
      await replaceFieldUsage(client, name, edgeSources, fieldUsageRows);

      // Recompute priority scores based on folder weights and inbound edges
      await recomputePriority(client, name);

      // Sync documentation files
      await syncDocs(client, name, root, service.ignoreDirs, log);

      return stats;
    });
  } finally {
    if (ownPool) await pool.end();
  }
}

/** Sync documentation files separately from source code. */
async function syncDocs(client: pg.PoolClient, service: string, root: string, extraIgnoreDirs: string[], log: (m: string) => void): Promise<void> {
  const docRels = await crawlDocs(root, extraIgnoreDirs);
  const stored = await loadStoredDocs(client, service);

  const removed = [...stored.keys()].filter((p) => !docRels.includes(p));
  const added = docRels.filter((p) => !stored.has(p));

  // Compute hashes for changed detection
  const hashes = new Map<string, string>();
  for (const rel of docRels) {
    const content = await readFile(path.join(root, rel), 'utf8');
    hashes.set(rel, createHash('md5').update(content).digest('hex'));
  }

  const changed = getChangedDocPaths(docRels, stored, hashes);

  if (!removed.length && !added.length && !changed.length) return;

  log(`Syncing docs: ${added.length} added, ${changed.length} changed, ${removed.length} removed`);

  await deleteDocs(client, service, removed);

  const toExtract = [...added, ...changed];
  const extracted = await extractDocs(root, toExtract);
  const docRecords: DocRecord[] = extracted.map((d) => ({ ...d, service }));

  await upsertDocs(client, service, docRecords);
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

/** CLI: `contract-rag index [--service=NAME] [--root=PATH]`. --root defines an ad-hoc single service. */
function parseArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k!, v.join('=')];
    }),
  );
}

export async function runIndexCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Handle reset commands
  if (args['reset-all'] !== undefined) {
    const pool = createPool();
    try {
      await ensureSchema(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7_340_121)');
        await deleteAll(client);
        await client.query('COMMIT');
        console.info('Database reset: all data deleted');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
    return;
  }

  if (args['reset']) {
    if (!args.service) {
      console.error('--reset requires --service=NAME');
      process.exitCode = 1;
      return;
    }
    const pool = createPool();
    try {
      await ensureSchema(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7_340_121)');
        await deleteService(client, args.service);
        await client.query('COMMIT');
        console.error(`Service reset: ${args.service} deleted`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
    return;
  }

  // Normal sync
  let services = config.services;
  if (args.root) services = [{ name: args.service ?? path.basename(path.resolve(args.root)), root: path.resolve(args.root), ignoreDirs: [] }];
  else if (args.service) services = services.filter((s) => s.name === args.service);
  try {
    console.log(await syncAll({ services, log: (m) => console.error(m) }));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runIndexCli(process.argv.slice(2));
