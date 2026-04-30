function contentTextChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (typeof part?.text === 'string') chars += part.text.length;
    else if (typeof part?.content === 'string') chars += part.content.length;
    else if (Array.isArray(part?.content)) {
      for (const nested of part.content) {
        if (typeof nested?.text === 'string') chars += nested.text.length;
      }
    } else if (typeof part?.image_url?.url === 'string' || typeof part?.image_url === 'string') {
      chars += 1024;
    }
  }
  return chars;
}

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function contentToPreview(content, maxChars = 220) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((part) => {
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      if (typeof part?.image_url?.url === 'string' || typeof part?.image_url === 'string') return '[image]';
      return '';
    }).join('\n');
  } else if (content != null) {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars
    ? normalized.slice(0, Math.max(32, maxChars - 1)) + '…'
    : normalized;
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function topFunctionNames(counts, limit = 8) {
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`);
}

function buildCompactionSummary(stats) {
  const lines = [
    'Earlier tool history was condensed to keep this request responsive.',
    `Condensed ${stats.omittedAssistantToolTurns} older assistant tool-call turns and ${stats.omittedToolResults} older tool results.`,
    `Removed about ${stats.omittedToolChars} characters of raw tool output from the prompt.`,
  ];

  const topNames = topFunctionNames(stats.functionNames);
  if (topNames.length) {
    lines.push(`Earlier tool names: ${topNames.join(', ')}`);
  }

  if (stats.previews.length) {
    lines.push('Representative earlier tool-result snippets:');
    for (const preview of stats.previews) {
      lines.push(`- ${preview}`);
    }
  }

  lines.push('Use the remaining conversation as canonical context. Do not ask the user to resend omitted tool logs unless strictly necessary.');
  return lines.join('\n');
}

export function estimateOpenAIMessageChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const msg of messages) {
    chars += contentTextChars(msg?.content);
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        chars += (tc?.id || '').length;
        chars += (tc?.function?.name || '').length;
        chars += (tc?.function?.arguments || '').length;
      }
    }
    if (typeof msg?.tool_call_id === 'string') chars += msg.tool_call_id.length;
  }
  return chars;
}

export function summarizeOpenAIContext(messages) {
  const safe = Array.isArray(messages) ? messages : [];
  let toolResultCount = 0;
  let toolResultChars = 0;
  let assistantToolTurnCount = 0;
  let assistantToolCallCount = 0;

  for (const message of safe) {
    if (message?.role === 'tool') {
      toolResultCount++;
      toolResultChars += contentTextChars(message.content);
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      assistantToolTurnCount++;
      assistantToolCallCount += message.tool_calls.length;
    }
  }

  return {
    messages: safe.length,
    inputChars: estimateOpenAIMessageChars(safe),
    toolResultCount,
    toolResultChars,
    assistantToolTurnCount,
    assistantToolCallCount,
  };
}

export function compactOpenAIMessageHistory(messages, options = {}) {
  const keepTailMessages = Number.isFinite(options.keepTailMessages) ? options.keepTailMessages : 10;
  const keepTailToolMessages = Number.isFinite(options.keepTailToolMessages) ? options.keepTailToolMessages : 6;
  const maxPreviewCount = Number.isFinite(options.maxPreviewCount) ? options.maxPreviewCount : 6;
  const originalStats = summarizeOpenAIContext(messages);
  const safe = Array.isArray(messages) ? messages : [];

  const toolRelatedIndexes = [];
  for (let i = 0; i < safe.length; i++) {
    const message = safe[i];
    if (message?.role === 'tool') toolRelatedIndexes.push(i);
    else if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      toolRelatedIndexes.push(i);
    }
  }

  if (!toolRelatedIndexes.length) {
    return {
      messages: safe,
      stats: {
        compacted: false,
        original: originalStats,
        compactedStats: originalStats,
        omittedAssistantToolTurns: 0,
        omittedToolResults: 0,
        omittedToolChars: 0,
        summaryInserted: false,
      },
    };
  }

  const protectedIndexes = new Set();
  let keptSemanticTail = 0;
  for (let i = safe.length - 1; i >= 0 && keptSemanticTail < keepTailMessages; i--) {
    const message = safe[i];
    const isToolRelated = message?.role === 'tool'
      || (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length);
    if (isToolRelated) continue;
    protectedIndexes.add(i);
    keptSemanticTail++;
  }
  for (const index of toolRelatedIndexes.slice(-keepTailToolMessages)) protectedIndexes.add(index);

  const stats = {
    compacted: false,
    original: originalStats,
    compactedStats: null,
    omittedAssistantToolTurns: 0,
    omittedToolResults: 0,
    omittedToolChars: 0,
    functionNames: new Map(),
    previews: [],
    summaryInserted: false,
  };
  const compactedMessages = [];

  for (let i = 0; i < safe.length; i++) {
    const message = safe[i];
    const protectedMessage = protectedIndexes.has(i);
    const isAssistantToolTurn = message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length;
    const isToolResult = message?.role === 'tool';

    if (!protectedMessage && (isAssistantToolTurn || isToolResult)) {
      stats.compacted = true;
      if (isAssistantToolTurn) {
        stats.omittedAssistantToolTurns++;
        for (const tc of message.tool_calls) {
          const name = tc?.function?.name || 'unknown';
          stats.functionNames.set(name, (stats.functionNames.get(name) || 0) + 1);
        }
        const preview = contentToPreview(message.content, 180);
        if (preview && stats.previews.length < maxPreviewCount) {
          stats.previews.push(`assistant note: ${preview}`);
        }
        continue;
      }

      stats.omittedToolResults++;
      const chars = contentTextChars(message.content);
      stats.omittedToolChars += chars;
      const preview = contentToPreview(message.content, 180);
      if (preview && stats.previews.length < maxPreviewCount) {
        const callId = typeof message.tool_call_id === 'string' && message.tool_call_id
          ? `tool_call_id=${message.tool_call_id} `
          : '';
        stats.previews.push(`${callId}chars=${chars} preview="${preview}"`);
      }
      continue;
    }

    compactedMessages.push(cloneMessage(message));
  }

  if (stats.compacted && (stats.omittedAssistantToolTurns || stats.omittedToolResults)) {
    const summaryMessage = {
      role: 'system',
      content: buildCompactionSummary(stats),
    };
    let insertAt = 0;
    while (insertAt < compactedMessages.length && compactedMessages[insertAt]?.role === 'system') insertAt++;
    compactedMessages.splice(insertAt, 0, summaryMessage);
    stats.summaryInserted = true;
  }

  stats.compactedStats = summarizeOpenAIContext(compactedMessages);
  return {
    messages: stats.compacted ? compactedMessages : safe,
    stats,
  };
}

export function getOversizedContextReason(summary, options = {}) {
  const maxInputChars = Number.isFinite(options.maxInputChars)
    ? options.maxInputChars
    : envInt('MAX_CONTEXT_CHARS', 180_000, { min: 8_000 });
  const maxMessages = Number.isFinite(options.maxMessages)
    ? options.maxMessages
    : envInt('MAX_CONTEXT_MESSAGES', 200, { min: 8 });
  const maxToolResultChars = Number.isFinite(options.maxToolResultChars)
    ? options.maxToolResultChars
    : envInt('MAX_TOOL_RESULT_CHARS', 64_000, { min: 2_000 });
  if (!summary) return null;
  if (summary.inputChars > maxInputChars) return 'input_chars';
  if (summary.messages > maxMessages) return 'message_count';
  if (summary.toolResultChars > maxToolResultChars) return 'tool_result_chars';
  return null;
}
