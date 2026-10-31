import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from '../src/parser/docs.js';

describe('document extraction', () => {
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
