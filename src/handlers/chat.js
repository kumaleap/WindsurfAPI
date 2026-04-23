/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { randomUUID } from 'crypto';
import { WindsurfClient } from '../client.js';
import { getApiKey, acquireAccountByKey, reportError, reportSuccess, markRateLimited, reportInternalError, updateCapability, getAccountList, isAllRateLimited, cooldownAccountModel, getAccountLogLabel } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { newRequestId, withCtx } from '../dashboard/logger.js';
import { cacheKey, cacheGet, cacheSet } from '../cache.js';
import { isExperimentalEnabled, getIdentityPromptFor } from '../runtime-config.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getEffectiveProxy } from '../dashboard/proxy-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';
import {
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText,
  buildToolPreambleForProto,
} from './tool-emulation.js';
import { sanitizeText, PathSanitizeStream } from '../sanitize.js';

const HEARTBEAT_MS = 15_000;
const QUEUE_RETRY_MS = 1_000;
const QUEUE_MAX_WAIT_MS = 30_000;
const STREAM_PRELUDE_COMMIT_CHARS = 96;
const STREAM_PRELUDE_COMMIT_MS = 900;
const STREAM_FASTLANE_CHARS = 40;
const STREAM_FASTLANE_MIN_CHARS = 18;
const STREAM_FASTLANE_MS = 260;
const STREAM_FASTLANE_BOUNDARY_CHARS = 18;
const STREAM_FASTLANE_BOUNDARY_MS = 140;
const STREAM_THINKING_COMMIT_CHARS = 24;
const STREAM_THINKING_COMMIT_MS = 220;
const STREAM_FOLLOWUP_COMMIT_CHARS = 56;
const STREAM_FOLLOWUP_COMMIT_MS = 180;
const STREAM_FOLLOWUP_BOUNDARY_CHARS = 24;
const STREAM_FOLLOWUP_BOUNDARY_MS = 90;
const STREAM_FOLLOWUP_THINKING_COMMIT_CHARS = 20;
const STREAM_FOLLOWUP_THINKING_COMMIT_MS = 120;
const TOOL_MODE_EARLY_FINISH_GRACE_MS = 700;
const TOOL_MODE_PROSE_FLUSH_CHARS = 480;
const TOOL_MODE_PROSE_FLUSH_MS = 1800;
const MAX_EMULATED_TOOL_CALLS_PER_ROUND = 16;
const HAIKU_TOOL_OUTPUT_GUARD_INPUT_CHARS = 30_000;
const LONG_TOOL_OUTPUT_GUARD_INPUT_CHARS = 120_000;
const DEFAULT_HAIKU_OUTPUT_GUARD_TOKENS = 900;
const DEFAULT_TOOL_OUTPUT_GUARD_TOKENS = 1200;
const TRANSIENT_MODEL_COOLDOWN_MS = 45_000;

function endsAtNaturalBoundary(text) {
  if (!text) return false;
  const tail = text.slice(-6);
  return /(?:\r?\n\s*$|[.!?。！？:：;；]\s*$|[)\]」』】]\s*$)/.test(tail);
}

function estimateMessageChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') chars += part.text.length;
      }
    }
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function?.name || '').length;
        chars += (tc.function?.arguments || '').length;
      }
    }
  }
  return chars;
}

function contentTextChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (typeof part?.text === 'string') chars += part.text.length;
    else if (typeof part?.image_url?.url === 'string' || typeof part?.image_url === 'string') chars += 1024;
  }
  return chars;
}

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

function getFirstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const textPart = content.find(part => typeof part?.text === 'string');
  return textPart?.text || '';
}

function summarizeChatRequest({
  body,
  messages,
  model,
  modelKey,
  useCascade,
  hasTools,
  hasToolHistory,
  emulateTools,
  activeToolCallMode,
  inputChars,
}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const roleCounts = safeMessages.reduce((acc, message) => {
    const role = message?.role || 'unknown';
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  let systemChars = 0;
  let assistantToolCalls = 0;
  let toolResultChars = 0;
  let textParts = 0;
  let imageParts = 0;
  for (const message of safeMessages) {
    if (message?.role === 'system') systemChars += contentTextChars(message.content);
    if (message?.role === 'tool') toolResultChars += contentTextChars(message.content);
    if (Array.isArray(message?.tool_calls)) assistantToolCalls += message.tool_calls.length;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') textParts++;
        if (part?.image_url) imageParts++;
      }
    }
  }
  const lastUser = getLastUserMessage(safeMessages);
  const lastUserText = getFirstText(lastUser?.content).trimStart();
  const toolsCount = Array.isArray(body?.tools) ? body.tools.length : 0;
  return {
    model,
    modelKey,
    stream: !!body?.stream,
    maxTokens: body?.max_tokens || null,
    useCascade,
    messages: safeMessages.length,
    roleCounts,
    inputChars,
    systemChars,
    toolsCount,
    hasTools,
    hasToolHistory,
    emulateTools,
    activeToolCallMode,
    assistantToolCalls,
    toolResultCount: roleCounts.tool || 0,
    toolResultChars,
    textParts,
    imageParts,
    lastRole: safeMessages[safeMessages.length - 1]?.role || null,
    lastUserChars: contentTextChars(lastUser?.content),
    slashCommandWithoutTools: toolsCount === 0 && lastUserText.startsWith('/'),
  };
}

function getCacheSkipReason({ text = '', thinking = '', messages, useCascade, toolCalls = 0 }) {
  const textChars = String(text || '').trim().length;
  const thinkingChars = String(thinking || '').trim().length;
  if (toolCalls > 0) return 'tool_calls';
  if (!textChars && !thinkingChars) return 'empty';
  if (!useCascade) return null;

  const inputChars = estimateMessageChars(messages);
  if (inputChars >= 120_000 && textChars < 400) return 'short_for_long_context';
  if (inputChars >= 40_000 && textChars < 200) return 'short_for_long_context';
  if (inputChars >= 10_000 && textChars < 120) return 'short_for_long_context';
  if (inputChars >= 4_000 && textChars < 80) return 'short_for_long_context';
  return null;
}

function isOutputLimitError(err) {
  return /maximum output token limit|max output token/i.test(err?.message || '');
}

function isOutputLimitMessage(message = '') {
  return /maximum output token limit|max output token/i.test(message);
}

function getPartialFinishReason(err) {
  return isOutputLimitError(err) ? 'length' : 'stop';
}

