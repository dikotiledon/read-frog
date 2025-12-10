# GenAI Batching & Reliability Plan

_Last updated: 2025-12-09_

This document captures the design, work plan, and follow-up items for making the Samsung GenAI provider more reliable by batching DOM translations instead of sending one request per snippet. Future contributors can resume the effort from here if the current session is interrupted.

## 1. Background & Problem Statement

- The content-script walkers (`translateNodes*`) fire `translateText` immediately for each snippet, resulting in dozens of simultaneous GenAI requests on dense pages.
- GenAI chats are rate-limited and expensive to set up; line-by-line prompts trigger throttling, long latency, and cache misses.
- Non-GenAI LLM providers already benefit from `BatchQueue`, but GenAI bypasses batching entirely because responses must map back to DOM nodes.

## 2. Goals

1. Reduce GenAI request volume by aggregating multiple DOM snippets per prompt while preserving placement accuracy.
2. Keep per-node UX intact (spinners, cancellation, retries, bilingual/translation-only modes).
3. Maintain caching, queueing, and tab-cancellation semantics.
4. Provide observability (batch size, fallback counts) for future tuning.

## 3. High-Level Architecture Changes

| Area              | Changes                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content script    | Introduce a `GenAIBatchController` that buffers translation targets, assigns chunk IDs, and resolves per-node promises when batched responses arrive.                                      |
| Prompt generation | Extend `getTranslatePrompt` with a chunked mode that emits `<chunk id="n">` blocks and instructions for mirrored output; reuse `BATCH_SEPARATOR` only for legacy providers.                |
| Messaging         | Add a dedicated message (e.g., `enqueueGenAIBatch`) that carries an array of chunk payloads plus contextual metadata (article title/summary, hashes, clientRequestId).                     |
| Background queue  | Reuse `BatchQueue` for GenAI providers, but supply pre-batched text plus a chunk map. Parse response back into `{ chunkId, translation }[]` and send to the requester.                     |
| GenAI client      | Allow `genaiTranslate` to accept chunk arrays, build a single prompt, wait for assistant output once, and parse `<chunk>` sections; fall back to individual translations if parsing fails. |
| Cache             | Adjust translation hash composition so identical text with the same prompt settings maps to the same cache entry even when chunk metadata differs.                                         |
| Telemetry         | Log batch sizes, parse failures, fallbacks, and cancellations for troubleshooting.                                                                                                         |

## 4. Detailed Work Plan

### Phase A – Content Script Aggregator

1. Create `src/utils/host/translate/genai-batch-controller.ts`:
   - Buffer entries `{ nodeRefs, text, chunkMetadata, resolve, reject, hash }`.
   - Configurable `flushDelay`, `maxChars`, `maxItems` (read from `config.translate.batchQueueConfig`).
   - Flush when exceeding budgets or when `flush()` is called explicitly (e.g., walk completion).
2. Update `translateNodes*` and `getTranslatedTextAndRemoveSpinner` to request translations through the controller instead of calling `translateText` directly. Each call receives a promise tied to the specific chunk ID.
3. Preserve existing abort behavior: if a wrapper is removed or translation toggled off, notify the controller so buffered entries are cancelled.
4. Ensure chunk metadata (group/index/total) is stored on the batch entries; when multiple snippets share a walk ID, keep consistent numbering.

### Phase B – Prompt & Hash Updates

1. Extend `getTranslatePrompt` with options: `{ mode: 'single' | 'batch' | 'chunked' }`.
2. For chunked mode:
   - Wrap each text in `<chunk id="CHUNK_ID">` tags.
   - Append rules requiring GenAI to respond with identical tags and to never mention metadata.
3. Add constants for `CHUNK_OPEN`, `CHUNK_CLOSE`, regexes for parsing, and error messages.
4. Update `translate-text.ts` hashing so chunk metadata (index, total, group) is excluded from the cache key when using chunked aggregation.

### Phase C – Messaging & Background Queue

