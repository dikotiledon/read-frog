# Copilot Instructions

## TL;DR
- Read Frog is a WXT (Vite-based) Manifest V3 browser extension that ships popup, multiple content scripts, background worker, and options UI under `src/entrypoints/*`.
- Use Node 24 + pnpm (see `package.json`)—`pnpm install` runs `wxt prepare` automatically and generates `.wxt/` configs.
- Aliases: `@/` resolves to `src/`, and WXT auto-imports already inject `browser`, `storage`, and `i18n` globals—lean on them instead of re-declaring.

## Build & Test Workflow
- Start Chrome dev server: `pnpm dev`. Target other browsers with `pnpm dev:edge` or `pnpm dev:firefox`; add `WXT_USE_LOCAL_PACKAGES=true` to link sibling monorepo packages.
- Production bundles: `pnpm build` (Chromium), `pnpm build:firefox`, `pnpm zip*` to emit upload zips.
- Quality gates live in package scripts: `pnpm lint`, `pnpm lint:fix`, `pnpm type-check`, `pnpm test` / `pnpm test:watch` / `pnpm test:cov`. Vitest is wired through `vitest.config.ts` with `WxtVitest` and `vitest.setup.ts` (which mocks `wxt/testing` APIs and patches `TextEncoder`).
- Releases rely on Changesets (`pnpm changeset`, `pnpm release`) and Conventional Commits enforced by commitlint.

## Architecture Highlights
- Background worker (`src/entrypoints/background/`) bootstraps config (`config.ts`), scheduled jobs (config backup, Dexie cleanup, uninstall survey), translation queues, and proxy fetch. Use `defineBackground` and keep code side-effect free for tree-shaking.
- Content entrypoints live in sibling folders (`*.content`, `popup`, `options`). Each is a React 19 app that wraps providers from `src/providers/**` and UI atoms/shadcn components.
- State lives in Jotai atoms under `src/utils/atoms/`. `configAtom` syncs through `storageAdapter` to `browser.storage.local` with Zod validation; `configFieldsAtomMap` exposes field-specific atoms. Always update `DEFAULT_CONFIG`, `configSchema`, migrations, and tests when you add settings.
- Persistent caches use Dexie (`src/utils/db/dexie`). Tables (`translationCache`, `batchRequestRecord`, `articleSummaryCache`) are versioned in `AppDB`. When altering schemas, bump the Dexie `version(x)` chain plus config migration version.
- AI translation flow: content scripts enqueue work via `sendMessage('enqueueTranslateRequest', ...)`. Background `translation-queues.ts` routes through `RequestQueue`/`BatchQueue` (`src/utils/request/*`), does deduping, caching, and optional article summary generation (`generateArticleSummary`). Respect `BatchQueue` contract (hash, batching thresholds) when adding providers.
- Remote calls go through ORPC (`src/utils/orpc/client.ts`) using `sendMessage('backgroundFetch')` to hop through the service worker and reuse cookies.

## Conventions & Patterns
- Use the `@antfu/eslint-config` defaults plus TanStack Query plugin rules: memoize query keys, avoid rest destructuring, and keep a single `QueryClient`. Violations will fail `pnpm lint`.
- UI primitives live in `src/components/shadcn` (Radix-based) and `src/components/ui`. Prefer composing existing atoms (`UserAccount`, `ProviderSelector`, `llm-status-indicator`) instead of re-styling Tailwind by hand.
- Feature code sits beside its entrypoint: e.g., popup-specific hooks/components under `src/entrypoints/popup/`, host translation helpers under `src/utils/host/`. Follow that locality when adding new surfaces.
- Localization uses `@wxt-dev/i18n` with YAML files in `src/locales/*.yml`. Add English copy first, keep keys kebab-case, and run `pnpm dev` once to regenerate message IDs.
- Styling relies on layered CSS in `src/styles/**` plus Tailwind utilities via `class-variance-authority`/`tailwind-merge`. Update `host-theme.css` when tweaking in-page injected styles.

## Safe Change Checklist
- Config changes: bump `CONFIG_SCHEMA_VERSION`, add a `migration-scripts/vXXX-to-vYYY.ts`, update `types/config/**`, `DEFAULT_CONFIG`, and extend the Jest-style fixtures in `src/utils/config/__tests__`.
- Background messaging: declare new protocol entries in `src/utils/message.ts` before using them. Remember content scripts cannot access network directly—proxy via background when hitting external APIs.
- Network/AI providers: extend `@read-frog/definitions` or local constants in `src/utils/constants/providers.ts`, keep API keys out of config snapshots using `getObjectWithoutAPIKeys`.
- Batching/rate limits: respect `requestQueueConfig` and `batchQueueConfig` (capacity, rate, size). Use `RequestQueue.enqueue` for any network call that needs dedupe/retry semantics.

## When In Doubt
- Search DeepWiki linked in `README.md` for broader docs, and skim `CLAUDE.md` for the team’s expected reasoning style (succinct, Linus-law checks).
- Prefer incremental, well-tested changes: run `pnpm test` + `pnpm lint` before requesting review and mention which entrypoints were touched.