function normalizeToolArgumentsJson(rawArgs) {
  const raw = typeof rawArgs === 'string' ? rawArgs.trim() : '';
  if (!raw) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function buildEmulatedToolCallKey(tc) {
  const name = String(tc?.name || tc?.function?.name || 'unknown');
  const args = normalizeToolArgumentsJson(tc?.argumentsJson || tc?.function?.arguments || tc?.arguments || '{}');
  return `${name}\n${args}`;
}

function normalizeEmulatedToolCalls(toolCalls, maxCalls = MAX_EMULATED_TOOL_CALLS_PER_ROUND) {
  const accepted = [];
  const seen = new Set();
  let droppedDuplicates = 0;
  let droppedOverflow = 0;

  for (const tc of toolCalls || []) {
    if (!tc) continue;
    const normalized = {
      ...tc,
      name: tc.name || tc.function?.name || 'unknown',
      argumentsJson: normalizeToolArgumentsJson(tc.argumentsJson || tc.function?.arguments || tc.arguments || '{}'),
    };
    const key = buildEmulatedToolCallKey(normalized);
    if (seen.has(key)) {
      droppedDuplicates++;
      continue;
    }
    if (accepted.length >= maxCalls) {
      droppedOverflow++;
      continue;
    }
    seen.add(key);
    accepted.push(normalized);
  }

  return { toolCalls: accepted, droppedDuplicates, droppedOverflow };
}

function buildOutputGuardSystemMessage(modelKey, maxTokens, activeToolCallMode, inputChars) {
  const requestedTokens = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.max(64, Math.floor(maxTokens))
    : null;
  const isHaiku = modelKey === 'claude-4.5-haiku';
  const shouldGuard = !!(
    (requestedTokens && requestedTokens <= 1400)
    || (isHaiku && activeToolCallMode && inputChars >= HAIKU_TOOL_OUTPUT_GUARD_INPUT_CHARS)
    || (activeToolCallMode && inputChars >= LONG_TOOL_OUTPUT_GUARD_INPUT_CHARS)
  );
  if (!shouldGuard) return null;

  const budgetTokens = requestedTokens
    ? Math.min(requestedTokens, isHaiku ? DEFAULT_HAIKU_OUTPUT_GUARD_TOKENS : DEFAULT_TOOL_OUTPUT_GUARD_TOKENS)
    : (isHaiku ? DEFAULT_HAIKU_OUTPUT_GUARD_TOKENS : DEFAULT_TOOL_OUTPUT_GUARD_TOKENS);
  const budgetWords = Math.max(120, Math.round(budgetTokens * 0.75));

  return [
    'Output budget for this request:',
    `Keep the final answer under roughly ${budgetTokens} tokens (${budgetWords} words) unless the user explicitly requires a shorter limit.`,
    'If tool results are large, summarize them instead of reproducing them verbatim.',
    'Do not dump raw tool output, logs, JSON, or repeated evidence unless the user explicitly asks for the raw data.',
    'Prefer the shortest complete answer that still solves the user request.',
  ].join('\n');
}

function summarizeStreamMetrics(metrics) {
  return {
    attempts: metrics.attempts,
    retriesBeforeCommit: metrics.retriesBeforeCommit,
    committedTextChars: metrics.committedTextChars,
    committedThinkingChars: metrics.committedThinkingChars,
    committedToolCalls: metrics.committedToolCalls,
    committedChunks: metrics.committedChunks,
    firstVisibleMs: metrics.firstVisibleAt ? metrics.firstVisibleAt - metrics.startedAt : null,
    firstTextMs: metrics.firstTextAt ? metrics.firstTextAt - metrics.startedAt : null,
    firstThinkingMs: metrics.firstThinkingAt ? metrics.firstThinkingAt - metrics.startedAt : null,
    lastErrorType: metrics.lastErrorType,
    finishedBy: metrics.finishedBy,
  };
}

function classifyStreamError(err) {
  const msg = err?.message || '';
  if (/(rate limit|rate_limit|too many requests|quota)/i.test(msg) || err?.isRateLimit) return 'rate_limit';
  if (/(internal error occurred.*error id)/i.test(msg)) return 'internal_error';
  if (err?.isModelError) return 'model_error';
  if (msg) return 'upstream_error';
  return 'unknown';
}

function isPermanentModelPermissionMessage(message = '') {
  return /(permission_denied:\s*model not allowed for user|model not allowed for user|model_not_entitled|未订阅或已被封禁)/i.test(message);
}

function isRetryableUpstreamMessage(message = '') {
  return /(bad gateway|502|read econnreset|econnreset|socket hang up|panel state missing|retryable error from model provider|third-party model provider is experiencing issues|currently not available|temporarily unavailable|request timeout|upstream disconnected|fetch failed|timeout)/i.test(message);
}

function inspectFailure(err) {
  const message = err?.message || '';
  return {
    message,
    isAuthFail: /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(message),
    isRateLimit: /rate limit|rate_limit|too many requests|quota/i.test(message) || !!err?.isRateLimit,
    isInternal: /(internal error occurred.*error id)/i.test(message),
    isPermanentModel: isPermanentModelPermissionMessage(message),
    isRetryableUpstream: isRetryableUpstreamMessage(message),
    isOutputLimit: isOutputLimitMessage(message),
  };
}

function applyFailurePolicy(apiKey, modelKey, err, { cooldownTransient = true } = {}) {
  const failure = inspectFailure(err);
  if (failure.isAuthFail) reportError(apiKey);
  if (failure.isRateLimit) {
    markRateLimited(apiKey, 5 * 60 * 1000, modelKey);
    err.isRateLimit = true;
    err.isModelError = true;
  }
  if (failure.isInternal) {
    reportInternalError(apiKey);
    err.isModelError = true;
  }
  if (failure.isPermanentModel) {
    updateCapability(apiKey, modelKey, false, 'model_not_allowed');
    err.isModelError = true;
    err.isPermanentModelError = true;
  }
  if (cooldownTransient && modelKey && (failure.isInternal || failure.isRetryableUpstream) && !failure.isRateLimit) {
    cooldownAccountModel(apiKey, modelKey, TRANSIENT_MODEL_COOLDOWN_MS, failure.isInternal ? 'internal_error' : 'transient_upstream');
  }
  return failure;
}

function shouldRetryBeforeVisibleOutput(err) {
  const failure = inspectFailure(err);
  return failure.isRateLimit || failure.isPermanentModel || failure.isInternal || failure.isRetryableUpstream;
}

function shouldRetryNonStreamResult(result) {
  if (!result) return false;
  if (result.status === 429) return true;
  if (result.status >= 500) return true;
  const message = result.body?.error?.message || '';
  const type = result.body?.error?.type;
  if (isOutputLimitMessage(message)) return false;
  if (isPermanentModelPermissionMessage(message)) return true;
  if (type === 'upstream_error' && isRetryableUpstreamMessage(message)) return true;
  return false;
}

// ── Model identity prompt ──────────────────────────────────
// Templates live in runtime-config (editable from the dashboard). Use {model}
// as a placeholder for the requested model name. Only applied when the
// experimental "modelIdentityPrompt" toggle is ON.
function buildIdentitySystemMessage(displayModel, provider) {
  const template = getIdentityPromptFor(provider);
  if (!template) return null;
  return template.replace(/\{model\}/g, displayModel);
}

function contentToPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.image_url?.url === 'string') return '[image]';
      if (typeof part?.image_url === 'string') return '[image]';
      return '';
    }).join('\n');
  }
  return '';
}

