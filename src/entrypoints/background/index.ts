import { browser, defineBackground } from '#imports'
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
import { setUpRequestQueue } from './translation-queues'
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
