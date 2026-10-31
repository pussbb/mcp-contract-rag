import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, getChangedDocPaths } from '../src/parser/docs.js';

describe('document extraction', () => {
  it('does not classify newly added documents as changed', () => {
    const stored = new Map([
      ['docs/old.md', { hash: 'old-hash', size: 10, mtime: 1 }],
      ['docs/changed.md', { hash: 'previous-hash', size: 10, mtime: 1 }],
    ]);
    const paths = ['docs/new.md', 'docs/changed.md', 'docs/unchanged.md'];
    const hashes = new Map([
      ['docs/new.md', 'new-hash'],
      ['docs/changed.md', 'current-hash'],
      ['docs/unchanged.md', 'unchanged-hash'],
    ]);

    assert.deepEqual(getChangedDocPaths(paths, stored, hashes), ['docs/changed.md']);
  });

  it('detects markdown language from extension', () => {
    assert.equal(detectLanguage('README.md'), 'markdown');
    assert.equal(detectLanguage('docs/index.markdown'), 'markdown');
  });

  it('detects rst language from extension', () => {
    assert.equal(detectLanguage('conf.py'), 'unknown');
    assert.equal(detectLanguage('docs/api.rst'), 'rst');
  });

  it('detects text language from extension', () => {
    assert.equal(detectLanguage('LICENSE.txt'), 'text');
  });
});