function getLastHumanUserMessageExcerpt(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const text = contentToPlainText(msg.content).trim();
    if (!text) continue;
    return text.replace(/\s+/g, ' ').slice(0, 320);
  }
  return '';
}

function containsCjk(text = '') {
  return /[\u3400-\u9fff\uF900-\uFAFF]/.test(String(text || ''));
}

function buildReplyLanguageSystemMessage(lastHumanUserExcerpt = '') {
  const lines = [
    'Reply in the same natural language as the user\'s most recent message unless they explicitly ask for a different language.',
    'Do not switch languages just because prior context, tool instructions, or system scaffolding use another language.',
    'When tool results or synthetic user turns are present, ignore them for language selection. Base the reply language on the original end-user request instead.',
    'Preserve code, commands, identifiers, file paths, API fields, and other literal snippets exactly as provided.',
  ];
  if (containsCjk(lastHumanUserExcerpt)) {
    lines.push('检测到用户最近使用中文。除非用户明确要求其他语言，最终回复必须使用中文；不要因为工具结果、系统提示或历史英文内容切换到英文。');
  }
  if (lastHumanUserExcerpt) {
    lines.push('Latest real end-user request excerpt:');
    lines.push('```text');
    lines.push(lastHumanUserExcerpt);
    lines.push('```');
  }
  return lines.join('\n');
}

function buildToolResultContinuationSystemMessage(lastHumanUserExcerpt = '') {
  const lines = [
    'The current turn may consist mainly of tool results from previous tool calls.',
    'Treat those tool results as evidence for the user\'s last real request, not as a new unrelated conversation.',
    'Continue and complete the user\'s last real request directly.',
    'Do not answer with handoff text such as "this appears to be a continuation of a previous session" or ask what the user wants unless the request is genuinely impossible to infer.',
  ];
  if (containsCjk(lastHumanUserExcerpt)) {
    lines.push('当前轮次可能主要是工具结果。请基于这些结果继续完成用户上一个真实请求；不要说“这像是之前会话的延续”，也不要反问用户需要帮什么。');
  }
  return lines.join('\n');
}

function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
}

// Rough token estimate (~4 chars/token). Used only to populate the
// OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` field so
// upstream billing/dashboards (new-api) can recognise our local cache hits.
function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function cachedUsage(messages, completionText) {
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil((completionText || '').length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: prompt },
    completion_tokens_details: { reasoning_tokens: 0 },
    cached: true,
  };
}

function hasNonTextMessageContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => Array.isArray(message?.content)
    && message.content.some((part) => typeof part?.text !== 'string'));
}

function shouldUseLocalResponseCache(body, messages, emulateTools) {
  if (emulateTools) return false;
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  if (hasNonTextMessageContent(messages)) return false;
  if (body?.anthropic_thinking?.enabled || body?.thinking) return false;
  return true;
}

/**
 * Build an OpenAI-shaped `usage` object, preferring server-reported token
 * counts from Cascade's CortexStepMetadata.model_usage when available, and
 * falling back to the local chars/4 estimate otherwise. Keeps the same shape
 * in both branches so downstream billing doesn't have to care which source
 * produced the numbers.
 *
 * The Cascade backend reports usage as {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens}. We map them onto the OpenAI shape:
 *   prompt_tokens     = inputTokens + cacheReadTokens + cacheWriteTokens
 *                       (total input tokens the model processed, whether fresh,
 *                       cache-read, or cache-written — matches the OpenAI
 *                       convention where prompt_tokens is the grand total)
 *   completion_tokens = outputTokens
 *   prompt_tokens_details.cached_tokens       = cacheReadTokens
 *   cache_creation_input_tokens (Anthropic ext) = cacheWriteTokens
 */
function buildUsageBody(serverUsage, messages, completionText, thinkingText = '') {
  if (serverUsage && (serverUsage.inputTokens || serverUsage.outputTokens)) {
    const inputTokens = serverUsage.inputTokens || 0;
    const outputTokens = serverUsage.outputTokens || 0;
    const cacheRead = serverUsage.cacheReadTokens || 0;
    const cacheWrite = serverUsage.cacheWriteTokens || 0;
    const promptTotal = inputTokens + cacheRead + cacheWrite;
    return {
      prompt_tokens: promptTotal,
      completion_tokens: outputTokens,
      total_tokens: promptTotal + outputTokens,
      input_tokens: promptTotal,
      output_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: cacheRead },
      completion_tokens_details: { reasoning_tokens: 0 },
      cache_creation_input_tokens: cacheWrite,
    };
  }
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil(((completionText || '').length + (thinkingText || '').length) / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS, modelKey = null) {
  const deadline = Date.now() + maxWaitMs;
  let acct = getApiKey(tried, modelKey);
  while (!acct) {
    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, QUEUE_RETRY_MS));
    acct = getApiKey(tried, modelKey);
  }
  return acct;
}