1. Define `enqueueGenAIBatch` in `translation-queues.ts`:
   - Payload: `{ chunks: Array<{ id, text, hash, chunkMetadata }>, langConfig, providerConfig, articleContext, clientRequestId, scheduleAt }`.
   - On receive, compute combined text + prompt once and enqueue via `BatchQueue`.
2. Rework GenAI branching so batched data no longer bypasses `BatchQueue`. Instead, `executeBatch` hands a combined string to `executeTranslate(..., { isBatch: true, chunkMap, content })`.
3. Modify response path to emit `{ chunkId, translation }[]` back to the originating tab (likely via `browser.tabs.sendMessage` or resolving the original `sendMessage` promise).
4. Maintain dedupe with `hash`: the batch hash can be `Sha256Hex(...chunk.hashes)`.

### Phase D – GenAI Client Enhancements

1. Update `aiTranslate` and `genaiTranslate` to accept `options.chunkMap?: ChunkMapEntry[]`.
2. When chunkMap is present:
   - Build the chunked prompt string using new templates.
   - After retrieving assistant content, parse using the regex parser.
   - If some chunks are missing or parsing fails, return a structured error so the caller can retry those chunks individually.
3. Preserve chat pooling, cancellation, and fallback behavior.

### Phase E – Front-End Reconciliation

1. The batch controller resolves each node’s promise once the background response arrives; `getTranslatedTextAndRemoveSpinner` now simply `await chunkPromise`.
2. On errors, display the existing React error component with chunk context.
3. Ensure bilingual mode still inserts translations inline/blocks after the promise resolves.

### Phase F – Testing & Telemetry

1. Unit tests:
   - Chunk prompt builder and parser.
   - Batch controller flush logic and cancellation.
   - Background handler splitting & merging results.
2. Integration smoke test: stub GenAI client to verify that 10 snippets result in a single prompt.
3. Logging:
   - `translation-queues.ts`: log `batchSize`, `chars`, `providerId`, fallback reason.
   - `genai client`: warn when chunks missing.

## 5. Data Structures & Message Formats

```ts
// Content script → background
interface GenAIChunkPayload {
  id: string
  text: string
  hash: string
  chunkMetadata?: TranslationChunkMetadata
}

interface EnqueueGenAIBatchMessage {
  chunks: GenAIChunkPayload[]
  langConfig: Config['language']
  providerConfig: GenAIProviderConfig
  clientRequestId: string
  scheduleAt: number
  articleContext?: ArticleContent
}

// Background → content script
interface GenAIChunkResult {
  id: string
  translation: string
  error?: string
}
```

## 6. Rollout & Validation Checklist

1. Implement behind a feature flag (`config.translate.useGenAIBatching`) for gradual rollout.
2. Manual tests:
   - Translate news/blog page with dozens of paragraphs; monitor DevTools network to ensure one GenAI request per batch.
   - Toggle translation on/off mid-flight to verify cancellation.
   - Switch between bilingual and translation-only modes.
   - Verify caching by reloading the page—batched translations should reuse cache entries.
3. Telemetry review after release to confirm reduced throttling.

## 7. Open Questions / Follow-Ups

- Do we need to persist batch size preferences per provider or rely on global config?
- Should we introduce exponential backoff when GenAI returns partial chunks, or immediately retry individually?
- Do we need migrations for any new config fields (e.g., feature flag, chunk templates)? Likely yes—bump `CONFIG_SCHEMA_VERSION`.

## 8. Implementation Progress (2025-12-09)

