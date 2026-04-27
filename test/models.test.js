import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getModelInfo, resolveModel } from '../src/models.js';

describe('resolveModel', () => {
  it('resolves bare claude-4.6 variants to sonnet keys', () => {
    assert.equal(resolveModel('claude-4.6'), 'claude-sonnet-4.6');
    assert.equal(resolveModel('claude-4.6-thinking'), 'claude-sonnet-4.6-thinking');
    assert.equal(resolveModel('claude-4.6-1m'), 'claude-sonnet-4.6-1m');
    assert.equal(resolveModel('claude-4.6-thinking-1m'), 'claude-sonnet-4.6-thinking-1m');
  });

  it('maps bare claude-4.6 to a real catalog entry', () => {
    const info = getModelInfo(resolveModel('claude-4.6'));
    assert.ok(info);
    assert.equal(info.modelUid, 'claude-sonnet-4-6');
  });

  it('preserves unknown models for explicit model_not_found handling', () => {
    assert.equal(resolveModel('nonexistent-model-xyz'), 'nonexistent-model-xyz');
  });
});