export async function handleChatCompletions(body) {
  const {
    model: reqModel,
    stream = false,
    max_tokens,
    tools,
    tool_choice,
  } = body;
  // `messages` is `let` not `const` so the identity-prompt injection below
  // can prepend a system turn for the legacy path too.
  let messages = body.messages;

  const requestedModel = reqModel || config.defaultModel;
  const modelKey = resolveModel(requestedModel);
  const modelInfo = getModelInfo(modelKey);
  // Preserve the caller-selected model name for outward-facing identity and
  // response payloads, even when we normalize it to a canonical internal key.
  const displayModel = requestedModel || modelInfo?.name || config.defaultModel;
  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Models with a modelUid use the Cascade flow (StartCascade → SendUserCascadeMessage).
  // Legacy RawGetChatMessage only for models with enumValue>0 and NO modelUid.
  // Newer models (gemini-3.0, gpt-5.2, etc.) have both enumValue AND modelUid but
  // their high enum values cause "cannot parse invalid wire-format data" in the
  // legacy proto endpoint. Cascade handles them correctly via uid string.
  const useCascade = !!modelUid;

  // Tool-call emulation: if the client passed OpenAI-style tools[], we rewrite
  // tool-result turns into synthetic user text and inject the tool protocol
  // at the system-prompt level via CascadeConversationalPlannerConfig's
  // tool_calling_section (SectionOverrideConfig, OVERRIDE mode). This is far
  // more reliable than user-message-level injection because NO_TOOL mode's
  // baked-in system prompt tells the model "you have no tools" — which
  // overpowers user-message preambles. The section override replaces that
  // section directly so the model sees our emulated tool definitions as
  // authoritative system instructions.
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const hasToolHistory = Array.isArray(messages) && messages.some(m => m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
  const emulateTools = useCascade && (hasTools || hasToolHistory);
  const activeToolCallMode = useCascade && hasTools;
  // Build proto-level preamble (goes into tool_calling_section override);
  // pass empty tools to normalizeMessagesForCascade so it only rewrites
  // role:tool / assistant.tool_calls messages without injecting a user-level
  // preamble (that's now handled at the proto layer).
  const toolPreamble = activeToolCallMode ? buildToolPreambleForProto(tools || [], tool_choice) : '';
  let cascadeMessages = emulateTools
    ? normalizeMessagesForCascade(messages, [])
    : [...messages];
  const inputChars = estimateMessageChars(messages);
  const requestSummary = summarizeChatRequest({
    body,
    messages,
    model: displayModel,
    modelKey,
    useCascade,
    hasTools,
    hasToolHistory,
    emulateTools,
    activeToolCallMode,
    inputChars,
  });
  log.info('Chat request summary', requestSummary);
  if (requestSummary.slashCommandWithoutTools) {
    log.warn('Chat slash command arrived without tools; client may have sent an agent command as plain text', {
      model: requestSummary.model,
      messages: requestSummary.messages,
      lastUserChars: requestSummary.lastUserChars,
    });
  }
  const outputGuard = buildOutputGuardSystemMessage(modelKey, max_tokens, activeToolCallMode, inputChars);
  const lastHumanUserExcerpt = getLastHumanUserMessageExcerpt(messages);
  const replyLanguageGuard = buildReplyLanguageSystemMessage(lastHumanUserExcerpt);
  const trailingToolResult = Array.isArray(messages) && messages[messages.length - 1]?.role === 'tool';

  if (replyLanguageGuard) {
    cascadeMessages = [{ role: 'system', content: replyLanguageGuard }, ...cascadeMessages];
  }
  if (trailingToolResult) {
    cascadeMessages = [{ role: 'system', content: buildToolResultContinuationSystemMessage(lastHumanUserExcerpt) }, ...cascadeMessages];
  }

  // ── Model identity prompt injection ──
  // When enabled, prepend a system message so the model identifies itself as
  // the requested model (e.g. "I am Claude Opus 4.6") instead of leaking the
  // Cascade/Windsurf backend identity. Inject into BOTH messages (for legacy
  // RawGetChatMessage path) and cascadeMessages (Cascade path) — they diverge
  // once tool-emulation rewrites the Cascade path, but the system identity
  // should be identical in both.
  if (isExperimentalEnabled('modelIdentityPrompt') && modelInfo?.provider) {
    const identityText = buildIdentitySystemMessage(displayModel, modelInfo.provider);
    if (identityText) {
      const sysMsg = { role: 'system', content: identityText };
      cascadeMessages = [sysMsg, ...cascadeMessages];
      messages = [sysMsg, ...messages];
    }
  }

  if (outputGuard) {
    cascadeMessages = [{ role: 'system', content: outputGuard }, ...cascadeMessages];
  }

  // Global model access control (allowlist / blocklist from dashboard)
  const access = isModelAllowed(modelKey);
  if (!access.allowed) {
    return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
  }

  // Per-account model routing preflight: if NO active account has this
  // model in its tier ∩ available list, fail fast instead of looping
  // through every account trying to find one. This surfaces tier
  // entitlement and blocklist errors as a clean 403 rather than a 30s
  // queue timeout → pool_exhausted.
  const anyEligible = getAccountList().some(a =>
    a.status === 'active' && (a.availableModels || []).includes(modelKey)
  );
  if (!anyEligible) {
    return {
      status: 403,
      body: {
        error: {
          message: `模型 ${displayModel} 在当前账号池中不可用（未订阅或已被封禁）`,
          type: 'model_not_entitled',
        },
      },
    };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = shouldUseLocalResponseCache(body, messages, emulateTools)
    ? cacheKey(body)
    : null;

  if (stream) {
    return streamResponse(chatId, created, displayModel, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, activeToolCallMode, toolPreamble);
  }

  // ── Local response cache (exact body match) ─────────────
  const cached = cacheGet(ckey);
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    const message = { role: 'assistant', content: cached.text || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: cachedUsage(messages, cached.text),
      },
    };
  }

  // ── Cascade conversation pool (experimental) ──
  // If the client is continuing a prior conversation and we still hold the
  // cascade_id from last turn, pin this request to that exact (account, LS)
  // pair so the Windsurf backend serves from its hot per-cascade context
  // instead of replaying the whole history.
  //
  // Tool-emulation mode bypasses the reuse pool: fingerprint can't stably
  // collapse a conversation whose assistant turns contain synthesised
  // <tool_call> markup and whose user turns contain <tool_result> wrappers.
  const reuseEnabled = useCascade && !emulateTools && isExperimentalEnabled('cascadeConversationReuse');
  const fpBefore = reuseEnabled ? fingerprintBefore(messages) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore) : null;
  if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… model=${displayModel}`);

  // Non-stream: retry with a different account on model-not-available errors
  const tried = [];
  let lastErr = null;
  // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let acct = null;
    if (reuseEntry && attempt === 0) {
      // First attempt pins to the account that owns the cached cascade.
      acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
      if (!acct) {
        log.info('Chat: cascade reuse skipped — owning account not available, falling back to fresh cascade');
        reuseEntry = null;
      }
    }
    if (!acct) {
      acct = await waitForAccount(tried, null, QUEUE_MAX_WAIT_MS, modelKey);
      if (!acct) break;
    }
    tried.push(acct.apiKey);

    // Pre-flight rate limit check (experimental): ask server.codeium.com if
    // this account still has message capacity before burning an LS round trip.
    if (isExperimentalEnabled('preflightRateLimit')) {
      try {
        const px = getEffectiveProxy(acct.id) || null;
        const rl = await checkMessageRateLimit(acct.apiKey, px);
        if (!rl.hasCapacity) {
          log.warn(`Preflight: ${getAccountLogLabel(acct)} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
          markRateLimited(acct.apiKey, 5 * 60 * 1000, modelKey);
          continue;
        }
      } catch (e) {
        log.debug(`Preflight check failed for ${getAccountLogLabel(acct)}: ${e.message}`);
        // Fail open — proceed with the request
      }
    }

    await ensureLs(acct.proxy);
    const ls = getLsFor(acct.proxy);
    if (!ls) { lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } }; break; }
    // Cascade pins cascade_id to a specific LS port too; if the LS it was
    // born on has been replaced, the cascade_id is dead.
    if (reuseEntry && reuseEntry.lsPort !== ls.port) {
      log.info('Chat: cascade reuse skipped — LS port changed');
      reuseEntry = null;
    }
    const _msgChars = (messages || []).reduce((n, m) => {
      const c = m?.content;
      return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
    }, 0);
    log.info(`Chat: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} account=${getAccountLogLabel(acct)} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgChars}${reuseEntry ? ' reuse=1' : ''}${emulateTools ? ' tools=emu' : ''}`);
    const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(
      client, chatId, created, displayModel, modelKey, messages, cascadeMessages, modelEnum, modelUid,
      useCascade, acct.apiKey, ckey,
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey } : null,
      emulateTools, activeToolCallMode, toolPreamble,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    lastErr = result;
    const errType = result.body?.error?.type;
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      log.warn(`Account ${getAccountLogLabel(acct)} rate-limited on ${displayModel}, trying next account`);
      continue;
    }
    // Model not available on this account (permission_denied, etc.)
    if (errType === 'model_not_available' && !isOutputLimitMessage(result.body?.error?.message || '')) {
      log.warn(`Account ${getAccountLogLabel(acct)} cannot serve ${displayModel}, trying next account`);
      continue;
    }
    if (shouldRetryNonStreamResult(result)) {
      log.warn(`Account ${getAccountLogLabel(acct)} hit retryable upstream error on ${displayModel}, trying next account`);
      continue;
    }
    break; // other errors (502, transport) — don't retry
  }
  // If all accounts exhausted, check if it's because they're all rate-limited
  if (!lastErr || lastErr.status === 429) {
    const rl = isAllRateLimited(modelKey);
    if (rl.allLimited) {
      return { status: 429, body: { error: { message: `${displayModel} 所有账号均已达速率限制，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs } } };
    }
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, emulateTools, activeToolCallMode, toolPreamble) {
  const startTime = Date.now();
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;
    let toolCalls = [];
    // Server-reported token usage from CortexStepMetadata.model_usage, summed
    // across all trajectory steps. Preferred over the chars/4 estimate when
    // present so downstream billing (new-api, etc.) sees real Cascade numbers.
    let serverUsage = null;

    if (useCascade) {
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, { reuseEntry: poolCtx?.reuseEntry || null, toolPreamble });
      for (const c of chunks) {
        if (c.text) allText += c.text;
        if (c.thinking) allThinking += c.thinking;
      }
      cascadeMeta = { cascadeId: chunks.cascadeId, sessionId: chunks.sessionId };
      serverUsage = chunks.usage || null;
      // Always strip <tool_call>/<tool_result> blocks from Cascade text.
      // - emulateTools=true: parsed tool_calls become OpenAI-format tool_calls.
      // - emulateTools=false: blocks are silently discarded (defense-in-depth
      //   against Cascade's system prompt inducing tool markup even after we
      //   override tool_calling_section).
      {
        const parsed = parseToolCallsFromText(allText);
        allText = parsed.text;
        if (activeToolCallMode) {
          const normalized = normalizeEmulatedToolCalls(parsed.toolCalls);
          toolCalls = normalized.toolCalls;
          if (normalized.droppedDuplicates || normalized.droppedOverflow) {
            log.warn(`Non-stream emulated tool calls normalized: kept=${toolCalls.length} duplicate=${normalized.droppedDuplicates} overflow=${normalized.droppedOverflow}`);
          }
        }
      }
      // Built-in Cascade tool calls (chunks.toolCalls — edit_file, view_file,
      // list_directory, run_command, etc.) are intentionally DROPPED. Their
      // argumentsJson and result fields reference server-internal paths like
      // /tmp/windsurf-workspace/config.yaml and must never be exposed to an
      // API caller. Emulated tool calls (above) are safe because they
      // reference the caller's own tool schema.
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    // Scrub server-internal filesystem paths from everything we're about to
    // return. See src/sanitize.js for the patterns and rationale.
    allText = sanitizeText(allText);
    allThinking = sanitizeText(allThinking);
    if (toolCalls.length) {
      toolCalls = toolCalls.map(tc => ({
        ...tc,
        argumentsJson: sanitizeText(tc.argumentsJson || ''),
      }));
    }

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    if (poolCtx && cascadeMeta?.cascadeId && allText) {
      const fpAfter = fingerprintAfter(messages, allText);
      poolCheckin(fpAfter, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        apiKey: poolCtx.apiKey,
        createdAt: poolCtx.reuseEntry?.createdAt,
      });
    }

    reportSuccess(apiKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    // Store in cache for next identical request. Skip caching tool_call
    // responses and suspiciously short long-context stop replies — a cache hit
    // would otherwise fossilize what was likely an upstream early-stop or thin
    // completion.
    const nonStreamCacheSkipReason = getCacheSkipReason({
      text: allText,
      thinking: allThinking,
      messages,
      useCascade,
      toolCalls: toolCalls.length,
    });
    if (ckey && !nonStreamCacheSkipReason) {
      cacheSet(ckey, { text: allText, thinking: allThinking });
    } else if (ckey && nonStreamCacheSkipReason) {
      log.info(`Cache skipped for non-stream reply: ${nonStreamCacheSkipReason}`);
    }

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: tc.name || 'unknown',
          arguments: tc.argumentsJson || tc.arguments || '{}',
        },
      }));
      // OpenAI convention: content is null when finish_reason is tool_calls.
      // In text emulation the model often emits an inline answer alongside the
      // <tool_call> block (e.g., hallucinated weather data). Set content to
      // null so clients that check `content !== null` behave correctly and the
      // caller waits for the real tool result rather than showing hallucinated
      // data.
      message.content = null;
    }

    // Prefer server-reported usage; fall back to chars/4 estimate only when
    // the trajectory didn't include a ModelUsageStats field.
    const usage = buildUsageBody(serverUsage, messages, allText, allThinking);
    const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const failure = applyFailurePolicy(apiKey, modelKey, err);
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    // Rate limits → 429 with Retry-After; model errors → 403; others → 502
    if (failure.isRateLimit) {
      const rl = isAllRateLimited(modelKey);
      return {
        status: 429,
        body: { error: { message: `${model} 已达速率限制，请稍后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs || 60000 } },
      };
    }
    // LS crash on oversized payload — gRPC surfaces this as "pending stream
    // has been canceled" within a second. Give the user an actionable hint.
    const isStreamCanceled = /pending stream has been canceled|panel state|ECONNRESET/i.test(err.message);
    if (isStreamCanceled && _msgChars > 500_000) {
      return {
        status: 413,
        body: { error: {
          message: `请求过大（${Math.round(_msgChars / 1024)}KB 输入）导致语言服务器中断。请尝试：1) 分块发送；2) 先用摘要/summarization 预处理 PDF；3) 减少历史轮数`,
          type: 'payload_too_large',
        } },
      };
    }
    return {
      status: err.isModelError ? 403 : 502,
      body: { error: { message: sanitizeText(err.message), type: err.isModelError ? 'model_not_available' : 'upstream_error' } },
    };
  }
}

