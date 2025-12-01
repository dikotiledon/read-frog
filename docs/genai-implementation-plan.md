# Samsung GenAI Provider – Implementation Plan

## 1. Context & Current Capabilities
- **Provider wiring**: `GenAIProviderConfig` already exists in `src/types/config/provider.ts`, default models point to `gauss-flash`, and the provider can be added/enabled from the Options UI.
- **Service access**: All network calls go through `fetch(..., { credentials: 'include' })` so the browser session cookies are reused. No API key is needed.
- **Interactive login**: `src/utils/genai/session.ts` exposes `ensureGenAISession`, which checks `/api/account/auth/session` and, when unauthenticated, opens `https://genai.sec.samsung.net` in a new tab until Samsung SSO finishes, then closes the tab.
- **Translation/read flow**: Both `genaiTranslate` and `genaiGenerateText` are routed through `executeTranslate`/`aiTranslate`/`useRead`, so queued translations and read-mode summaries already hit GenAI when selected.
- **Documentation**: `manual run in browser.txt` now starts with a checklist describing the SSO-only workflow, but README still needs a section for the provider.

## Latest Progress (Dec 1, 2025)
- **Streaming reliability**: `readEventStream` now captures every visible CHUNK token and returns both the final `guid` and concatenated content, so short answers (e.g., "嗨") are never lost when Samsung emits metadata-only terminal events.
- **Message polling**: After SSE completion we poll `/api/chat/v1/messages/{guid}` until the body contains text; if Samsung reports `status: SUCCESS` or any `responseCode` while the payload is still empty, we fall back to the streamed content instead of surfacing a blank translation.
- **Test coverage**: `src/utils/genai/__tests__/client.test.ts` exercises the SSE fallback path plus the new polling helper (success, timeout, failure, and fallback scenarios), and the suite is green.

## 2. Product Goals & Constraints
1. Allow users to run every Read Frog feature (page translation, selection translation, read summaries, AI content aware) with GenAI as the provider.
2. No API key; the browser session + Samsung corporate SSO are the only auth mechanisms.
3. When GenAI is chosen and the session is missing/expired, open a login tab automatically, reuse cookies once `/session` returns user data, then close the tab.
4. Make the UX self-explanatory: clearly warn that a Samsung login tab will appear, and provide manual instructions/tests for QA.
5. Maintain parity across locales and document the workflow in README + manual run instructions.

## 3. Technical Workstreams
### 3.1 Config & Data Model
- Keep `genai` entries in `READ_PROVIDER_MODELS`, `TRANSLATE_PROVIDER_MODELS`, and `DEFAULT_PROVIDER_CONFIG_LIST` (`src/types/config/provider.ts` + `src/utils/constants/providers.ts`).
- Bump `CONFIG_SCHEMA_VERSION` when config shape changes; add migration scripts under `src/utils/config/migration-scripts` and fixtures under `src/utils/config/__tests__/example`.
- Extend `configFieldsAtomMap` and provider atoms so the Options page reflects GenAI settings instantly.

### 3.2 Session Lifecycle & Permissions
- `src/utils/genai/session.ts`
  - Keep `ensureGenAISession` as the single entry point. It should short-circuit when cookies are valid, otherwise call `runInteractiveLogin`.
  - `runInteractiveLogin` opens a foreground tab via `browser.tabs.create`, polls `/api/account/auth/session` every `GENAI_SESSION_RETRY_INTERVAL_MS`, and closes the tab once the response status is `200`.
  - Surface descriptive errors for timeout, user-interrupted login, or unexpected status codes.
- `wxt.config.ts`: ensure `host_permissions` and `permissions` cover `https://genai.sec.samsung.net/*` for Chromium, Firefox, and Edge builds.

### 3.3 Translation & Read Execution
- `src/utils/host/translate/execute-translate.ts`: already routes LLM providers through `aiTranslate`; keep `isGenAIProviderConfig` short-circuiting to `genaiTranslate`.
- `src/utils/genai/client.ts`
  - Functions: `createChat`, `sendUserMessage`, `waitForAssistantMessage` (SSE), `getMessageContent`.
  - Ensure SSE parsing handles `event_status` values `FINAL_ANSWER` & `SUCCESS`, captures the final `guid`, and throws informative errors when the stream ends prematurely. The parser now also accumulates visible CHUNK content so we can fall back to it when `/messages/{guid}` lags.
  - After SSE completion, keep polling `/api/chat/v1/messages/{guid}` until `content` is populated or a failure status is returned; when the API reports success but keeps `content` empty, use the streamed fallback payload.
  - Support optional batch metadata via `options?: { isBatch?: boolean, content?: ArticleContent }` so AI content aware keeps working.
- `src/hooks/read/read.tsx` & `src/utils/content/summary.ts`: fall back to `genaiGenerateText` whenever the provider config is GenAI, so read-mode and article summaries share the same auth/session flow.

### 3.4 Background Queues & Caching
- `src/entrypoints/background/translation-queues.ts`
  - `BatchQueue`/`RequestQueue` should treat GenAI just like other LLM providers; ensure `getBatchKey` includes provider ID so GenAI requests are isolated.
  - When AI Content Aware is on, summaries should use GenAI to avoid leaking across providers.
- `src/utils/db/dexie/*`: translation cache + article summary cache entries should include the provider ID and, if necessary, baseURL to avoid cross-contamination.

### 3.5 UX & Messaging
- Options UI (`src/entrypoints/options/pages/api-providers/**`)
  - Connection button: keep enabled even without API keys (`connection-button.tsx`).
  - Add helper text or tooltip explaining that GenAI will open a Samsung login tab.
  - Consider an explicit “Open Samsung GenAI” action that just calls `ensureGenAISession` so users can pre-login.
