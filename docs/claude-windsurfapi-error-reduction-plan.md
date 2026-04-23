# Claude Error Reduction Plan

Date: 2026-04-21

## Goal

Reduce the visible error rate and improve streaming stability for the
`sub2api -> WindsurfAPI -> Windsurf upstream` Claude chain, while keeping the
compatibility logic centralized in `WindsurfAPI` and avoiding changes to the
live `sub2api` server whenever possible.

## Current Implementation Status

Updated: 2026-04-23

Partially implemented in `WindsurfAPI`:

- Low-sensitive request-shape telemetry now exists for both Anthropic
  `/v1/messages` and OpenAI `/v1/chat/completions`.
- Permanent model capability failures are used during account selection through
  `isModelAllowedForAccount()`.
- Per-account/model transient cooldowns exist and are skipped by
  `getApiKey()` and `acquireAccountByKey()`.
- Pre-visible-output stream retries include rate limit, permanent model errors,
  internal upstream errors, and retryable transport/provider errors.
- Suspiciously short long-context stop replies are not cached.

Still open:

- Structured error-event persistence for dashboard breakdowns.
- LS-level quarantine for repeated panel-state failures.
- A conservative retry path for suspicious short `stop` replies in active
  tool-call mode before any visible output is sent.
- Partial-success outcome tracking separate from plain success.
- Product decision on Claude-family downgrade behavior.

## Current Findings

### Confirmed from sub2api logs

- The `windsurf-claude` account is not globally down. Recent
  `/v1/messages` requests for `claude-sonnet-4-6` and
  `claude-haiku-4-5-20251001` were mostly `200`.
- Historical Claude-related failures were mainly:
  - `404 POST /v1/messages/count_tokens not found`
  - `403 model_not_entitled`
  - `502 Bad Gateway` from the upstream nginx layer
  - historical `401 Invalid API key`
- The platform-wide error rate is also polluted by non-Claude traffic,
  especially repeated `503` on `MiniMax-M2.7`.
- There are also client-side bad requests such as `/v1/v1/messages`, which are
  unrelated to Claude model availability.

### Confirmed from WindsurfAPI code

- Anthropic-compatible `/v1/messages/count_tokens` is already handled locally
  in `src/handlers/messages.js` and routed in `src/server.js`.
- Claude model alias compatibility is already partially centralized in
  `src/models.js`.
- The streaming path already has warm-stall, cold-stall, and panel re-warm
  logic.
- Account capability failures are recorded, but current account selection does
  not meaningfully use that capability history to avoid re-routing requests to
  known-bad accounts for the same model.

## Main Problem Statement

The current error rate is still inflated because WindsurfAPI can repeatedly
route the same Claude model request to accounts that already proved they cannot
serve that model, while transient upstream failures such as `502`,
`panel state missing`, and similar LS/Cascade issues are not isolated
aggressively enough before they become user-visible failures.

This means the remaining Claude error rate is now less about basic
compatibility and more about:

- repeated routing into known-bad account/model combinations
- insufficient short-term isolation of unstable LS/upstream paths
- weak error classification and observability
- lack of controlled model-family downgrade behavior

## Design Principles

- Keep Claude compatibility and downgrade logic in `WindsurfAPI`.
- Treat `sub2api` mainly as a relay and scheduler, not as the main Claude
  compatibility layer.
- Separate permanent model entitlement failures from transient upstream
  transport failures.
- Prefer retry or reroute before exposing a failure to the client, but only
  before first visible output has been committed.
- Preserve outward-facing requested model identity unless an explicit policy
  says otherwise.

## Proposed Work

## P0

### 1. Add structured Claude error telemetry

Add a structured error event recorder alongside the current aggregated request
stats.

Suggested fields:

- `requestId`
- `route`
- `requestedModel`
- `resolvedModel`
- `accountId`
- `lsPort`
- `proxyKey`
- `stream`
- `phase`
- `errorType`
- `message`
- `committedOutput`
- `retryAttempt`
- `upstreamTimings`
- `finishedBy`

Target files:

- `src/dashboard/stats.js`
- `src/handlers/chat.js`
- `src/handlers/messages.js`

Expected benefit:

- We can finally separate `model_not_entitled`, `rate_limit`, `502`,
  `panel state missing`, warm stall, and partial-close cases instead of
  treating them as one generic failure bucket.

Risk:

- Low. Mostly additive logging and persistence.

### 2. Make capability history affect routing

Current issue:

- `updateCapability()` records success and failure per account/model.
- `getApiKey()` and `acquireAccountByKey()` currently filter by tier and
  blocklist, but do not strongly avoid accounts that recently failed on the
  same model.

Required change:

- Add a short-lived negative capability cache per account/model.
- If an account recently returned `model_not_entitled` or a clear model-level
  `403`, stop routing that model to that account for a TTL.
- Continue allowing other models on that same account.

Target files:

- `src/auth.js`

Expected benefit:

- This should directly cut repeated Claude `403` failures and stop burning the
  same bad account/model combination over and over.

Risk:

- Medium. If the TTL is too aggressive, a temporarily flaky model might be
  hidden too long. Use separate TTLs for permanent-looking vs transient errors.

### 3. Retry transient upstream failures before surfacing them

Current issue:

- Non-stream flow is already willing to retry some model/rate-limit failures,
  but transport-like failures are still too visible.
- Stream flow retries before first output mainly on model/rate-limit errors.

Required change:

