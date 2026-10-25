import type pg from 'pg';
import { config } from '../config.js';

// Arbitrary constant: serializes concurrent syncs (e.g. two hook runs) on one database.
const SYNC_LOCK_ID = 7_340_121;

export interface StoredFile {
  hash: string;
  size: number | null;
  mtime: number | null;
}

export interface FileRecord {
  path: string;
  hash: string;
  language: string | null;
  size: number;
  mtime: number;
}

export interface ExportRecord {
  path: string;
  name: string;
  type: string;
  signature: string;
  description: string | null;
  /** Exported as `default`; importers record field usage under the name 'default'. */
  isDefault?: boolean;
}

export interface EdgeRecord {
  from: string;
  to: string;
}

export interface DependencyRecord {
  path: string;
  packageName: string;
  ecosystem: string;
}

export interface FieldUsageRecord {
  /** File that reads the field. */
  importer: string;
  /** File that exports `entityName`. */
  path: string;
  entityName: string;
  fieldName: string;
  usageCount: number;
}

/** Runs `fn` in one transaction under the sync advisory lock; commits on return, rolls back on throw. */
export async function inSyncTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_ID]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to rollback transaction:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function loadStoredFiles(client: pg.PoolClient, service: string): Promise<Map<string, StoredFile>> {
  const { rows } = await client.query(
    'SELECT file_path, content_hash, size_bytes, mtime_ms FROM codebase_files WHERE service_name = $1',
    [service],
  );
  const num = (v: string | number | null) => (v === null ? null : Number(v));
  return new Map(rows.map((r) => [r.file_path, { hash: r.content_hash, size: num(r.size_bytes), mtime: num(r.mtime_ms) }]));
}

export async function upsertFiles(client: pg.PoolClient, service: string, files: FileRecord[]): Promise<void> {
  if (!files.length) return;
  await client.query(
    `INSERT INTO codebase_files (service_name, file_path, file_name, content_hash, language, size_bytes, mtime_ms)
     SELECT $1, p, regexp_replace(p, '^.*/', ''), h, l, s, m
       FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[]) AS t(p, h, l, s, m)
     ON CONFLICT (service_name, file_path) DO UPDATE
        SET content_hash = EXCLUDED.content_hash, language = EXCLUDED.language,
            size_bytes = EXCLUDED.size_bytes, mtime_ms = EXCLUDED.mtime_ms, updated_at = NOW()`,
    [service, files.map((f) => f.path), files.map((f) => f.hash), files.map((f) => f.language), files.map((f) => f.size), files.map((f) => f.mtime)],
  );
}

/** Deleting a file cascades to its exports, edges and dependencies. */
export async function deleteFiles(client: pg.PoolClient, service: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await client.query('DELETE FROM codebase_files WHERE service_name = $1 AND file_path = ANY($2)', [service, paths]);
}

/** Delete all data for a specific service (files, exports, edges, dependencies). */
export async function deleteService(client: pg.PoolClient, service: string): Promise<void> {
  await client.query('DELETE FROM codebase_files WHERE service_name = $1', [service]);
}

/** Delete all data from all tables (reset entire database). */
export async function deleteAll(client: pg.PoolClient): Promise<void> {
  await client.query('DELETE FROM codebase_tool_usage');
  await client.query('DELETE FROM codebase_files'); // cascades to exports, edges, deps
  await client.query('DELETE FROM codebase_meta');
}

/** Replaces all exports of `paths` with `rows`. */
export async function replaceExports(client: pg.PoolClient, service: string, paths: string[], rows: ExportRecord[]): Promise<void> {
  if (paths.length) {
    await client.query('DELETE FROM codebase_exports WHERE service_name = $1 AND file_path = ANY($2)', [service, paths]);
  }
  if (!rows.length) return;
  await client.query(
    `INSERT INTO codebase_exports (service_name, file_path, entity_name, entity_type, signature, description, is_default)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bool[])
     ON CONFLICT (service_name, file_path, entity_name) DO NOTHING`,
    [service, rows.map((r) => r.path), rows.map((r) => r.name), rows.map((r) => r.type), rows.map((r) => r.signature), rows.map((r) => r.description), rows.map((r) => r.isDefault ?? false)],
  );
}

