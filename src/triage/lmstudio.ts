import { config } from '../config.js';
import type { Contract } from '../db/index.js';

export type TriageMode = 'llm' | 'fallback' | 'off';

export interface TriageResult {
  mode: TriageMode;
  contracts: Contract[];
}

/**
 * Tier 2: ask a small local model which candidates fit the query. The model only returns
 * indexes; contracts are mapped back from the database rows so it cannot alter signatures.
 * Any failure (offline, timeout, bad JSON, empty pick) returns the Tier 1 rows unchanged.
 */
export async function triage(query: string, candidates: Contract[]): Promise<TriageResult> {
  if (!config.triage.enabled) return { mode: 'off', contracts: candidates };
  if (candidates.length <= config.triage.keep) return { mode: 'fallback', contracts: candidates };
  try {
    const picked = await askModel(query, candidates);
    if (picked.length) return { mode: 'llm', contracts: picked };
  } catch (err) {
    console.error(`triage skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { mode: 'fallback', contracts: candidates };
}

async function askModel(query: string, candidates: Contract[]): Promise<Contract[]> {
  const list = candidates
    .map((c, i) => `[${i}] ${c.name} (${c.type}) in ${c.service}:${c.path}\n    ${c.signature.split('\n')[0]}\n    ${c.description ?? ''}`)
    .join('\n');
  const res = await fetch(`${config.triage.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(config.triage.timeoutMs),
    body: JSON.stringify({
      model: config.triage.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You select existing internal code that a developer can reuse. Given a request and numbered candidates, return the indexes of the ${config.triage.keep} best matches at most, best first. Skip candidates that are unrelated, incompatible or deprecated. Answer only with JSON: {"selected":[0,1]}`,
        },
        { role: 'user', content: `Request: ${query}\n\nCandidates:\n${list}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'selection',
          strict: true,
          schema: {
            type: 'object',
            properties: { selected: { type: 'array', items: { type: 'integer' } } },
            required: ['selected'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed: unknown = JSON.parse(data.choices?.[0]?.message?.content ?? '');
  const selected = (parsed as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) throw new Error('malformed triage response');
  const seen = new Set<number>();
  for (const i of selected) {
    if (Number.isInteger(i) && i >= 0 && i < candidates.length) seen.add(i as number);
  }
  return [...seen].slice(0, config.triage.keep).map((i) => candidates[i]!);
}