- Expand the pre-first-output retry policy to include:
  - upstream `502`
  - gRPC reset / transport errors
  - `panel state missing`
  - known internal upstream errors
- If there is no visible output yet, retry on another eligible account or on a
  re-warmed LS path before returning failure.

Target files:

- `src/handlers/chat.js`
- `src/client.js`
- possibly `src/langserver.js`

Expected benefit:

- Lower visible Claude error rate without changing client behavior.

Risk:

- Medium. Must avoid endless retry loops or excessive latency inflation.

### 4. Add short-term LS and account quarantine for bad paths

Current issue:

- `panel state missing` is handled as a local re-warm, but repeated failures on
  the same LS/account path can still leak through.

Required change:

- Add short TTL quarantine for:
  - LS port after repeated `panel state missing`
  - account after repeated upstream internal errors
  - account/model after repeated transient model startup failures

Target files:

- `src/client.js`
- `src/langserver.js`
- `src/auth.js`

Expected benefit:

- Reduces repeated retries against the same broken route.

Risk:

- Medium. Quarantine logic must be narrow and time-bounded.

## P1

### 5. Add Claude family downgrade policy in WindsurfAPI

Current issue:

- When an exact Claude model is not callable, the request can still fail even
  though the account pool may have a reasonable same-family fallback.

Required change:

- Add an internal downgrade policy such as:
  - `claude-opus-4-7 -> claude-opus-4.6`
  - `claude-opus-4-5-* -> claude-opus-4.6`
  - `claude-sonnet-4-5-* -> claude-sonnet-4.6`
  - `claude-haiku-4-5-20251001 -> claude-4.5-haiku`
- Only downgrade within a defined family/policy, not arbitrarily.
- Keep the requested outward model identity if the product decision is to hide
  the downgrade from clients.

Target files:

- `src/models.js`
- `src/handlers/chat.js`
- `src/handlers/messages.js`

Expected benefit:

- Fewer hard `403 model_not_entitled` responses for Claude clients.

Risk:

- Medium to high. This is a product decision as much as a technical one, since
  hidden downgrade changes actual backend capability.

### 6. Separate permanent vs transient unavailability

Required change:

- Treat these as different classes:
  - permanent or semi-permanent:
    - `model_not_entitled`
    - explicit `permission_denied`
  - transient:
    - `502`
    - transport reset
    - panel missing
    - upstream internal error
    - rate limit

Expected benefit:

- Avoids poisoning the account/model cache with short-lived upstream issues.

Target files:

- `src/auth.js`
- `src/handlers/chat.js`
- `src/client.js`

Risk:

- Low to medium. Mainly classification correctness.

### 7. Add Claude-only dashboard breakdown

Required change:

- Add a dashboard view that isolates Claude traffic from the rest of the
  platform and breaks failures down by exact reason.

Suggested dimensions:

- model
- account
- error type
- stream vs non-stream
- before-output vs after-output
- partial-close count

Target files:

- `src/dashboard/api.js`
- `src/dashboard/index.html`
- `src/dashboard/stats.js`

Expected benefit:

- Stops Claude diagnosis from being polluted by unrelated channels such as
  `MiniMax`.

Risk:

- Low.

## P2

### 8. Improve streaming smoothness

Current issue:

- Claude path is functional, but streaming can still feel uneven, especially
  when the upstream spends too long in silent planning/thinking or when the
  staged flush thresholds are too conservative.

Required change:

- Continue reducing first visible token latency.
- Tune staged flush thresholds for text and thinking.
- Reduce cases where tiny preambles are emitted and then the stream stalls.
- Track and surface:
  - `firstVisibleMs`
  - `firstTextMs`
  - `firstThinkingMs`
  - warm-stall retry count
  - partial-close count

Target files:

- `src/handlers/chat.js`
- `src/client.js`

Expected benefit:

- Better UX even when the hard error rate is already low.

Risk:

- Medium. Too aggressive flush settings can increase jitter or reveal unstable
  rewrites.

### 9. Separate partial success from full success in stats

Current issue:

- A stream that already emitted output and then closed with a partial finish is
  currently counted as success in the top-level stats.

Required change:

- Add a `partial_success` or similar outcome class instead of folding it into
  plain success.

Expected benefit:

- Better operational truth. Error rate stays meaningful without hiding degraded
  user experience.

Target files:

- `src/dashboard/stats.js`
- `src/handlers/chat.js`

Risk:

- Low.

## Recommended Execution Order

1. P0.1 structured telemetry
2. P0.2 capability-aware routing
3. P0.3 pre-output transient retry expansion
4. P0.4 LS and account quarantine
5. P1.6 permanent vs transient classification cleanup
6. P1.5 Claude family downgrade
7. P1.7 Claude-only dashboard breakdown
8. P2 streaming smoothness work
9. P2 partial-success metrics

## Success Criteria

We consider this work successful when:

- repeated `model_not_entitled` failures stop hitting the same account/model
  path
- pre-first-token Claude failures drop noticeably
- `502` and panel-related issues are mostly absorbed by retry or reroute
- Claude dashboard error composition becomes explainable by exact reason
- streaming partial-close incidents become measurable and trend downward

## Notes For Tomorrow

- Do not start by changing `sub2api`.
- First implement the observability and routing parts in `WindsurfAPI`.
- Only add downgrade behavior after the permanent/transient error taxonomy is
  clean enough to avoid masking real upstream problems.
