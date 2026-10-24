import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';

// End-to-end: index the fixtures into a throwaway PostgreSQL schema, then call the real MCP server.
// Skipped when PostgreSQL is not reachable.
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/contract_rag';
const SCHEMA = 'contract_rag_test';
const repo = path.resolve(import.meta.dirname, '..');

const admin = new pg.Pool({ connectionString: url, max: 1 });
const dbUp = await admin.query('SELECT 1').then(() => true, () => false);

let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  assert.ok(!res.isError, text);
  return JSON.parse(text);
};

before(async () => {
  if (!dbUp) return;
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'crag-e2e-')), 'contract-rag.yaml');
  writeFileSync(file, `
database:
  url: ${url}
  schema: ${SCHEMA}
triage:
  enabled: false
services:
  - { name: py-fixture, root: ${path.join(repo, 'test/fixtures/py-service')} }
  - { name: cs-fixture, root: ${path.join(repo, 'test/fixtures/cs-service')} }
`);
  const env = { ...process.env, CONTRACT_RAG_CONFIG: file } as Record<string, string>;
  execFileSync('yarn', ['--silent', 'index'], { cwd: repo, env, stdio: 'ignore' });
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'yarn', args: ['--silent', 'start'], cwd: repo, env }));
});

after(async () => {
  await client?.close();
  if (dbUp) await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

const opts = { skip: !dbUp && 'PostgreSQL not reachable', timeout: 300_000 };

test('match_internal_utilities finds a contract and reports triage mode', opts, async () => {
  const r = await call('match_internal_utilities', { query: 'money format', service: 'cs-fixture' });
  assert.equal(r.triage, 'off');
  assert.equal(r.contracts[0].name, 'MoneyFormatter');
});

test('find_symbol returns exact matches as a JSON array', opts, async () => {
  const r = await call('find_symbol', { name: 'format_currency' });
  assert.deepEqual(r.map((c: { path: string }) => c.path), ['app/utils/money.py']);
  assert.deepEqual(await call('find_symbol', { name: 'does_not_exist' }), []);
});

test('list_file_exports lists every contract of a file', opts, async () => {
  const r = await call('list_file_exports', { service: 'cs-fixture', path: 'Domain/Repository.cs' });
  assert.deepEqual(r.map((c: { name: string }) => c.name).sort(), ['IRepository', 'Invoice', 'Repository', 'Status']);
});

test('get_importers returns files that depend on a file', opts, async () => {
  const r = await call('get_importers', { service: 'cs-fixture', path: 'Helpers/MoneyFormatter.cs' });
  assert.deepEqual(r.importers, ['Services/InvoiceService.cs']);
});

test('search_by_type filters by type, with and without a keyword', opts, async () => {
  const all = await call('search_by_type', { type: 'abstract_class' });
  assert.ok(all.some((c: { name: string }) => c.name === 'Repository'));
  const keyed = await call('search_by_type', { type: 'abstract_class', query: 'exporter', service: 'py-fixture' });
  assert.deepEqual(keyed.map((c: { name: string }) => c.name), ['Exporter']);
});

test('resources: high-priority and per-service template', opts, async () => {
  const top = await client.readResource({ uri: 'codebase://exports/high-priority' });
  assert.ok(JSON.parse((top.contents[0] as { text: string }).text).length > 0);
  const svc = await client.readResource({ uri: 'codebase://exports/service/py-fixture' });
  const rows = JSON.parse((svc.contents[0] as { text: string }).text);
  assert.ok(rows.length > 0 && rows.every((c: { service: string }) => c.service === 'py-fixture'));
});
