import type pg from 'pg';

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

const STOPWORDS = new Set(['the', 'for', 'and', 'with', 'from', 'that', 'this', 'into', 'how', 'use']);

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
export async function searchExports(pool: pg.Pool, query: string, limit: number, service?: string): Promise<Contract[]> {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const params: (string | number)[] = [];
  const relevanceClause = buildRelevanceClause(tokens, params);

  let where = '';
  if (service) {
    params.push(service);
    where = `WHERE e.service_name = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM (${SELECT}, ${relevanceClause} AS relevance ${FROM} ${where}) s
      WHERE relevance > 0
      ORDER BY relevance * 10 + priority_score DESC, name
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function topExports(pool: pg.Pool, limit: number): Promise<Contract[]> {
  const { rows } = await pool.query(
    `${SELECT} ${FROM} ORDER BY e.priority_score DESC, e.entity_name LIMIT $1`,
    [limit],
  );
  return rows;
}