/** Replaces all outgoing edges of `fromFiles` with `edges`. */
export async function replaceEdges(client: pg.PoolClient, service: string, fromFiles: string[], edges: EdgeRecord[]): Promise<void> {
  if (fromFiles.length) {
    await client.query('DELETE FROM codebase_edges WHERE service_name = $1 AND from_file = ANY($2)', [service, fromFiles]);
  }
  if (!edges.length) return;
  await client.query(
    `INSERT INTO codebase_edges (service_name, from_file, to_file)
     SELECT $1, * FROM unnest($2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
    [service, edges.map((e) => e.from), edges.map((e) => e.to)],
  );
}

/** Replaces the third-party dependencies of `paths` with `deps`. */
export async function replaceExternalDeps(client: pg.PoolClient, service: string, paths: string[], deps: DependencyRecord[]): Promise<void> {
  if (paths.length) {
    await client.query('DELETE FROM codebase_external_deps WHERE service_name = $1 AND file_path = ANY($2)', [service, paths]);
  }
  if (!deps.length) return;
  await client.query(
    `INSERT INTO codebase_external_deps (service_name, file_path, package_name, ecosystem)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
    [service, deps.map((d) => d.path), deps.map((d) => d.packageName), deps.map((d) => d.ecosystem)],
  );
}

/** Replaces all field usage rows of the importing files `importerPaths` with `rows`. */
export async function replaceFieldUsage(client: pg.PoolClient, service: string, importerPaths: string[], rows: FieldUsageRecord[]): Promise<void> {
  if (importerPaths.length) {
    await client.query('DELETE FROM codebase_field_usage WHERE service_name = $1 AND importer_path = ANY($2)', [service, importerPaths]);
  }
  if (!rows.length) return;
  // One importer can reach the same export through several specifiers; sum them so the insert has no duplicate keys.
  const merged = new Map<string, FieldUsageRecord>();
  for (const r of rows) {
    const key = [r.importer, r.path, r.entityName, r.fieldName].join('\u0000');
    const prev = merged.get(key);
    if (prev) prev.usageCount += r.usageCount;
    else merged.set(key, { ...r });
  }
  const list = [...merged.values()];
  await client.query(
    `INSERT INTO codebase_field_usage (service_name, importer_path, file_path, entity_name, field_name, usage_count)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[])`,
    [service, list.map((r) => r.importer), list.map((r) => r.path), list.map((r) => r.entityName), list.map((r) => r.fieldName), list.map((r) => r.usageCount)],
  );
}

/** Escapes special characters for ILIKE patterns. */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Builds the CASE WHEN clause for folder weight scoring. */
function buildFolderWeightClause(folderWeights: Array<{ match: string; weight: number }>, params: (string | number)[]): string {
  const whens = folderWeights.map(({ match, weight }) => {
    params.push(`%${escapeLikePattern(match)}%`, weight);
    return `WHEN ('/' || f.file_path) ILIKE $${params.length - 1} THEN $${params.length}::int`;
  });
  return `CASE ${whens.join(' ')} ELSE 0 END`;
}

/** priority = folder weight + inboundEdgeWeight per inbound import edge (capped) + fieldUsageWeight per field usage (capped), all from contract-rag.yaml. */
export async function recomputePriority(client: pg.PoolClient, service: string): Promise<void> {
  const { folderWeights, inboundEdgeWeight, inboundEdgeCap, fieldUsageWeight, fieldUsageCap } = config.ranking;
  const params: (string | number)[] = [service, inboundEdgeWeight, inboundEdgeCap];
  const folderWeightClause = buildFolderWeightClause(folderWeights, params);

  let fieldUsageClause = '';
  if (fieldUsageWeight > 0) {
    params.push(fieldUsageWeight, fieldUsageCap);
    fieldUsageClause = `+ LEAST(COALESCE((SELECT sum(fu.usage_count)::int
                                            FROM codebase_field_usage fu
                                           WHERE fu.service_name = $1 AND fu.file_path = e.file_path AND fu.entity_name = CASE WHEN e.is_default THEN 'default' ELSE e.entity_name END), 0)
                                  * $${params.length - 1}::int, $${params.length}::int)`;
  }

  await client.query(
    `UPDATE codebase_exports e
        SET priority_score = ${folderWeightClause} + LEAST(COALESCE(d.n, 0) * $2::int, $3::int) ${fieldUsageClause}
       FROM codebase_files f
       LEFT JOIN (SELECT to_file, count(*)::int AS n FROM codebase_edges WHERE service_name = $1 GROUP BY to_file) d
         ON d.to_file = f.file_path
      WHERE e.service_name = $1 AND f.service_name = $1 AND e.file_path = f.file_path`,
    params,
  );
}
