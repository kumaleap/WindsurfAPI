/**
 * POST /v1/responses — OpenAI Responses API compatibility layer.
 *
 * Translates Responses requests/responses to/from the existing
 * chat.completions handler so OpenAI-compatible upstream consumers
 * (notably sub2api OpenAI API key accounts) can use WindsurfAPI as a
 * full-model upstream without per-model Anthropic shims.
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions } from './chat.js';
import { log } from '../config.js';

function genResponseId() {
  return 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genItemId() {
  return 'item_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.output === 'string') return part.output;
    if (typeof part?.image_url === 'string') return `[image:${part.image_url.slice(0, 32)}]`;
    return '';
  }).join('');
}

function normalizeResponseInputContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (part?.type === 'input_text' || part?.type === 'output_text') {
      return { type: 'text', text: part.text || '' };
    }
    if (part?.type === 'input_image') {
      return {
        type: 'image_url',
        image_url: { url: part.image_url || '' },
      };
    }
    if (typeof part?.text === 'string') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'text',
      text: JSON.stringify(part),
    };
  });
}

function responsesToOpenAI(body) {
  const messages = [];

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() });
  }

  const appendRoleMessage = (item) => {
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
    messages.push({
      role,
      content: normalizeResponseInputContent(item.content),
    });
  };

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;

      if (item.role) {
        appendRoleMessage(item);
        continue;
      }

      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
            type: 'function',
            function: {
              name: item.name || 'unknown',
              arguments: item.arguments || '{}',
            },
          }],
        });
        continue;
      }

      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: item.output || '(empty)',
        });
      }
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
      .filter((tool) => tool?.type === 'function' && tool?.name)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {},
        },
      }))
    : [];

  const openAIBody = {
    model: body.model,
    messages,
    stream: !!body.stream,
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {}),
  };

  return openAIBody;
}

function usageToResponses(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (inputTokens + outputTokens);
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(cachedTokens ? { input_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(reasoningTokens ? { output_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
  };
}

function openAIToResponses(result, requestedModel, responseId) {
  const choice = result?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];

  if (message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: genItemId(),
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const toolCall of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: genItemId(),
        call_id: toolCall.id,
        name: toolCall.function?.name || 'unknown',
        arguments: toolCall.function?.arguments || '{}',
      });
    }
  }

  let textContent = '';
  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    textContent = extractTextFromParts(message.content);
  }

  if (textContent) {
    output.push({
      type: 'message',
      id: genItemId(),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: textContent }],
    });
  }

  const finishReason = choice.finish_reason || 'stop';
  const status = finishReason === 'length' ? 'incomplete' : 'completed';

  return {
    id: responseId,
    object: 'response',
    model: requestedModel || result?.model,
    status,
    output,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(usageToResponses(result?.usage) ? { usage: usageToResponses(result.usage) } : {}),
  };
}

class ResponsesStreamTranslator {
  constructor(res, responseId, model) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
    this.sequenceNumber = 0;
    this.pendingSseBuf = '';
    this.responseCreated = false;
    this.responseStopped = false;
    this.finalUsage = null;
    this.finishReason = 'stop';

    this.textItem = null;
    this.textOutputIndex = null;
    this.textBuffer = '';

    this.reasoningItem = null;
    this.reasoningOutputIndex = null;
    this.reasoningBuffer = '';

    this.toolCalls = new Map();
    this.nextOutputIndex = 0;
  }

  send(payload) {
    if (this.res.writableEnded) return;
    const evt = {
      ...payload,
      sequence_number: this.sequenceNumber++,
    };
    this.res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  startResponse() {
    if (this.responseCreated) return;
    this.responseCreated = true;
    this.send({
      type: 'response.created',
      response: {
        id: this.responseId,
        object: 'response',
        model: this.model,
        status: 'in_progress',
        output: [],
      },
    });
  }

  ensureTextItem() {
    if (this.textItem) return;
    this.textItem = { id: genItemId() };
    this.textOutputIndex = this.nextOutputIndex++;
    this.send({
      type: 'response.output_item.added',
      output_index: this.textOutputIndex,
      item: {
        type: 'message',
        id: this.textItem.id,
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '' }],
      },
    });
  }

  ensureReasoningItem() {
    if (this.reasoningItem) return;
    this.reasoningItem = { id: genItemId() };
    this.reasoningOutputIndex = this.nextOutputIndex++;
    this.send({
      type: 'response.output_item.added',
      output_index: this.reasoningOutputIndex,
      item: {
        type: 'reasoning',
        id: this.reasoningItem.id,
        summary: [],
      },
    });
  }

  ensureToolCall(index, toolCall) {
    const key = index ?? 0;
    const existing = this.toolCalls.get(key);
    if (existing) {
      if (toolCall.id && !existing.callId) existing.callId = toolCall.id;
      if (toolCall.function?.name && !existing.name) existing.name = toolCall.function.name;
      return existing;
    }

    const entry = {
      itemId: genItemId(),
      outputIndex: this.nextOutputIndex++,
      callId: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
      name: toolCall.function?.name || 'unknown',
      arguments: '',
    };
    this.toolCalls.set(key, entry);

    this.send({
      type: 'response.output_item.added',
      output_index: entry.outputIndex,
      item: {
        type: 'function_call',
        id: entry.itemId,
        call_id: entry.callId,
        name: entry.name,
        arguments: '',
      },
    });

    return entry;
  }

  emitTextDelta(text) {
    if (!text) return;
    this.ensureTextItem();
    this.textBuffer += text;
    this.send({
      type: 'response.output_text.delta',
      output_index: this.textOutputIndex,
      content_index: 0,
      item_id: this.textItem.id,
      delta: text,
    });
  }

  emitReasoningDelta(text) {
    if (!text) return;
    this.ensureReasoningItem();
    this.reasoningBuffer += text;
    this.send({
      type: 'response.reasoning_summary_text.delta',
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      item_id: this.reasoningItem.id,
      delta: text,
    });
  }

  emitToolCallDelta(toolCall) {
    const entry = this.ensureToolCall(toolCall.index, toolCall);
    const argsChunk = toolCall.function?.arguments || '';
    if (!argsChunk) return;
    entry.arguments += argsChunk;
    this.send({
      type: 'response.function_call_arguments.delta',
      output_index: entry.outputIndex,
      item_id: entry.itemId,
      call_id: entry.callId,
      name: entry.name,
      delta: argsChunk,
    });
  }

  processChunk(chunk) {
    this.startResponse();
    const choice = chunk?.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitReasoningDelta(delta.reasoning_content);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) this.emitToolCallDelta(toolCall);
      }
      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason;
      }
    }
    if (chunk?.usage) this.finalUsage = chunk.usage;
  }

  closeOpenItems() {
    if (this.reasoningItem) {
      this.send({
        type: 'response.output_item.done',
        output_index: this.reasoningOutputIndex,
        item: {
          type: 'reasoning',
          id: this.reasoningItem.id,
          summary: this.reasoningBuffer
            ? [{ type: 'summary_text', text: this.reasoningBuffer }]
            : [],
        },
      });
    }

    if (this.textItem) {
      this.send({
        type: 'response.output_item.done',
        output_index: this.textOutputIndex,
        item: {
          type: 'message',
          id: this.textItem.id,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: this.textBuffer }],
        },
      });
    }

    for (const entry of this.toolCalls.values()) {
      this.send({
        type: 'response.output_item.done',
        output_index: entry.outputIndex,
        item: {
          type: 'function_call',
          id: entry.itemId,
          call_id: entry.callId,
          name: entry.name,
          arguments: entry.arguments,
        },
      });
    }
  }

  finish() {
    if (this.responseStopped) return;
    this.responseStopped = true;
    this.startResponse();
    this.closeOpenItems();

    const usage = usageToResponses(this.finalUsage);
    const completed = {
      id: this.responseId,
      object: 'response',
      model: this.model,
      status: this.finishReason === 'length' ? 'incomplete' : 'completed',
      output: [],
      ...(usage ? { usage } : {}),
      ...(this.finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };

    this.send({
      type: this.finishReason === 'length' ? 'response.incomplete' : 'response.completed',
      response: completed,
    });

    if (!this.res.writableEnded) {
      this.res.write('data: [DONE]\n\n');
    }
  }

  feed(rawChunk) {
    this.pendingSseBuf += typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    let idx;
    while ((idx = this.pendingSseBuf.indexOf('\n\n')) !== -1) {
      const frame = this.pendingSseBuf.slice(0, idx);
      this.pendingSseBuf = this.pendingSseBuf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          this.processChunk(JSON.parse(payload));
        } catch (err) {
          log.warn(`Responses SSE parse error: ${err.message}`);
        }
      }
    }
  }
}

function createCaptureRes(translator) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) {
      try { cb(); } catch {}
    }
  };

  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      translator.feed(chunk);
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

export async function handleResponses(body) {
  const responseId = genResponseId();
  const requestedModel = body.model;
  const wantStream = !!body.stream;
  const openaiBody = responsesToOpenAI(body);

  if (!wantStream) {
    const result = await handleChatCompletions({ ...openaiBody, stream: false });
    if (result.status !== 200) {
      return {
        status: result.status,
        body: {
          error: {
            type: result.body?.error?.type || 'api_error',
            message: result.body?.error?.message || 'Unknown error',
          },
        },
      };
    }
    return {
      status: 200,
      body: openAIToResponses(result.body, requestedModel, responseId),
    };
  }

  const streamResult = await handleChatCompletions({ ...openaiBody, stream: true });
  if (!streamResult.stream) {
    return {
      status: streamResult.status || 502,
      body: {
        error: {
          type: streamResult.body?.error?.type || 'api_error',
          message: streamResult.body?.error?.message || 'Upstream error',
        },
      },
    };
  }

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new ResponsesStreamTranslator(realRes, responseId, requestedModel);
      const captureRes = createCaptureRes(translator);

      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
      } catch (err) {
        log.error(`Responses stream error: ${err.message}`);
        translator.finish();
      }

      if (!realRes.writableEnded) realRes.end();
    },
  };
}
