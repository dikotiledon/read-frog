import { browser, defineBackground } from '#imports'
import { db } from '@/utils/db/dexie/db'
import type { ChunkMetricSampleDTO } from '@/types/translation-chunk'
import { logger } from '@/utils/logger'
import { onMessage, sendMessage } from '@/utils/message'
import { SessionCacheGroupRegistry } from '@/utils/session-cache/session-cache-group-registry'
import { ensureInitializedConfig } from './config'
import { setUpConfigBackup } from './config-backup'
import { setupGenAICookieBridge } from './cookie-bridge'
import { cleanupAllSummaryCache, cleanupAllTranslationCache, setUpDatabaseCleanup } from './db-cleanup'
import { handleAnalyzeSelectionPort, handleTranslateStreamPort, runAnalyzeSelectionStream } from './firefox-stream'
import { initMockData } from './mock-data'
import { newUserGuide } from './new-user-guide'
import { proxyFetch } from './proxy-fetch'
import { setUpRequestQueue, summarizeChunkMetrics } from './translation-queues'
import { translationMessage } from './translation-signal'

export default defineBackground({
  type: 'module',
  main: () => {
    logger.info('Hello background!', { id: browser.runtime.id })

    browser.runtime.onInstalled.addListener(async (details) => {
      await ensureInitializedConfig()

      // Clear blog cache on extension update to fetch latest blog posts
      if (details.reason === 'update') {
        logger.info('[Background] Extension updated, clearing blog cache')
        await SessionCacheGroupRegistry.removeCacheGroup('blog-fetch')
      }
    })

    onMessage('openPage', async (message) => {
      const { url, active } = message.data
      logger.info('openPage', { url, active })
      await browser.tabs.create({ url, active: active ?? true })
    })

    onMessage('openExtensionTab', async (message) => {
      const { url, active } = message.data
      logger.info('openExtensionTab', { url, active })
      const tab = await browser.tabs.create({ url, active: active ?? true })
      return tab.id
    })

    onMessage('closeExtensionTab', async (message) => {
      const { tabId } = message.data
      logger.info('closeExtensionTab', { tabId })
      await browser.tabs.remove(tabId)
    })

    onMessage('openOptionsPage', () => {
      logger.info('openOptionsPage')
      void browser.runtime.openOptionsPage()
    })

    onMessage('popupRequestReadArticle', async (message) => {
      void sendMessage('readArticle', undefined, message.data.tabId)
    })

    onMessage('analyzeSelection', async (message) => {
      try {
        return await runAnalyzeSelectionStream(message.data)
      }
      catch (error) {
        logger.error('[Background] analyzeSelection failed', error)
        throw error
      }
    })

    onMessage('recordPerfSample', async (message) => {
      try {
        await db.perfSamples.put({
          key: message.data.key,
          label: message.data.label,
          stage: message.data.stage,
          deltaMs: message.data.deltaMs,
          totalMs: message.data.totalMs,
          surface: message.data.surface ?? null,
          mode: message.data.mode ?? null,
          url: message.data.url ?? null,
          createdAt: new Date(message.data.createdAt),
        })
      }
      catch (error) {
        logger.warn('[Perf] Failed to record sample', error)
      }
    })

    onMessage('listPerfSamples', async (message) => {
      try {
        const limit = Math.min(Math.max(message.data.limit ?? 200, 1), 1000)
        const samples = await db.perfSamples.orderBy('createdAt').reverse().limit(limit).toArray()
        return samples.map(sample => ({
          key: sample.key,
          label: sample.label,
          stage: sample.stage,
          deltaMs: sample.deltaMs,
          totalMs: sample.totalMs,
          surface: sample.surface ?? undefined,
          mode: sample.mode ?? undefined,
          url: sample.url ?? undefined,
          createdAt: sample.createdAt.toISOString(),
        }))
      }
      catch (error) {
        logger.warn('[Perf] Failed to list samples', error)
        return []
      }
    })

    onMessage('getChunkMetricsSummary', async (message) => {
      try {
        const payload = message.data ?? {}
        const limit = Math.min(Math.max(payload.limit ?? 400, 1), 2000)
        const normalizedHostname = payload.hostname?.trim() ? payload.hostname.trim() : null
        const normalizedMode = payload.mode && payload.mode !== 'all' ? payload.mode : undefined
        const entries = await db.translationCache.orderBy('createdAt').reverse().limit(limit).toArray()
          const samples = [] as ChunkMetricSampleDTO[]
          for (const entry of entries) {
            if (!entry.chunkMetrics)
              continue
            if (normalizedHostname && entry.chunkMetrics.hostname !== normalizedHostname)
              continue
            if (normalizedMode && entry.chunkMetrics.mode !== normalizedMode)
              continue
            samples.push({
              key: entry.key,
              ...entry.chunkMetrics,
            })
          }
        const summary = summarizeChunkMetrics(samples)
        summary.hostname = normalizedHostname
        summary.mode = normalizedMode
        return summary
      }
      catch (error) {
        logger.warn('[Perf] Failed to summarize chunk metrics', error)
        const fallback = summarizeChunkMetrics([])
        fallback.hostname = null
        fallback.mode = undefined
        return fallback
      }
    })

    onMessage('clearPerfSamples', async () => {
      try {
        await db.perfSamples.clear()
      }
      catch (error) {
        logger.warn('[Perf] Failed to clear samples', error)
      }
    })

    browser.runtime.onConnect.addListener((port) => {
      if (port.name === 'analyze-selection-stream') {
        handleAnalyzeSelectionPort(port)
        return
      }

      if (port.name === 'translate-text-stream') {
        handleTranslateStreamPort(port)
      }
    })

    onMessage('clearAllTranslationRelatedCache', async () => {
      await cleanupAllTranslationCache()
      await cleanupAllSummaryCache()
    })

    newUserGuide()
    translationMessage()

    void setUpRequestQueue()
    void setUpDatabaseCleanup()
    setUpConfigBackup()

    proxyFetch()
    void initMockData()
    void setupGenAICookieBridge()
  },
})
