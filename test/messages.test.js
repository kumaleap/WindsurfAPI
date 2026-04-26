import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRiskyReadToolResult, handleMessages } from '../src/handlers/messages.js';

describe('Anthropic messages request translation', () => {
  afterEach(() => {
    // No shared mutable state in these tests, but keep the hook here so this
    // file stays symmetric with the stateful auth/rate-limit tests.
  });

  it('passes thinking through to the chat handler and preserves reasoning in the response', async () => {
    let capturedBody = null;
    const thinking = { type: 'enabled', budget_tokens: 64 };
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      thinking,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', reasoning_content: 'plan', content: 'done' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });

    assert.deepEqual(capturedBody.thinking, thinking);
    assert.equal(result.status, 200);
    assert.equal(result.body.content[0].type, 'thinking');
    assert.equal(result.body.content[0].thinking, 'plan');
    assert.equal(result.body.content[1].type, 'text');
    assert.equal(result.body.content[1].text, 'done');
  });

  it('maps Anthropic tool_choice variants to OpenAI shapes', async () => {
    const cases = [
      { input: { type: 'auto' }, expected: 'auto' },
      { input: { type: 'any' }, expected: 'required' },
      { input: { type: 'tool', name: 'Read' }, expected: { type: 'function', function: { name: 'Read' } } },
      { input: { type: 'none' }, expected: 'none' },
    ];

    for (const testCase of cases) {
      let capturedBody = null;
      const result = await handleMessages({
        model: 'claude-sonnet-4.6',
        tool_choice: testCase.input,
        messages: [{ role: 'user', content: 'hi' }],
      }, {
        async handleChatCompletions(body) {
          capturedBody = body;
          return {
            status: 200,
            body: {
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          };
        },
      });

      assert.equal(result.status, 200);
      assert.deepEqual(capturedBody.tool_choice, testCase.expected);
    }
  });

  it('annotates risky Read tool_result stubs before Cascade sees them', async () => {
    let capturedBody = null;
    await handleMessages({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'review files' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'big.md' } },
        ] },
        { role: 'user', content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: 'File content (377.3KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.',
          },
        ] },
      ],
    }, {
      async handleChatCompletions(body) {
        capturedBody = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    });

    const toolMsg = capturedBody.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /does not prove the full file body/);
    assert.match(toolMsg.content, /offset\/limit/);
  });

  it('does not annotate normal Read output or non-Read tool results', () => {
    const normal = '1\t# README\n2\tActual content';
    assert.equal(
      annotateRiskyReadToolResult(normal, { toolName: 'Read' }),
      normal,
    );
    const bashStub = 'File content (377.3KB) exceeds maximum allowed size (256KB). Use offset and limit parameters.';
    assert.equal(
      annotateRiskyReadToolResult(bashStub, { toolName: 'Bash', isError: true }),
      bashStub,
    );
  });

  it('does not annotate line-numbered real body that contains stub keywords', () => {
    const realBody = '1\t// previously cached value\n2\tconst x = 1;\n3\t// content was truncated last run\n4\tconst y = 2;';
    assert.equal(
      annotateRiskyReadToolResult(realBody, { toolName: 'Read' }),
      realBody,
    );
    const cnBody = '1\t// 内容未变更：保留旧值\n2\tconst foo = 1;';
    assert.equal(
      annotateRiskyReadToolResult(cnBody, { toolName: 'Read' }),
      cnBody,
    );
  });

  it('annotates real Claude Code cached-unchanged stub', () => {
    const cachedStub = 'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current.';
    const out = annotateRiskyReadToolResult(cachedStub, { toolName: 'Read' });
    assert.match(out, /does not prove the full file body/);
  });
});
