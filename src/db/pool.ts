import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../config.js';

/** Bump when database/schema.sql changes; the file is idempotent and re-applied on mismatch. */
const SCHEMA_VERSION = 2;

/** All tables live in `database.schema`; unqualified names resolve through search_path. */
export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolSize,
    options: `-c search_path=${config.database.schema},public`,
  });
}

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  const ns = config.database.schema;
  const meta = await pool.query(`SELECT to_regclass($1) AS t`, [`${ns}.codebase_meta`]);
  if (meta.rows[0].t) {
    const { rows } = await pool.query(`SELECT value FROM codebase_meta WHERE key = 'schema_version'`);
    if (rows[0] && Number(rows[0].value) >= SCHEMA_VERSION) return;
  }
  const ddl = await readFile(new URL('../../database/schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7340120)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${ns}"`);
    await client.query(ddl);
    await client.query(
      `INSERT INTO codebase_meta (key, value) VALUES ('schema_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(SCHEMA_VERSION)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
