import type pg from 'pg';
import Cursor from 'pg-cursor';
import { config } from '../config.js';

/**
 * Streams rows of a query from PostgreSQL through a server-side cursor, `batchSize` rows per
 * round trip (the async equivalent of fetchmany). Memory stays bounded to one batch however many
 * rows match. A connection is held until the generator finishes or is closed early.
 */
export async function* streamRows<T extends object>(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
  batchSize = config.search.streamBatchSize,
): AsyncGenerator<T> {
  const client = await pool.connect();
  const cursor = client.query(new Cursor<T>(sql, params));
  try {
    for (let rows = await cursor.read(batchSize); rows.length; rows = await cursor.read(batchSize)) {
      yield* rows;
    }
  } finally {
    await cursor.close();
    client.release();
  }
}
