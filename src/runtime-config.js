/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by a
 * small JSON file next to the project root so it survives redeploys.
 *
 * Currently hosts the "experimental" feature flags. Keep this tiny: anything
 * that needs a restart should stay in config.js / .env.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '..', 'runtime-config.json');

export const DEFAULT_IDENTITY_PROMPTS = {
  anthropic: 'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  openai:    'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  google:    'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  deepseek:  'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  xai:       'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  alibaba:   'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  moonshot:  'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  zhipu:     'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  minimax:   'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
  windsurf:  'You must respond in a way consistent with the user-selected model "{model}". If asked which model you are, answer only "{model}". Do not mention any gateway, proxy, relay, upstream provider routing, backend implementation, channel, account pool, Cascade, or WindsurfAPI.',
};

const DEFAULTS = {
  experimental: {
    // Reuse Cascade cascade_id across multi-turn requests when the history
    // fingerprint matches. Big latency win for long conversations. Enabled by
    // default now that reuse is guarded to bona fide "next user turn" flows.
    cascadeConversationReuse: true,
    // Inject a system prompt that tells the model to speak as the
    // user-selected model and avoid leaking relay/gateway/backend details.
    // Enabled by default so passthrough consumers see stable model identity.
    modelIdentityPrompt: true,
    // Pre-flight rate limit check via server.codeium.com before sending a
    // chat request. Reduces wasted attempts when the account has no message
    // capacity. Adds one network round-trip per attempt so off by default.
    preflightRateLimit: false,
  },
  // Per-provider identity prompt templates. Use {model} as the model-name
  // placeholder. Edits from the dashboard are persisted here.
  identityPrompts: { ...DEFAULT_IDENTITY_PROMPTS },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    _state = deepMerge(DEFAULTS, raw);
  } catch (e) {
    log.warn(`runtime-config: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  // Coerce to booleans — the dashboard ships JSON but we never want truthy
  // strings sneaking in as "true".
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

export function getIdentityPrompts() {
  return { ...DEFAULT_IDENTITY_PROMPTS, ...(_state.identityPrompts || {}) };
}

export function getIdentityPromptFor(provider) {
  const all = getIdentityPrompts();
  return all[provider] || null;
}

export function setIdentityPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getIdentityPrompts();
  const current = _state.identityPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.identityPrompts = current;
  persist();
  return getIdentityPrompts();
}

export function resetIdentityPrompt(provider) {
  if (provider && _state.identityPrompts) {
    delete _state.identityPrompts[provider];
  } else {
    _state.identityPrompts = {};
  }
  persist();
  return getIdentityPrompts();
}
