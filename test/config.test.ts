import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const write = (yaml: string) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'crag-')), 'contract-rag.yaml');
  writeFileSync(file, yaml);
  return file;
};

test('yaml values override defaults and expand ${ENV:-default}', () => {
  process.env.CRAG_TEST_SCHEMA = 'from_env';
  const cfg = loadConfig(write(`
database:
  schema: \${CRAG_TEST_SCHEMA:-fallback}
  url: \${CRAG_UNSET_VAR:-postgres://x/y}
triage:
  enabled: \${CRAG_UNSET_FLAG:-false}
  keep: "2"
services:
  - { name: api, root: src }
`));
  assert.equal(cfg.database.schema, 'from_env');
  assert.equal(cfg.database.url, 'postgres://x/y');
  assert.equal(cfg.triage.enabled, false);
  assert.equal(cfg.triage.keep, 2);
  assert.equal(cfg.search.tier1Limit, 12);
  assert.ok(cfg.services[0]!.root.endsWith(path.join('', 'src')));
});

test('invalid config is rejected with a readable error', () => {
  assert.throws(() => loadConfig(write('database:\n  schema: "bad-name; drop"\n')), /plain PostgreSQL identifier/);
});

test('missing file falls back to defaults with one service', () => {
  const cfg = loadConfig(path.join(tmpdir(), 'does-not-exist.yaml'));
  assert.equal(cfg.file, null);
  assert.equal(cfg.services.length, 1);
});
