import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSource } from '../src/parser/extract.js';

test('extracts functions, hooks, components, types and cleans JSDoc', () => {
  const code = `
import { x } from './x';
export * from './barrel';
/**
 * Formats a number as money. {@link Intl}
 * @deprecated
 */
export function formatCurrency(value: number, loc?: string): string { return ''; }
export const useAuth = (id: string): User => ({} as User);
export const Button = ({ label }: Props) => <button>{label}</button>;
export interface User { id: string }
export type Id = string;
const hidden = 1;
export { hidden as visible };
export default function Page() { return null; }
`;
  const { exports, imports } = analyzeSource(code, 'src/a.tsx');
  const by = Object.fromEntries(exports.map((e) => [e.name, e]));
  assert.deepEqual(imports, ['./x', './barrel']);
  assert.equal(by.formatCurrency!.signature, 'function formatCurrency(value: number, loc?: string): string');
  assert.equal(by.formatCurrency!.description, '[deprecated] Formats a number as money. Intl');
  assert.equal(by.useAuth!.type, 'hook');
  assert.equal(by.Button!.type, 'component');
  assert.equal(by.User!.type, 'interface');
  assert.equal(by.Id!.type, 'type');
  assert.equal(by.visible!.type, 'const');
  assert.equal(by.Page!.type, 'component');
});

test('abstract classes keep inheritance and abstract members', () => {
  const code = `export abstract class Repo extends Base {
  abstract find(id: string): Promise<Item>;
  save(item: Item): void {}
  private secret = 1;
}`;
  const [cls] = analyzeSource(code, 'src/repo.ts').exports;
  assert.equal(cls!.type, 'abstract_class');
  assert.match(cls!.signature, /^abstract class Repo extends Base \{/);
  assert.match(cls!.signature, /abstract find\(id: string\): Promise<Item>/);
  assert.doesNotMatch(cls!.signature, /secret/);
});

test('field usage: counts fields read off imported hook results', () => {
  const code = `
import { useAuth } from '../hooks/useAuth';
import other, { helper as h } from './other';
export const A = () => {
  const { user, isViewer: v } = useAuth();
  const auth = useAuth();
  const again = auth.user;
  const x = auth?.isCompanyAdmin;
  const { isViewer } = auth;
  const r = other();
  return r.value + h().n;
};`;
  const { fieldUsage } = analyzeSource(code, 'src/a.tsx');
  const auth = fieldUsage!.find((f) => f.entityName === 'useAuth')!;
  assert.equal(auth.source, '../hooks/useAuth');
  assert.deepEqual(
    Object.fromEntries(auth.fields.map((f) => [f.name, f.count])),
    { user: 2, isViewer: 2, isCompanyAdmin: 1 },
  );
  const def = fieldUsage!.find((f) => f.entityName === 'default')!;
  assert.deepEqual(def.fields, [{ name: 'value', count: 1 }]);
});
