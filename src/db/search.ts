import type pg from 'pg';
import { streamRows } from './stream.js';

export interface Contract {
  id: number;
  service: string;
  language: string;
  path: string;
  name: string;
  type: string;
  signature: string;
  description: string | null;
  usedBy: number;
}

const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'from', 'that', 'this', 'into', 'how', 'use', 'add', 'fix', 'make', 'create',
  'update', 'change', 'implement', 'need', 'want', 'please', 'should', 'would', 'could', 'can', 'you', 'our',
  'are', 'was', 'not', 'new', 'code', 'file', 'files', 'function', 'when', 'what', 'why', 'where', 'there',
]);

export function tokenize(query: string): string[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, 8);
}

const escapeLikePattern = (s: string) => s.replace(/[\\%_]/g, '\\$&');

const SELECT = `
  SELECT e.id, e.service_name AS service, f.language, e.file_path AS path, e.entity_name AS name, e.entity_type AS type,
         e.signature, e.description, e.priority_score,
         (SELECT count(*)::int FROM codebase_edges ed WHERE ed.service_name = e.service_name AND ed.to_file = e.file_path) AS "usedBy"`;

const FROM = `FROM codebase_exports e JOIN codebase_files f ON f.service_name = e.service_name AND f.file_path = e.file_path`;

/** Builds the relevance scoring clause for each token. */
function buildRelevanceClause(tokens: string[], params: (string | number)[]): string {
  const parts = tokens.map((t) => {
    params.push(`%${escapeLikePattern(t)}%`);
    const n = `$${params.length}`;
    return `(CASE WHEN entity_name ILIKE ${n} THEN 3 ELSE 0 END
           + CASE WHEN description ILIKE ${n} THEN 1 ELSE 0 END
           + CASE WHEN signature ILIKE ${n} THEN 1 ELSE 0 END)`;
  });
  return parts.join(' + ');
}

/** Tier 1: keyword match over names, descriptions and signatures, boosted by priority_score. */
export async function searchExports(pool: pg.Pool, query: string, limit: number, service?: string, minRelevance = 1): Promise<Contract[]> {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const params: (string | number)[] = [];
  const relevanceClause = buildRelevanceClause(tokens, params);

  let where = '';
  if (service) {
    params.push(service);
    where = `WHERE e.service_name = $${params.length}`;
  }
  params.push(minRelevance, limit);
  const { rows } = await pool.query(
    `SELECT * FROM (${SELECT}, ${relevanceClause} AS relevance ${FROM} ${where}) s
      WHERE relevance >= $${params.length - 1}
      ORDER BY relevance * 10 + priority_score DESC, name
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Top contracts by priority, streamed. */
export function streamTopExports(pool: pg.Pool, limit: number): AsyncGenerator<Contract> {
  return streamRows<Contract>(pool, `${SELECT} ${FROM} ORDER BY e.priority_score DESC, e.entity_name LIMIT $1`, [limit]);
}

/** Find exports by exact name match, streamed. */
export function streamSymbols(pool: pg.Pool, name: string, limit: number, service?: string): AsyncGenerator<Contract> {
  const params: (string | number)[] = [name];
  let where = 'WHERE e.entity_name = $1';
  if (service) {
    params.push(service);
    where += ` AND e.service_name = $${params.length}`;
  }
  params.push(limit);
  return streamRows<Contract>(
    pool,
    `${SELECT} ${FROM} ${where} ORDER BY e.priority_score DESC, e.entity_name LIMIT $${params.length}`,
    params,
  );
}

/** All exports of one file, streamed. */
export function streamFileExports(pool: pg.Pool, service: string, path: string, limit: number): AsyncGenerator<Contract> {
  return streamRows<Contract>(
    pool,
    `${SELECT} ${FROM} WHERE e.service_name = $1 AND e.file_path = $2 ORDER BY e.entity_name LIMIT $3`,
    [service, path, limit],
  );
}

/**
 * Files that import a file. The graph links files, not individual exports, so this cannot say
 * which export an importer uses.
 */
export async function getImporters(pool: pg.Pool, service: string, path: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT from_file
     FROM codebase_edges
     WHERE service_name = $1 AND to_file = $2
     ORDER BY from_file`,
    [service, path],
  );
  return rows.map((r) => r.from_file as string);
}

/** Names of every indexed service, alphabetical. */
export async function listServices(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query('SELECT DISTINCT service_name FROM codebase_files ORDER BY service_name');
  return rows.map((r) => r.service_name as string);
}

/** All exports of one service ranked by priority, streamed. */
export function streamServiceExports(pool: pg.Pool, service: string, limit: number): AsyncGenerator<Contract> {
  return streamRows<Contract>(
    pool,
    `${SELECT} ${FROM} WHERE e.service_name = $1 ORDER BY e.priority_score DESC, e.entity_name LIMIT $2`,
    [service, limit],
  );
}

/** Search exports by entity type with an optional keyword filter, best first. */
export async function searchByType(pool: pg.Pool, type: string, query?: string, service?: string, limit = 50): Promise<Contract[]> {
  const params: (string | number)[] = [type];
  let where = 'WHERE e.entity_type = $1';
  if (service) {
    params.push(service);
    where += ` AND e.service_name = $${params.length}`;
  }
  const tokens = query ? tokenize(query) : [];
  const relevance = tokens.length ? buildRelevanceClause(tokens, params) : '0';
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM (${SELECT}, ${relevance} AS relevance ${FROM} ${where}) s
      ${tokens.length ? 'WHERE relevance > 0' : ''}
      ORDER BY relevance * 10 + priority_score DESC, name
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** All exports in a stable order, for paging with offset/limit. */
export function streamAllExports(pool: pg.Pool, offset: number, limit: number): AsyncGenerator<Contract> {
  return streamRows<Contract>(
    pool,
    `${SELECT} ${FROM} ORDER BY e.service_name, e.file_path, e.entity_name OFFSET $1 LIMIT $2`,
    [offset, limit],
  );
}

export interface DependencyEdge {
  service: string;
  from: string;
  to: string;
}

/** File-to-file import edges, optionally for one service, streamed. */
export function streamEdges(pool: pg.Pool, limit: number, service?: string): AsyncGenerator<DependencyEdge> {
  const params: (string | number)[] = [];
  let where = '';
  if (service) {
    params.push(service);
    where = 'WHERE service_name = $1';
  }
  params.push(limit);
  return streamRows<DependencyEdge>(
    pool,
    `SELECT service_name AS service, from_file AS "from", to_file AS "to"
       FROM codebase_edges ${where}
      ORDER BY service_name, from_file, to_file LIMIT $${params.length}`,
    params,
  );
}
