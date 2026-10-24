/**
 * Serializes an async sequence as a JSON array one item at a time, so no full array of
 * objects is ever built. Yields small string chunks: `[`, each item (comma-separated, one per
 * line), `]`.
 */
export async function* jsonArray<T, U = T>(items: AsyncIterable<T>, map: (item: T) => U = (x) => x as unknown as U): AsyncGenerator<string> {
  yield '[';
  let first = true;
  for await (const item of items) {
    yield `${first ? '\n' : ',\n'}${JSON.stringify(map(item))}`;
    first = false;
  }
  yield first ? ']' : '\n]';
}

/**
 * MCP delivers a tool result as one message, so the chunks are joined at the end. The same
 * generator can be piped to an HTTP response (`Readable.from(jsonArray(...))`) to stream for real.
 */
export async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return parts.join('');
}
