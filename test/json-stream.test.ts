import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectText, jsonArray } from '../src/server/json-stream.js';

async function* numbers(n: number): AsyncGenerator<{ id: number }> {
  for (let i = 1; i <= n; i++) yield { id: i };
}

test('jsonArray yields chunks that join into valid JSON', async () => {
  const chunks: string[] = [];
  for await (const c of jsonArray(numbers(3), (x) => ({ n: x.id }))) chunks.push(c);
  assert.equal(chunks[0], '[');
  assert.equal(chunks.length, 5); // '[', 3 items, ']'
  assert.deepEqual(JSON.parse(chunks.join('')), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('empty sequence is an empty array', async () => {
  assert.deepEqual(JSON.parse(await collectText(jsonArray(numbers(0)))), []);
});

test('source errors propagate and stop iteration', async () => {
  async function* broken(): AsyncGenerator<number> { yield 1; throw new Error('db down'); }
  await assert.rejects(collectText(jsonArray(broken())), /db down/);
});