- Runtime notifications
  - When `ensureGenAISession` starts an interactive login, show a toast (“Opening Samsung GenAI to refresh your session”).
  - If the login fails or times out, surface a retry CTA and link to manual instructions.
- Provider picker badges: mark GenAI as supporting both Read & Translate.

### 3.6 Observability & Error Handling
- `src/utils/logger.ts`: add structured logs for session checks, login attempts, SSE parsing failures, and translation failures specific to GenAI.
- Optional: send anonymized telemetry events (success/failure counters) to help monitor stability once released.

### 3.7 Documentation
- `README.md`: add a “Samsung GenAI (SSO-only)” section describing prerequisites, how auto-login works, and a link to `manual run in browser.txt` for the detailed step-by-step flow.
- `manual run in browser.txt`: already documents every redirect; keep it updated when Samsung changes the flow.
- Localizations (`src/locales/*.yml`): ensure every locale contains a `options.apiProviders.providers.description.genai` entry.

### 3.8 Testing & QA
1. **Unit tests**
   - `src/utils/genai/__tests__/session.test.ts`: mock `fetch` + `browser.tabs` to cover logged-in, interactive login, and timeout paths.
  - `src/utils/genai/__tests__/client.test.ts`: mock SSE responses to test `readEventStream`, message-content polling, and fallback behavior when the REST payload is empty.
2. **Integration tests** (Vitest / Playwright)
   - Stub GenAI endpoints to validate translation queue + Options UI flows without hitting the real service.
3. **Manual QA checklist**
   - Follow the manual-run doc: verify interactive login, translation, read mode, and failure recovery.
   - Clear cookies to ensure the tab auto-opens again; confirm it closes automatically once `/session` returns user data.
4. **Quality gates**: `pnpm lint`, `pnpm type-check`, `pnpm test` must all pass pre-commit.

### 3.9 Release & Support
- Add a Changeset entry announcing GenAI support and describing the SSO tab behavior.
- Update release notes and support macros to instruct users to stay logged into the Samsung portal.
- Monitor telemetry/logs after rollout; if session errors spike, raise alerts and coordinate with the Samsung SSO team.

## 4. Environments, Build, & Permissions
- **Browser permissions**: `wxt.config.ts` now whitelists `https://genai.sec.samsung.net/*` in both `permissions` (for `tabs`/`cookies`) and `host_permissions`. Keep Chromium/Edge/Firefox manifests in sync whenever Samsung changes hostnames.
- **Local development**: run `pnpm dev` with `WXT_USE_LOCAL_PACKAGES=true` when testing against sibling packages; GenAI still requires Samsung VPN + SSO even in dev mode.
- **Environment variables**: no API keys, but ensure `.env.*` files disable conflicting providers during QA runs so translation queues only hit GenAI.
- **Build verification**: block releases unless `pnpm build`, `pnpm lint`, `pnpm type-check`, and targeted Vitest suites pass on Node 24 + pnpm (mirrors CI matrix).

## 5. Milestones & Ownership
1. **Foundation (Week 1)** – lock in config defaults, host permissions, and session helpers; owners: platform team.
2. **Client plumbing (Week 2)** – finish GenAI client, queue wiring, and caching adjustments; owners: backend/infra pairing with extension team.
3. **UX + docs (Week 3)** – polish Options UI copy, add i18n strings, README/manual run updates, and interactive login toasts; owners: design + front-end.
4. **Testing & hardening (Week 4)** – expand Vitest coverage, set up mocked integration tests, run manual QA checklist across Chrome/Edge/Firefox, and collect telemetry dry-runs; owners: QA + release engineering.
5. **Launch (Week 5)** – ship behind a staged rollout flag, monitor logs, and prepare hotfix plan.

## 6. Risks & Mitigations
- **Samsung SSO flakiness**: login redirects may change; keep `manual run in browser.txt` updated and add feature flags so we can quickly disable GenAI if endpoints drift.
- **Long-lived login tabs**: if the tab fails to close, add a watchdog (timeout + toast) reminding users they can close it manually, and log tab IDs for troubleshooting.
- **Translation queue congestion**: GenAI latency could block other providers; ensure provider IDs partition BatchQueue keys and consider per-provider concurrency caps.
- **Cookie scope issues**: Firefox sometimes isolates storage; add troubleshooting tips in docs and consider using `browser.cookies` API to detect missing cookies before opening tabs.
- **Telemetry gaps**: without provider-specific metrics, failures are invisible; add structured logs + optional ORPC events tagged `provider:genai`.

## 7. Open Questions
1. Do we need differential base URLs for staging vs. production Samsung environments? (If yes, expose `baseURL` in Options with validation.)
2. Should interactive login spawn a new window instead of a tab for kiosk setups?
3. What are the retention rules for GenAI conversation data, and do we need to surface disclaimers in the UI?
4. Can we cache successful sessions per-profile to avoid repeated polling when multiple extension surfaces (popup + side panel) fire simultaneously?
5. Are there corporate compliance requirements (e.g., data residency) that impact Dexie cache storage for GenAI outputs?

## 8. Success Metrics
- **Technical**: <2% session refresh failures per day, 95th percentile interactive login under 25 seconds, zero cross-provider cache leaks.
- **Product**: ≥90% of Samsung pilot users complete the manual QA checklist without assistance, and GenAI usage accounts for ≥30% of translation jobs inside the corp tenant within one month.
- **Support**: Time-to-resolution for GenAI tickets under 1 business day, with canned responses linked directly to the README + manual run docs.
