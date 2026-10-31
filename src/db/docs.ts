import type pg from 'pg';

export interface DocRecord {
  service: string;
  path: string;
  name: string;
  hash: string;
  content: string;
  language: string;
  size: number;
  mtime: number;
}

export interface StoredDoc {
  hash: string;
  size: number | null;
  mtime: number | null;
}

export interface SearchResult {
  service: string;
  path: string;
  name: string;
  content: string;
  language: string;
  rank: number;
}

/** Load stored document metadata for a service. */
export async function loadStoredDocs(client: pg.PoolClient, service: string): Promise<Map<string, StoredDoc>> {
  const { rows } = await client.query(
    'SELECT file_path, content_hash, size_bytes, mtime_ms FROM codebase_docs WHERE service_name = $1',
    [service],
  );
  const num = (v: string | number | null) => (v === null ? null : Number(v));
  return new Map(rows.map((r) => [r.file_path, { hash: r.content_hash, size: num(r.size_bytes), mtime: num(r.mtime_ms) }]));
}

/** Upsert document records. */
export async function upsertDocs(client: pg.PoolClient, service: string, docs: DocRecord[]): Promise<void> {
  if (!docs.length) return;
  await client.query(
    `INSERT INTO codebase_docs (service_name, file_path, file_name, content_hash, content, language, size_bytes, mtime_ms)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::bigint[])
     ON CONFLICT (service_name, file_path) DO UPDATE
        SET content_hash = EXCLUDED.content_hash, content = EXCLUDED.content,
            size_bytes = EXCLUDED.size_bytes, mtime_ms = EXCLUDED.mtime_ms, updated_at = NOW()`,
    [
      service,
      docs.map((d) => d.path),
      docs.map((d) => d.name),
      docs.map((d) => d.hash),
      docs.map((d) => d.content),
      docs.map((d) => d.language),
      docs.map((d) => d.size),
      docs.map((d) => d.mtime),
    ],
  );
}

/** Delete documents that no longer exist. */
export async function deleteDocs(client: pg.PoolClient, service: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await client.query('DELETE FROM codebase_docs WHERE service_name = $1 AND file_path = ANY($2)', [service, paths]);
}

/** Full-text search for documents. */
export async function searchDocs(
  pool: pg.Pool,
  query: string,
  limit: number,
  service?: string,
): Promise<SearchResult[]> {
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (service) {
    conditions.push('service_name = $1');
    params.push(service);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const paramIndex = params.length + 1;

  const sql = `
    SELECT service_name, file_path, file_name, content, language,
           ts_rank(to_tsvector('english', content), plainto_tsquery('english', $${paramIndex})) as rank
    FROM codebase_docs
    ${whereClause}
    AND to_tsvector('english', content) @@ plainto_tsquery('english', $${paramIndex})
    ORDER BY rank DESC
    LIMIT $${paramIndex + 1}
  `;

  params.push(query, limit);

  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    service: r.service_name,
    path: r.file_path,
    name: r.file_name,
    content: r.content,
    language: r.language,
    rank: Number(r.rank),
  }));
}
