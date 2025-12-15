# Translation-Only Performance Roadmap

This document breaks the larger optimization initiative into tractable slices. Each milestone can be implemented, code reviewed, and tested independently while keeping the overall goal visible.

## Milestone 0 – Instrumentation Foundations

- **Deliverables**
  - Popup “Perf Lab” card surfacing `[Perf]` samples and aggregated stats (avg/p95) for the active site/mode.
  - Runtime port streaming perf events into IndexedDB (`perfSamples` table keyed by URL, mode, surface).
  - Export/reset controls so QA can share traces.
- **Acceptance**
  - Manual run updates table in realtime; clearing data empties Dexie.
  - README profiling appendix documents the Perf Lab workflow (dev-only gate, filtering, export/reset) and links back here for milestone context.
- **Execution Notes**
  1. Gate new UI behind the existing dev-only flag and run Perf Lab side-by-side with console logs to validate parity.
  2. Capture before/after screenshots plus exported JSON traces for QA sign-off; attach to PR summary for historical baselines.
  3. Keep Dexie schema versioned (v5) with smoke tests to ensure legacy profiles upgrade without user intervention.

## Milestone 1 – Storage & Normalization

- **Deliverables**
  - Dexie migration adding `perfSamples` and `chunkMetrics` (attached to translation cache rows; includes raw/clean chars, stripped flag, latency).
  - Move `normalizeHtmlForTranslation` into DOM extraction phase; hashed text now deterministic and markdown hints preserved (`<strong>` → `**`).
  - Background queue writes chunk metadata + latency into Dexie.
- **Acceptance**
  - Cache misses/hits depend solely on cleaned text.
  - Perf Lab table can display chunk statistics from Dexie.
- **Execution Plan**
  1. **Dexie v6 migration** – extend `translationCache` with `chunkMetrics` payload, write migration tests, and verify cold installs / upgrades. _Rationale:_ keeps telemetry co-located with cached content; _Impact:_ enables chunk-level pivots without extra lookups.
  2. **Normalize-at-source** – shift `normalizeHtmlForTranslation` into DOM extraction, add unit tests for deterministic hashes, and update hashing logic to use cleaned text exclusively. _Rationale:_ removes redundant cleaning stages; _Impact:_ cache hit rates become predictable and comparable across providers.
  3. **Background writers** – instrument `translation-queues.ts` to persist metrics on both cache hits and provider runs, ensuring queue wait + API latency data is always logged. _Rationale:_ closes the telemetry gap for cache hits; _Impact:_ Perf Lab can highlight whether bottlenecks are network or queue related.
  4. **Perf Lab chunk view** – extend the popup card with chunk aggregates (avg/p95 wait, stripped ratio, clean vs raw chars). _Rationale:_ QA needs immediate insight after each translation pass; _Impact:_ lowers the cost of validating optimization claims. _(Implemented)_ The dev-only card now surfaces chunk wait telemetry, provider mix, stripped ratios, and recent chunk samples pulled from Dexie so QA can validate improvements without leaving the popup.

## Milestone 2 – Queue Presets & Telemetry

- **Deliverables**
  - `translate.requestQueueConfig` gains `profile` enum (`balanced`, `aggressive`) + UI toggles in Options.
  - Background exposes `getQueueStats` endpoint (depth, backlog, active rate) consumed by Options + Perf Lab.
  - Rendering instrumentation: `Translator.DisplayLoop` + overlay emit frame/render counts into perf stream.
- **Acceptance**
  - Switching presets updates queue behavior without reload.
  - Popup shows current queue depth/backlog and render metrics.
- **Execution Plan**
  1. **Config plumbing** – add `profile` enum with default `balanced`, expose toggle in Options behind a feature flag, and persist via existing settings model. _Rationale:_ offers controlled experimentation; _Impact:_ product/QA can benchmark aggressive behavior without branching code.
  2. **Runtime presets** – wire profiles into both request and batch queues (concurrency, jitter, throttle) with live reload support. _Rationale:_ ensures toggling the UI immediately affects runtime; _Impact:_ users perceive instant latency shifts, enabling rapid iteration.
  3. **Queue telemetry API** – expose `getQueueStats` from the background worker and poll it from Perf Lab/Options. _Rationale:_ surfaces queue depth/backlog data outside the console; _Impact:_ makes diagnosing slowdowns straightforward for QA and devs.
  4. **Render instrumentation** – add perf timers around `Translator.DisplayLoop`/overlay renders, send samples through `recordPerfSample`, and visualize in Perf Lab. _Rationale:_ translation speed must include UI render cost; _Impact:_ prevents regressions where text arrives fast but renders slowly.

## Milestone 3 – GenAI Heartbeat & Error UX

- **Deliverables**
  - Background heartbeat ping (every 5 min) keeping GenAI session warm via `backgroundFetch` (opt-out when translations disabled).
  - Enhanced GenAI error handling: classify errors, retry with tuned prompt hints, surface actionable toast when aborted.
  - Perf Lab highlights session/heartbeat state.
- **Acceptance**
  - After idle >5 min, first translation no longer pays extra auth round-trip (verified via logs).
  - Heartbeat may be toggled in Options for debugging.
- **Execution Plan**
  1. **Heartbeat scheduler** – implement background interval + Options toggle (feature-flagged) that pings a lightweight GenAI endpoint and logs session age. _Rationale:_ reduces cold-start penalties; _Impact:_ translation-only mode stays under latency targets after idle.
  2. **Error taxonomy + UX** – classify provider errors (auth, throttling, transient), adjust retries/prompts accordingly, and upgrade Sonner toasts with actionable guidance. _Rationale:_ not all failures deserve the same recovery path; _Impact:_ fewer manual retries and clearer bug reports.
  3. **Perf Lab heartbeat view** – display heartbeat status, session freshness, and last error inside the card. _Rationale:_ QA needs immediate visibility during perf runs; _Impact:_ heartbeat regressions become obvious without digging through logs.

## Milestone 4 – Automation & Chaos Tests

- **Deliverables**
  - Playwright scripts for popup + floating button scenarios (Val-town doc, Kompas article) asserting translation-only <3s for 1k words.
  - Chaos suite cancelling translations mid-flight (tab close, manual abort) to ensure queues/dexie clean up.
  - CI gate running the suite.
- **Acceptance**
  - Tests fail when regressions exceed latency budget or leave dangling queue entries.
- **Execution Plan**
  1. **Perf scenarios** – author Playwright flows that launch `pnpm dev`, trigger translation-only runs, and assert Perf Lab metrics/logs stay under budget; export traces as artifacts. _Rationale:_ codifies our latency promises; _Impact:_ perf regressions block merges automatically.
  2. **Chaos coverage** – add tests that close tabs or hit abort mid-translation and verify queues/Dexie cleanup + no lingering perf samples. _Rationale:_ ensures resilience under real usage; _Impact:_ prevents zombie work items that skew metrics.
  3. **CI integration** – run both suites on a Windows runner, upload Perf Lab exports/screenshots, and wire results into PR checks. _Rationale:_ keeps perf enforcement consistent across contributors; _Impact:_ early detection of flaky or regressing behavior.

## Execution Notes

- Each milestone should result in a PR with updated docs/tests.
- Feature flags can gate new UI until stable.
- QA to capture before/after Perf Lab screenshots for release notes.
- Perf Lab exports (JSON) must be attached to milestone PRs so historical comparisons remain auditable.
- Run `pnpm lint`, unit tests, and the relevant Playwright suite locally before requesting review to avoid CI churn.
