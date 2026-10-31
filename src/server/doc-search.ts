import { config } from '../config.js';
import { searchDocs, type SearchResult } from '../db/docs.js';
import { triage } from '../triage/lmstudio.js';

/**
 * Search documentation with PostgreSQL full-text search and local AI relevance scoring.
 * Returns documents that match the query, scored by both full-text search and AI relevance.
 */
export async function searchDocuments(query: string, pool: any, service?: string): Promise<{ query: string; results: DocumentResult[] }> {
  // Stage 1: PostgreSQL full-text search
  const dbResults = await searchDocs(pool, query, 20, service);

  if (!dbResults.length) {
    return { query, results: [] };
  }

  // Stage 2: Local AI relevance scoring (if enabled)
  if (config.triage.enabled) {
    const { mode, contracts } = await triageDocs(query, dbResults);
    // Map triage results back to our format
    const triagedIds = new Set(contracts.map((c) => c.id));
    const results = dbResults.map((r, i) => ({
      id: i,
      service: r.service,
      path: r.path,
      name: r.name,
      content: r.content,
      language: r.language,
      rank: r.rank,
      aiRelevance: triagedIds.has(i) ? 1 : 0,
    }));
    return { query, results };
  }

  // Fallback: return DB results without AI scoring
  return {
    query,
    results: dbResults.map((r, i) => ({
      id: i,
      service: r.service,
      path: r.path,
      name: r.name,
      content: r.content,
      language: r.language,
      rank: r.rank,
      aiRelevance: 0,
    })),
  };
}

interface DocumentResult {
  id: number;
  service: string;
  path: string;
  name: string;
  content: string;
  language: string;
  rank: number;
  aiRelevance: number;
}

interface TriageDoc {
  id: number;
  content: string;
  path: string;
}

interface TriageResult {
  mode: string;
  contracts: TriageDoc[];
}

/** Use local AI to score document relevance. */
async function triageDocs(query: string, results: SearchResult[]): Promise<TriageResult> {
  // Prepare content for AI (fit within token limit)
  const maxTokens = config.docs.maxTokens;
  const estimatedCharsPerToken = 4;
  const maxChars = maxTokens * estimatedCharsPerToken;

  const docs = results.slice(0, 10).map((r, i) => ({
    id: i,
    content: r.content.slice(0, maxChars),
    path: r.path,
  }));

  if (docs.length === 0) {
    return { mode: 'fallback', contracts: [] };
  }

  try {
    const list = docs
      .map((d, i) => `[${i}] ${d.path}\n${d.content}`)
      .join('\n\n---\n\n');

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
            content: `You score documentation relevance for a search query. Given a query and numbered document excerpts, return the indexes of the most relevant documents (max 5). Score based on how well the document answers the query. Answer only with JSON: {"selected":[0,1]}`,
          },
          { role: 'user', content: `Query: ${query}\n\nDocuments:\n${list}` },
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
      if (Number.isInteger(i) && i >= 0 && i < docs.length) seen.add(i as number);
    }

    return { mode: 'llm', contracts: docs.filter((d) => seen.has(d.id)) };
  } catch (err) {
    console.error(`doc triage skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { mode: 'fallback', contracts: docs };
  }
}
