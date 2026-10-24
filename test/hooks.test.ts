import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatContext } from '../src/hooks/handlers.js';
import { installHooks } from '../src/hooks/install.js';
import type { Contract } from '../src/db/index.js';

const project = () => mkdtempSync(path.join(tmpdir(), 'crag-proj-'));
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('install adds the three hooks, keeps other settings, and is idempotent', () => {
  const dir = project();
  mkdirSync(path.join(dir, '.claude'));
  const file = path.join(dir, '.claude', 'settings.local.json');
  writeFileSync(file, JSON.stringify({
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));

  assert.equal(installHooks({ projectDir: dir }).changed, true);
  const once = read(file);
  assert.deepEqual(once.permissions, { allow: ['Bash(ls)'] });
  assert.equal(once.hooks.PreToolUse.length, 2); // theirs + ours
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(once.hooks.PreToolUse[1].matcher, 'mcp__contract-rag__.*');
  assert.match(once.hooks.PostToolUse[0].hooks[0].command, / hook usage$/);
  assert.match(once.hooks.UserPromptSubmit[0].hooks[0].command, / hook context$/);
  assert.equal(once.hooks.UserPromptSubmit[0].matcher, undefined);

  assert.equal(installHooks({ projectDir: dir }).changed, false);
  assert.deepEqual(read(file), once);
});

test('uninstall removes only our hooks', () => {
  const dir = project();
  const file = path.join(dir, '.claude', 'settings.local.json');
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  installHooks({ projectDir: dir });
  installHooks({ projectDir: dir, uninstall: true });
  assert.deepEqual(read(file), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } });
});

test('--shared writes settings.json and uninstall on a clean project creates nothing', () => {
  const dir = project();
  assert.equal(installHooks({ projectDir: dir, uninstall: true }).changed, false);
  assert.equal(existsSync(path.join(dir, '.claude')), false);
  const { file } = installHooks({ projectDir: dir, shared: true });
  assert.equal(path.basename(file), 'settings.json');
});

test('formatContext lists contracts compactly and respects the size cap', () => {
  const c = (name: string): Contract => ({
    id: 1, service: 'web', language: 'typescript', path: 'src/utils/money.ts', name, type: 'function',
    signature: 'function formatCurrency(value: number): string\nsecond line', description: 'Formats money.', usedBy: 3,
  });
  const text = formatContext([c('formatCurrency')], 1500);
  assert.match(text, /- formatCurrency \[function\] web:src\/utils\/money\.ts :: function formatCurrency\(value: number\): string \/\/ Formats money\./);
  assert.ok(!text.includes('second line'));
  assert.equal(formatContext(Array.from({ length: 50 }, (_, i) => c(`fn${i}`)), 300).length, 300);
});
