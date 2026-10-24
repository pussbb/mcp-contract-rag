import type pg from 'pg';

export interface ToolUsage {
  tool: string;
  sessionId?: string | null;
  input?: unknown;
  responseBytes?: number | null;
}

export async function recordToolUsage(pool: pg.Pool, usage: ToolUsage): Promise<void> {
  await pool.query(
    `INSERT INTO codebase_tool_usage (tool_name, session_id, input, response_bytes) VALUES ($1, $2, $3, $4)`,
    [usage.tool, usage.sessionId ?? null, usage.input === undefined ? null : JSON.stringify(usage.input), usage.responseBytes ?? null],
  );
}

export interface UsageSummaryRow {
  tool: string;
  calls: number;
  avgResponseBytes: number | null;
  lastCalledAt: Date;
}

export async function usageSummary(pool: pg.Pool): Promise<UsageSummaryRow[]> {
  const { rows } = await pool.query(
    `SELECT tool_name AS tool, count(*)::int AS calls,
            round(avg(response_bytes))::int AS "avgResponseBytes", max(called_at) AS "lastCalledAt"
       FROM codebase_tool_usage GROUP BY tool_name ORDER BY calls DESC, tool_name`,
  );
  return rows;
}