- ✅ Content-script batching controller created (`genai-batch-controller.ts`) and wired through `translateText` for GenAI providers only.
- ✅ New messaging route `enqueueGenAIBatch` plus background handler that executes combined requests, parses results, and writes per-chunk cache entries.
- ✅ Prompt builder updated with chunk metadata lists to retain context when multiple segments are sent together.
- ✅ `genaiTranslate` now monitors `/messages/{guid}` in parallel and aborts the `/messages-response` SSE stream when the server reports an error, preventing hung streams.
- ✅ Feature flag + config migration landed; `translate.useGenAIBatching` now gates batched vs legacy flows and defaults to on.
- ✅ Batch controller now listens to wrapper abort signals, exposes `cancelChunk`, and logs flush/cancel telemetry (chunk counts, flush reasons, cancellation totals).
- ✅ Recoverable-error handling implemented: batch attempts retry once (R50004, mismatches, unexpected tokens) before falling back to per-chunk GenAI requests while reusing cache hits.
- ✅ `/messages-response` cancel helper implemented: new endpoint call fires whenever SSE is aborted (user toggle, GenAI errors) so the server stops streaming immediately.
- ✅ Reliability telemetry persisted: new `genaiReliabilityLog` Dexie table records retry attempts, response codes, fallback durations, and SSE cancel reasons for later analysis.
- 🔄 Remaining: manual QA sign-off before broad rollout.

## 9. Known Issues & Error Handling

- **R50004 “Model Execution Error” / `Unexpected token 200007`**
  - Appears after the chat has been accepted and the assistant message transitions from `PROCESS` to `ERROR`, causing `waitForAssistantMessage` to throw.
  - Current behavior: the error propagates to the spinner UI, which surfaces a generic failure.
  - Mitigation plan:
    1. Detect GenAI response codes (e.g., `R50004`) and mark them as _recoverable_.
    2. Release/replace the current chat lease to avoid poisoning the pool, then retry the same batch once (with exponential backoff).
    3. If the retried batch still fails—or GenAI responds with missing chunks—fallback to per-chunk requests via the legacy `enqueueTranslateRequest` so the page continues translating.
    4. Emit telemetry (batch id, chunk ids, response code, retry count) to help quantify frequency.

## 10. Upcoming Next Steps (tracking)

1. **Manual validation & QA**
   - Run end-to-end tests on representative pages (Google home, long articles) to verify separators, caching, translation modes, retries, and cancellation UX.
   - Document any anomalies (e.g., misordered output, leftover spinners) before enabling the feature flag by default.
2. **Dashboard integration (optional)**
   - Surface the new `genaiReliabilityLog` metrics inside the Statistics page or exported telemetry dashboards so trends are visible during rollout.

## 11. `/messages-response` Cancellation Plan

The Samsung GenAI web client aborts the `/api/chat/v1/messages-response` SSE stream as soon as the corresponding `/messages/{guid}` call reports `ERROR` or the user cancels. Our client currently leaves the stream running, which wastes resources and can leak translations. Plan:

1. **Reverse-engineer cancel endpoint**
   - From `scrap/chat-*.js`, confirm the exact REST call (likely `POST /api/chat/v1/messages-response/cancel` with `{ messageGuid }`).
   - Document payload/headers so we can call it from `genai/client.ts`.
2. **Implement `cancelMessageResponse` helper**
   - New helper invokes the cancel endpoint and swallows errors (best-effort cleanup).
   - Wire it into `waitForAssistantMessage` / `waitForMessageContent`: whenever we detect `status: ERROR`, `responseCode`, or the abort controller fires, call the helper before rejecting.
3. **Propagate abort signals**
   - Ensure every translation request has an `AbortController` shared between the batch controller, `waitForAssistantMessage`, and `waitForMessageContent`.
   - When users toggle translation off, wrappers call `controller.cancel(chunkId)` → abort controller → SSE cancel helper.
4. **Telemetry & retries**
   - Log each cancel invocation (messageGuid, reason). Use this signal to trigger the retry/fallback path described above (e.g., retry once after canceling, then fall back to per-chunk requests).
5. **Testing**
   - Simulate GenAI errors via mocked responses to confirm SSE stop occurs immediately.
   - Observe DevTools network to ensure `/messages-response` closes promptly and the cancel request (if needed) succeeds.

---

Use this document as the authoritative checklist when implementation resumes. Update sections as decisions land or new findings emerge.
