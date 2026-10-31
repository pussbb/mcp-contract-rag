import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** Name of the YAML config file looked up in the working directory. */
export const CONFIG_FILE = 'contract-rag.yaml';

const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const int = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int());
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain PostgreSQL identifier');

const extensions = (defaults: string[]) => z.array(z.string()).default(defaults);

const schema = z.object({
  server: z.object({
    /** MCP server name reported to clients. */
    name: z.string().default('contract-rag'),
    /** Transport: 'stdio' (default) or 'http'. */
    transport: z.enum(['stdio', 'http']).default('stdio'),
    /** Port for HTTP transport (only used when transport is 'http'). */
    port: int.default(3000),
  }).prefault({}),
  database: z.object({
    url: z.string().default('postgres://postgres:postgres@localhost:5432/contract_rag'),
    /** PostgreSQL schema (namespace) that holds the tables. Created on first use. */
    schema: identifier.default('contract_rag'),
    poolSize: int.default(4),
  }).prefault({}),
  triage: z.object({
    enabled: bool.default(true),
    url: z.string().default('http://localhost:1234/v1'),
    model: z.string().default('local-model'),
    timeoutMs: int.default(8000),
    /** Max contracts kept after triage. */
    keep: int.default(3),
  }).prefault({}),
  search: z.object({
    /** Rows fetched from PostgreSQL before triage. */
    tier1Limit: int.default(12),
    /** Rows returned by the codebase://exports/high-priority resource. */
    resourceLimit: int.default(50),
    /** Row cap (SQL LIMIT) for list-style tools such as list_file_exports and find_symbol. */
    maxRows: int.default(500),
    /** Rows fetched per round trip when streaming results from PostgreSQL. */
    streamBatchSize: int.default(100),
    /** Row cap (SQL LIMIT) for the dependency graph resources. */
    graphLimit: int.default(5000),
  }).prefault({}),
  hooks: z.object({
    /** UserPromptSubmit hook: add matching internal contracts to the prompt before Claude starts. */
    context: z.object({
      enabled: bool.default(true),
      /** Max contracts injected. */
      limit: int.default(5),
      /** Minimum relevance score (3 = a query word appears in an entity name). */
      minRelevance: int.default(3),
      /** Prompts shorter than this are ignored. */
      minPromptChars: int.default(12),
      /** Cap on the injected text. */
      maxChars: int.default(1500),
    }).prefault({}),
  }).prefault({}),
  usage: z.object({
    /** Record MCP tool calls through the PostToolUse hook. */
    enabled: bool.default(true),
    /** Also store the tool arguments (they may contain search text). */
    storeInput: bool.default(true),
  }).prefault({}),
  sync: z.object({
    /** Skip reading a file when size and mtime match the stored values. */
    mtimePrecheck: bool.default(true),
  }).prefault({}),
  ranking: z.object({
    inboundEdgeWeight: int.default(2),
    inboundEdgeCap: int.default(40),
    /** First matching case-insensitive path fragment wins; its weight is added to every export in the file. */
    folderWeights: z.array(z.object({ match: z.string(), weight: int })).default([
      { match: '/utils/', weight: 50 },
      { match: '/helpers/', weight: 50 },
      { match: '/extensions/', weight: 40 },
      { match: '/hooks/', weight: 40 },
      { match: '/shared/', weight: 30 },
      { match: '/lib/', weight: 30 },
      { match: '/services/', weight: 25 },
      { match: '/components/', weight: 20 },
    ]),
    /** Weight per field usage (destructured or member access). Default 0 to disable field-level ranking. */
    fieldUsageWeight: int.default(0),
    /** Cap on field usage bonus to prevent skewing. */
    fieldUsageCap: int.default(100),
  }).prefault({}),
  ignore: z.object({
    dirs: z.array(z.string()).default([
      'node_modules', 'fixtures', '__pycache__', '.venv', 'venv', 'site-packages', 'bin', 'obj', 'out',
      '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.idea', '.claude',
    ]),
    /** Regular expressions tested against the file name. */
    files: z.array(z.string()).default([
      '\\.(d\\.ts|test\\.[tj]sx?|spec\\.[tj]sx?|stories\\.[tj]sx?)$',
      '^(test_.*|conftest)\\.py$',
      '_test\\.py$',
      '\\.(g|generated|Designer)\\.cs$',
      '^(AssemblyInfo|GlobalUsings)\\.cs$',
    ]),
  }).prefault({}),
  languages: z.object({
    typescript: z.object({ extensions: extensions(['.ts', '.tsx', '.js', '.jsx', '.mjs']) }).prefault({}),
    python: z.object({ extensions: extensions(['.py']), command: z.string().default('python3') }).prefault({}),
    csharp: z.object({
      extensions: extensions(['.cs']),
      command: z.string().default('dotnet'),
      /** Build the Roslyn extractor on first use when it is missing. */
      autoBuild: bool.default(true),
    }).prefault({}),
  }).prefault({}),
  docs: z.object({
    /** File extensions to index as documentation. */
    extensions: z.array(z.string()).default(['.md', '.markdown', '.rst', '.txt']),
    /** Max tokens to send to local AI for relevance scoring. */
    maxTokens: int.default(4000),
    /** Max document length in characters for full-text search. */
    maxContentLength: int.default(100000),
  }).prefault({}),
  services: z.array(z.object({
    name: z.string().min(1),
    /** Relative to the config file. */
    root: z.string().default('.'),
    /** Extra directory names to skip for this service only. */
    ignoreDirs: z.array(z.string()).default([]),
  })).default([]),
});

export type Config = z.infer<typeof schema>;
export type Language = keyof Config['languages'];
export const LANGUAGES = ['typescript', 'python', 'csharp'] as const satisfies readonly Language[];

export interface ServiceConfig {
  name: string;
  /** Absolute root of the service; file paths in the DB are relative to it. */
  root: string;
  ignoreDirs: string[];
}

/** Replaces ${VAR} and ${VAR:-default} in every string value. */
function interpolate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

export function loadConfig(file = path.resolve(process.env.CONTRACT_RAG_CONFIG ?? CONFIG_FILE)) {
  const exists = existsSync(file);
  const raw = exists ? (parse(readFileSync(file, 'utf8')) ?? {}) : {};
  const parsed = schema.safeParse(interpolate(raw));
  if (!parsed.success) {
    throw new Error(`Invalid ${exists ? file : 'default config'}:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg = parsed.data;
  const baseDir = exists ? path.dirname(file) : process.cwd();
  const services: ServiceConfig[] = cfg.services.length
    ? cfg.services.map((s) => ({ name: s.name, root: path.resolve(baseDir, s.root), ignoreDirs: s.ignoreDirs }))
    : [{ name: path.basename(baseDir), root: baseDir, ignoreDirs: [] }];
  return {
    ...cfg,
    file: exists ? file : null,
    services,
    ignoreFiles: cfg.ignore.files.map((p) => new RegExp(p)),
  };
}

export const config = loadConfig();

const extensionToLanguage = new Map<string, Language>();
for (const lang of LANGUAGES) {
  for (const ext of config.languages[lang].extensions) extensionToLanguage.set(ext, lang);
}

export const SOURCE_EXTENSIONS = [...extensionToLanguage.keys()];

/** Language of a file by extension, or null when the extension is not configured. */
export function languageOf(file: string): Language | null {
  return extensionToLanguage.get(path.extname(file)) ?? null;
}
