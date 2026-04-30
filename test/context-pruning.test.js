import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOversizedContextReason } from '../src/context-pruning.js';

const originalEnv = {
  MAX_CONTEXT_CHARS: process.env.MAX_CONTEXT_CHARS,
  MAX_TOOL_RESULT_CHARS: process.env.MAX_TOOL_RESULT_CHARS,
  MAX_CONTEXT_MESSAGES: process.env.MAX_CONTEXT_MESSAGES,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('context pruning limits', () => {
  it('rejects 200k+ agent history by default', () => {
    assert.equal(
      getOversizedContextReason({
        inputChars: 210_000,
        toolResultChars: 8_000,
        messages: 16,
      }),
      'input_chars',
    );
  });

  it('rejects large retained tool_result history by default', () => {
    assert.equal(
      getOversizedContextReason({
        inputChars: 90_000,
        toolResultChars: 80_000,
        messages: 16,
      }),
      'tool_result_chars',
    );
  });

  it('allows operators to raise the limits explicitly', () => {
    process.env.MAX_CONTEXT_CHARS = '260000';
    process.env.MAX_TOOL_RESULT_CHARS = '100000';

    assert.equal(
      getOversizedContextReason({
        inputChars: 210_000,
        toolResultChars: 80_000,
        messages: 16,
      }),
      null,
    );
  });
});
