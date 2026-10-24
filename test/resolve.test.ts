import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createResolver, externalPackage } from '../src/parser/resolve.js';

test('python imports resolve to modules and packages in the service', () => {
  const known = new Set(['app/base.py', 'app/utils/money.py', 'app/utils/__init__.py']);
  const resolve = createResolver(tmpdir(), known);
  assert.equal(resolve('app/base.py', '.utils.money'), 'app/utils/money.py');
  assert.equal(resolve('app/base.py', 'app.utils'), 'app/utils/__init__.py');
  assert.equal(resolve('app/utils/money.py', '.'), 'app/utils/__init__.py');
  assert.equal(resolve('app/base.py', 'requests'), null);
});

test('external package names', () => {
  assert.equal(externalPackage('@babel/parser/lib', 'typescript'), '@babel/parser');
  assert.equal(externalPackage('lodash/fp', 'typescript'), 'lodash');
  assert.equal(externalPackage('node:fs', 'typescript'), null);
  assert.equal(externalPackage('fs', 'typescript'), null);
  assert.equal(externalPackage('@/utils/x', 'typescript'), null);
  assert.equal(externalPackage('requests.adapters', 'python'), 'requests');
});