function streamResponse(id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, activeToolCallMode, toolPreamble) {
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const requestId = newRequestId();
      const slog = withCtx({ requestId, route: 'chat.stream', model, modelKey });
      const abortController = new AbortController();
      let abortReason = null;
      let toolEarlyFinishTimer = null;
      const clearToolEarlyFinishTimer = () => {
        if (!toolEarlyFinishTimer) return;
        clearTimeout(toolEarlyFinishTimer);
        toolEarlyFinishTimer = null;
      };
      const abortUpstream = (reason) => {
        if (abortController.signal.aborted) return;
        abortReason = reason;
        clearToolEarlyFinishTimer();
        abortController.abort();
      };
      const scheduleToolModeEarlyFinish = () => {
        if (!activeToolCallMode) return;
        clearToolEarlyFinishTimer();
        toolEarlyFinishTimer = setTimeout(() => {
          slog.info('Ending tool round early after complete tool_call burst');
          abortUpstream('tool_calls_ready');
        }, TOOL_MODE_EARLY_FINISH_GRACE_MS);
      };
      res.on('close', () => {
        if (!res.writableEnded) {
          slog.info('Client disconnected mid-stream, aborting upstream');
          abortUpstream('client_disconnect');
        }
      });
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => clearInterval(heartbeat);
      res.on('close', stopHeartbeat);

      const cached = cacheGet(ckey);
      if (cached) {
        slog.info('Chat: cache HIT stream response', {
          cachedTextChars: cached.text?.length || 0,
          cachedThinkingChars: cached.thinking?.length || 0,
        });
        recordRequest(model, true, 0, null);
        try {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (cached.thinking) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { reasoning_content: cached.thinking }, finish_reason: null }] });
          }
          if (cached.text) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: cached.text }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: cachedUsage(messages, cached.text) });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        } finally {
          stopHeartbeat();
        }
        return;
      }

      const startTime = Date.now();
      const streamMetrics = {
        startedAt: startTime,
        attempts: 0,
        retriesBeforeCommit: 0,
        committedTextChars: 0,
        committedThinkingChars: 0,
        committedToolCalls: 0,
        committedChunks: 0,
        firstVisibleAt: 0,
        firstTextAt: 0,
        firstThinkingAt: 0,
        lastErrorType: null,
        finishedBy: 'unknown',
      };
      slog.info('Stream started', {
        turns: Array.isArray(messages) ? messages.length : 0,
        useCascade,
        emulateTools,
        activeToolCallMode,
        cacheKey: !!ckey,
      });
      const tried = [];
      let rolePrinted = false;
      let committedOutput = false;
      let currentApiKey = null;
      let lastErr = null;
      // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));

      let accText = '';
      let accThinking = '';

      const reuseEnabled = useCascade && !emulateTools && isExperimentalEnabled('cascadeConversationReuse');
      const fpBefore = reuseEnabled ? fingerprintBefore(messages) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore) : null;
      if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… stream model=${model}`);

      const collectedToolCalls = [];

      const noteVisibleCommit = (kind, size = 0) => {
        const now = Date.now();
        if (!streamMetrics.firstVisibleAt) streamMetrics.firstVisibleAt = now;
        streamMetrics.committedChunks++;
        if (kind === 'text') {
          if (!streamMetrics.firstTextAt) streamMetrics.firstTextAt = now;
          streamMetrics.committedTextChars += size;
        } else if (kind === 'thinking') {
          if (!streamMetrics.firstThinkingAt) streamMetrics.firstThinkingAt = now;
          streamMetrics.committedThinkingChars += size;
        } else if (kind === 'tool') {
          streamMetrics.committedToolCalls += 1;
        }
      };

      const ensureRoleChunk = () => {
        if (rolePrinted) return;
        rolePrinted = true;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      };

      const emitContent = (clean) => {
        if (!clean) return;
        ensureRoleChunk();
        committedOutput = true;
        noteVisibleCommit('text', clean.length);
        accText += clean;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: clean }, finish_reason: null }] });
      };

      const emitThinking = (clean) => {
        if (!clean) return;
        ensureRoleChunk();
        committedOutput = true;
        noteVisibleCommit('thinking', clean.length);
        accThinking += clean;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: clean }, finish_reason: null }] });
      };

      const emitToolCallDelta = (tc, idx) => {
        ensureRoleChunk();
        committedOutput = true;
        noteVisibleCommit('tool');
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {
            tool_calls: [{
              index: idx,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: sanitizeText(tc.argumentsJson || '{}') },
            }],
          }, finish_reason: null }] });
      };

      try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (abortController.signal.aborted) return;
          streamMetrics.attempts = attempt + 1;

          const toolParser = useCascade ? new ToolCallStreamParser() : null;
          const pathStreamText = new PathSanitizeStream();
          const pathStreamThinking = new PathSanitizeStream();
          const attemptToolCalls = [];
          const seenToolCallKeys = new Set();
          const staged = [];
          let stagedChars = 0;
          let stagedFirstAt = 0;
          let attemptSawProgress = false;
          let droppedDuplicateToolCalls = 0;
          let droppedOverflowToolCalls = 0;

          const stageChunk = (entry) => {
            if (!entry) return;
            staged.push(entry);
            stagedChars += entry.visibleChars || 0;
            if (!stagedFirstAt) stagedFirstAt = Date.now();
          };

          const acceptToolCall = (tc) => {
            if (!tc) return false;
            const normalized = {
              ...tc,
              name: tc.name || tc.function?.name || 'unknown',
              argumentsJson: normalizeToolArgumentsJson(tc.argumentsJson || tc.function?.arguments || tc.arguments || '{}'),
            };
            const key = buildEmulatedToolCallKey(normalized);
            if (seenToolCallKeys.has(key)) {
              droppedDuplicateToolCalls++;
              return false;
            }
            if (attemptToolCalls.length >= MAX_EMULATED_TOOL_CALLS_PER_ROUND) {
              droppedOverflowToolCalls++;
              return false;
            }
            seenToolCallKeys.add(key);
            const idx = attemptToolCalls.length;
            attemptToolCalls.push(normalized);
            stageChunk({ kind: 'tool', value: normalized, index: idx, visibleChars: 1 });
            return true;
          };

          const flushPrelude = (force = false) => {
            if (!staged.length) return;
            const ageMs = stagedFirstAt ? Date.now() - stagedFirstAt : 0;
            const hasToolCall = staged.some((entry) => entry.kind === 'tool');
            const hasThinking = staged.some((entry) => entry.kind === 'thinking');
            const onlyText = staged.every((entry) => entry.kind === 'text');
            const lastText = onlyText
              ? staged.reduce((tail, entry) => entry.value || tail, '')
              : '';

            // Conservative tool-mode streaming:
            // - Keep provisional prose buffered while the model is still deciding
            //   whether to emit tool calls.
            // - If a tool call appears in this round, drop any buffered prose so
            //   the client only sees canonical tool_calls, not half-written
            //   planning text that the model would not keep in its final answer.
            if (activeToolCallMode) {
              const toolModeProseFlush = onlyText
                && !hasThinking
                && stagedChars >= TOOL_MODE_PROSE_FLUSH_CHARS
                && ageMs >= TOOL_MODE_PROSE_FLUSH_MS;
              if (hasToolCall) {
                const toolEntries = staged.filter((entry) => entry.kind === 'tool');
                staged.length = 0;
                stagedChars = 0;
                stagedFirstAt = 0;
                for (const entry of toolEntries) emitToolCallDelta(entry.value, entry.index);
                return;
              }
              if (!force && !toolModeProseFlush) return;
            }

            const firstTextFastLane = !committedOutput
              && onlyText
              && !hasToolCall
              && !hasThinking
              && (
                (endsAtNaturalBoundary(lastText)
                  && (stagedChars >= STREAM_FASTLANE_BOUNDARY_CHARS || ageMs >= STREAM_FASTLANE_BOUNDARY_MS))
                || stagedChars >= STREAM_FASTLANE_CHARS
                || (ageMs >= STREAM_FASTLANE_MS && stagedChars >= STREAM_FASTLANE_MIN_CHARS)
              );
            const phaseChars = committedOutput ? STREAM_FOLLOWUP_COMMIT_CHARS : STREAM_PRELUDE_COMMIT_CHARS;
            const phaseMs = committedOutput ? STREAM_FOLLOWUP_COMMIT_MS : STREAM_PRELUDE_COMMIT_MS;
            const thinkingChars = committedOutput ? STREAM_FOLLOWUP_THINKING_COMMIT_CHARS : STREAM_THINKING_COMMIT_CHARS;
            const thinkingMs = committedOutput ? STREAM_FOLLOWUP_THINKING_COMMIT_MS : STREAM_THINKING_COMMIT_MS;
            const boundaryFlush = committedOutput
              && onlyText
              && endsAtNaturalBoundary(lastText)
              && (stagedChars >= STREAM_FOLLOWUP_BOUNDARY_CHARS || ageMs >= STREAM_FOLLOWUP_BOUNDARY_MS);
            const shouldFlush = force
              || hasToolCall
              || firstTextFastLane
              || (hasThinking && (stagedChars >= thinkingChars || ageMs >= thinkingMs))
              || boundaryFlush
              || stagedChars >= phaseChars
              || ageMs >= phaseMs;
            if (!shouldFlush) return;

            for (const entry of staged.splice(0)) {
              if (entry.kind === 'text') emitContent(entry.value);
              else if (entry.kind === 'thinking') emitThinking(entry.value);
              else if (entry.kind === 'tool') emitToolCallDelta(entry.value, entry.index);
            }
            stagedChars = 0;
            stagedFirstAt = 0;
          };

          const onChunk = (chunk) => {
            attemptSawProgress = true;

            if (chunk.text) {
              let safeText = chunk.text;
              if (toolParser) {
                const parserActive = emulateTools
                  || !toolParser.isIdle()
                  || chunk.text.includes('<');
                if (parserActive) {
                  const { text: safe, toolCalls: done } = toolParser.feed(chunk.text);
                  safeText = safe;
                  if (activeToolCallMode) {
                    let acceptedToolCall = false;
                    for (const tc of done) {
                      if (acceptToolCall(tc)) acceptedToolCall = true;
                    }
                    if (acceptedToolCall) scheduleToolModeEarlyFinish();
                  }
                }
              }
              if (safeText) {
                const clean = pathStreamText.feed(safeText);
                if (clean) stageChunk({ kind: 'text', value: clean, visibleChars: clean.length });
              }
            }

            if (chunk.thinking) {
              const clean = pathStreamThinking.feed(chunk.thinking);
              if (clean) stageChunk({ kind: 'thinking', value: clean, visibleChars: clean.length });
            }

            flushPrelude(false);
          };

          let acct = null;
          if (reuseEntry && attempt === 0) {
            acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
            if (!acct) {
              log.info('Chat: cascade reuse skipped — owning account not available');
              reuseEntry = null;
            }
          }
          if (!acct) {
            acct = await waitForAccount(tried, abortController.signal, QUEUE_MAX_WAIT_MS, modelKey);
            if (!acct) break;
          }
          tried.push(acct.apiKey);
          currentApiKey = acct.apiKey;

          if (isExperimentalEnabled('preflightRateLimit')) {
            try {
              const px = getEffectiveProxy(acct.id) || null;
              const rl = await checkMessageRateLimit(acct.apiKey, px);
              if (!rl.hasCapacity) {
                log.warn(`Preflight: ${getAccountLogLabel(acct)} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
                markRateLimited(acct.apiKey, 5 * 60 * 1000, modelKey);
                continue;
              }
            } catch (e) {
              log.debug(`Preflight check failed for ${getAccountLogLabel(acct)}: ${e.message}`);
            }
          }

          try { await ensureLs(acct.proxy); } catch (e) { lastErr = e; break; }
          const ls = getLsFor(acct.proxy);
          if (!ls) { lastErr = new Error('No LS instance available'); break; }
          if (reuseEntry && reuseEntry.lsPort !== ls.port) {
            log.info('Chat: cascade reuse skipped — LS port changed');
            reuseEntry = null;
          }
          const _msgCharsStream = estimateMessageChars(messages);
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} account=${getAccountLogLabel(acct)} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgCharsStream}${reuseEntry ? ' reuse=1' : ''}`);
          const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;

          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry, toolPreamble,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
            }

            clearToolEarlyFinishTimer();

            if (abortReason === 'client_disconnect') {
              return;
            }

            if (toolParser && abortReason !== 'tool_calls_ready') {
              const tail = toolParser.flush();
              if (tail.text) {
                const clean = pathStreamText.feed(tail.text);
                if (clean) stageChunk({ kind: 'text', value: clean, visibleChars: clean.length });
              }
              if (activeToolCallMode) {
                let acceptedTailToolCall = false;
                for (const tc of tail.toolCalls) {
                  if (acceptToolCall(tc)) acceptedTailToolCall = true;
                }
                if (acceptedTailToolCall) scheduleToolModeEarlyFinish();
              }
            }

            if (abortReason !== 'tool_calls_ready') {
              const clean = pathStreamText.flush();
              if (clean) stageChunk({ kind: 'text', value: clean, visibleChars: clean.length });
            }
            if (abortReason !== 'tool_calls_ready') {
              const clean = pathStreamThinking.flush();
              if (clean) stageChunk({ kind: 'thinking', value: clean, visibleChars: clean.length });
            }

            const pendingText = staged
              .filter(entry => entry.kind === 'text')
              .map(entry => entry.value || '')
              .join('');
            const pendingThinking = staged
              .filter(entry => entry.kind === 'thinking')
              .map(entry => entry.value || '')
              .join('');
            const pendingShortReason = activeToolCallMode
              && !committedOutput
              && attemptToolCalls.length === 0
              && collectedToolCalls.length === 0
              && !pendingThinking.trim()
              && attempt + 1 < maxAttempts
              ? getCacheSkipReason({
                  text: pendingText,
                  thinking: pendingThinking,
                  messages,
                  useCascade,
                  toolCalls: 0,
                })
              : null;
            if (pendingShortReason === 'short_for_long_context') {
              streamMetrics.retriesBeforeCommit++;
              cooldownAccountModel(currentApiKey, modelKey, TRANSIENT_MODEL_COOLDOWN_MS, 'short_tool_stop');
              slog.warn('Retrying suspicious short tool-mode stop before visible output', {
                attempt: attempt + 1,
                pendingTextChars: pendingText.trim().length,
                inputChars: _msgCharsStream,
                cacheSkipReason: pendingShortReason,
              });
              continue;
            }

            flushPrelude(true);
            for (const tc of attemptToolCalls) collectedToolCalls.push(tc);

            if (reuseEnabled && cascadeResult?.cascadeId && accText) {
              const fpAfter = fingerprintAfter(messages, accText);
              poolCheckin(fpAfter, {
                cascadeId: cascadeResult.cascadeId,
                sessionId: cascadeResult.sessionId,
                lsPort: ls.port,
                apiKey: currentApiKey,
                createdAt: reuseEntry?.createdAt,
              });
            }

            if (attemptSawProgress || accText || accThinking || collectedToolCalls.length) {
              reportSuccess(currentApiKey);
            }
            updateCapability(currentApiKey, modelKey, true, 'success');
            recordRequest(model, true, Date.now() - startTime, currentApiKey);
            if (!rolePrinted) ensureRoleChunk();

            const finalReason = collectedToolCalls.length ? 'tool_calls' : 'stop';
            streamMetrics.finishedBy = finalReason;
            const finalUsage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking);
            const streamCacheSkipReason = getCacheSkipReason({
              text: accText,
              thinking: accThinking,
              messages,
              useCascade,
              toolCalls: collectedToolCalls.length,
            });
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
              usage: finalUsage });
            {
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking);
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [], usage });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            if (ckey && !streamCacheSkipReason) {
              cacheSet(ckey, { text: accText, thinking: accThinking });
            }
            slog.info('Stream completed', {
              ...summarizeStreamMetrics(streamMetrics),
              upstreamTimings: cascadeResult?.timings || null,
              usageSource: cascadeResult?.usage ? 'server' : 'estimated',
              cacheStored: !!(ckey && !streamCacheSkipReason),
              cacheSkipReason: streamCacheSkipReason || null,
              textChars: accText.length,
              thinkingChars: accThinking.length,
              toolCalls: collectedToolCalls.length,
              droppedDuplicateToolCalls,
              droppedOverflowToolCalls,
              abortReason: abortReason || null,
            });
            return;
          } catch (err) {
            clearToolEarlyFinishTimer();
            lastErr = err;
            reuseEntry = null;
            const failure = applyFailurePolicy(currentApiKey, modelKey, err, { cooldownTransient: !committedOutput });
            const errorType = classifyStreamError(err);
            streamMetrics.lastErrorType = errorType;

            if (!committedOutput && shouldRetryBeforeVisibleOutput(err)) {
              streamMetrics.retriesBeforeCommit++;
              slog.warn('Retrying stream on next account before visible output', {
                attempt: attempt + 1,
                errorType,
                error: sanitizeText(err.message),
                sawUpstreamProgress: attemptSawProgress,
              });
              const tag = failure.isRateLimit
                ? 'rate_limit'
                : failure.isInternal
                  ? 'internal_error'
                  : failure.isPermanentModel
                    ? 'model_error'
                    : 'upstream_error';
              log.warn(`Account ${getAccountLogLabel(acct)} failed (${tag}) on ${model}, trying next`);
              continue;
            }
            slog.warn('Stopping stream retries after visible output or non-retryable error', {
              attempt: attempt + 1,
              errorType,
              error: sanitizeText(err.message),
              committedOutput,
              sawUpstreamProgress: attemptSawProgress,
            });
            break;
          }
        }

        streamMetrics.finishedBy = committedOutput ? 'graceful_partial_close' : 'failed_before_output';
        log.error('Stream error after retries:', lastErr?.message);
        recordRequest(model, committedOutput, Date.now() - startTime, currentApiKey);
        try {
          if (committedOutput) {
            if (!rolePrinted) ensureRoleChunk();
            const usage = buildUsageBody(null, messages, accText, accThinking);
            const partialFinishReason = getPartialFinishReason(lastErr);
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: partialFinishReason }],
              usage });
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [], usage });
            res.write('data: [DONE]\n\n');
            slog.warn('Stream closed after partial output', {
              ...summarizeStreamMetrics(streamMetrics),
              upstreamTimings: lastErr?.cascadeTimings || null,
              error: sanitizeText(lastErr?.message || ''),
              textChars: accText.length,
              thinkingChars: accThinking.length,
              toolCalls: collectedToolCalls.length,
            });
          } else {
            const rl = isAllRateLimited(modelKey);
            const errType = rl.allLimited
              ? 'rate_limit_exceeded'
              : lastErr?.isModelError
                ? 'model_not_available'
                : 'upstream_error';
            const errMsg = rl.allLimited
              ? `${model} 所有账号均已达速率限制，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`
              : sanitizeText(lastErr?.message || 'no accounts');
            send({
              error: {
                message: errMsg,
                type: errType,
                ...(rl.allLimited ? { retry_after_ms: rl.retryAfterMs } : {}),
              },
            });
            res.write('data: [DONE]\n\n');
            slog.error('Stream failed before any visible output', {
              ...summarizeStreamMetrics(streamMetrics),
              upstreamTimings: lastErr?.cascadeTimings || null,
              errorType: errType,
              allRateLimited: rl.allLimited,
              error: sanitizeText(lastErr?.message || 'no accounts'),
            });
          }
        } catch {}
        if (!res.writableEnded) res.end();
      } finally {
        stopHeartbeat();
      }
    },
  };
}
