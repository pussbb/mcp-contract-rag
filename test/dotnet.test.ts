import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageForNamespace, resolveDotnetEdges } from '../src/parser/dotnet.js';
import type { Analysis } from '../src/parser/extract.js';

const file = (ns: string, names: string[], imports: string[], references: string[]): Analysis => ({
  exports: names.map((name) => ({ name, type: 'class', signature: '', description: null, namespace: ns })),
  imports,
  references,
});

test('edges follow referenced types visible through using or namespace', () => {
  const edges = resolveDotnetEdges(new Map([
    ['A.cs', file('App.Services', ['Svc'], ['App.Helpers'], ['Money', 'Other', 'Svc'])],
    ['B.cs', file('App.Helpers', ['Money'], [], [])],
    ['C.cs', file('Elsewhere', ['Other'], [], [])], // not imported, not a parent namespace
    ['D.cs', file('App', ['Root'], [], [])],
    ['E.cs', file('App.Services.Deep', ['Deep'], [], ['Root'])], // parent namespace App is visible
  ]));
  assert.deepEqual([...edges.get('A.cs')!], ['B.cs']);
  assert.deepEqual([...edges.get('E.cs')!], ['D.cs']);
});

test('namespace maps to the longest matching NuGet package', () => {
  const pkgs = ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Relational', 'Newtonsoft.Json'];
  assert.equal(packageForNamespace('Microsoft.EntityFrameworkCore.Relational.Query', pkgs), 'Microsoft.EntityFrameworkCore.Relational');
  assert.equal(packageForNamespace('newtonsoft.json.Linq', pkgs), 'Newtonsoft.Json');
  assert.equal(packageForNamespace('System.Linq', pkgs), null);
});
