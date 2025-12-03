import { browser } from '#imports'
import type { Config } from '@/types/config/config'
import type { GenAIProviderConfig, LLMTranslateProviderConfig, ProviderConfig, TranslateProviderTypes } from '@/types/config/provider'
import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { isGenAIProviderConfig, isLLMTranslateProviderConfig } from '@/types/config/provider'
import { putBatchRequestRecord } from '@/utils/batch-request-record'
import { DEFAULT_CONFIG } from '@/utils/constants/config'
import { BATCH_SEPARATOR } from '@/utils/constants/prompt'
import { TRANSLATE_PROVIDER_CHARACTER_LIMITS } from '@/utils/constants/providers'
import { MIN_BATCH_CHARACTERS } from '@/utils/constants/translate'
import { generateArticleSummary } from '@/utils/content/summary'
import { cleanText } from '@/utils/content/utils'
import { db } from '@/utils/db/dexie/db'
import { Sha256Hex } from '@/utils/hash'
import { executeTranslate } from '@/utils/host/translate/execute-translate'
import { logger } from '@/utils/logger'
import { onMessage } from '@/utils/message'
import { BatchQueue } from '@/utils/request/batch-queue'
import { RequestQueue } from '@/utils/request/request-queue'
import { warmGenAIChatPool } from '@/utils/genai/client'
import { GENAI_CHAT_MAX_SLOTS_PER_KEY } from '@/utils/genai/constants'
import { ensureInitializedConfig } from './config'

export function parseBatchResult(result: string): string[] {
  return result.split(BATCH_SEPARATOR).map(t => t.trim())
}

interface TranslateBatchData {
  text: string
  langConfig: Config['language']
  providerConfig: ProviderConfig
  hash: string
  scheduleAt: number
  content?: ArticleContent
  maxCharsPerRequest: number
  clientRequestId: string
  tabId?: number
  chunkMetadata?: TranslationChunkMetadata
}

const clientRequestRegistry = new Map<string, { tabId?: number }>()
const tabToClientRequestIds = new Map<number, Set<string>>()
let hasRegisteredTabRemovalListener = false
const genaiBacklogCounts = new Map<string, number>()

function registerClientRequest(clientRequestId: string, tabId?: number) {
  clientRequestRegistry.set(clientRequestId, { tabId })

  if (typeof tabId === 'number') {
    const requestIds = tabToClientRequestIds.get(tabId) ?? new Set<string>()
    requestIds.add(clientRequestId)
    tabToClientRequestIds.set(tabId, requestIds)
  }
}

function releaseClientRequest(clientRequestId: string) {
  const entry = clientRequestRegistry.get(clientRequestId)
  if (!entry)
    return

  clientRequestRegistry.delete(clientRequestId)

  if (typeof entry.tabId === 'number') {
    const requestIds = tabToClientRequestIds.get(entry.tabId)
    if (!requestIds)
      return
    requestIds.delete(clientRequestId)
    if (requestIds.size === 0)
      tabToClientRequestIds.delete(entry.tabId)
  }
}

function getGenAIBacklogKey(providerConfig: GenAIProviderConfig): string {
  const baseURL = providerConfig.baseURL?.trim().toLowerCase() ?? ''
  return `${providerConfig.id}:${baseURL}`
}

function incrementGenAIBacklog(providerConfig: GenAIProviderConfig): number {
  const key = getGenAIBacklogKey(providerConfig)
  const next = (genaiBacklogCounts.get(key) ?? 0) + 1
  genaiBacklogCounts.set(key, next)
  return next
}

function decrementGenAIBacklog(providerConfig: GenAIProviderConfig): number {
  const key = getGenAIBacklogKey(providerConfig)
  const next = Math.max((genaiBacklogCounts.get(key) ?? 1) - 1, 0)
  if (next === 0)
    genaiBacklogCounts.delete(key)
  else
    genaiBacklogCounts.set(key, next)
  return next
}

function computeDesiredGenAISlots(backlogSize: number): number {
  if (backlogSize <= 1)
    return 1
  return Math.min(GENAI_CHAT_MAX_SLOTS_PER_KEY, Math.max(1, Math.ceil(backlogSize / 2)))
}

function requestGenAIWarmSlots(providerConfig: GenAIProviderConfig, backlogSize: number) {
  const desiredSlots = computeDesiredGenAISlots(backlogSize)
  void warmGenAIChatPool(providerConfig, 'translate', desiredSlots).catch((error) => {
    logger.warn('Failed to warm GenAI chat slots', {
      providerId: providerConfig.id,
      desiredSlots,
      error,
    })
  })
}

const PROVIDER_BATCH_SAFE_RATIO = 0.8

function resolveProviderBatchLimit(
  providerConfig: ProviderConfig,
  configuredLimit: number,
): number {
  const providerLimit = TRANSLATE_PROVIDER_CHARACTER_LIMITS[providerConfig.provider as TranslateProviderTypes]
  if (!providerLimit) {
    return Math.max(MIN_BATCH_CHARACTERS, configuredLimit)
  }
  const safeProviderBudget = Math.floor(providerLimit * PROVIDER_BATCH_SAFE_RATIO)
  return Math.max(
    MIN_BATCH_CHARACTERS,
    Math.min(configuredLimit, safeProviderBudget),
  )
}

export async function setUpRequestQueue() {
  const config = await ensureInitializedConfig()
  const {
    translate: {
      requestQueueConfig: {
        rate,
        capacity,
        timeoutMs,
        maxRetries,
        baseRetryDelayMs,
      },
      batchQueueConfig: { maxCharactersPerBatch, maxItemsPerBatch },
    },
  } = config ?? DEFAULT_CONFIG

  const requestQueue = new RequestQueue({
    rate,
    capacity,
    timeoutMs,
    maxRetries,
    baseRetryDelayMs,
  })

  const enqueueLLMRequest = async (data: TranslateBatchData) => {
    const { text, langConfig, providerConfig, hash, scheduleAt, content, chunkMetadata } = data
    const thunk = async () => {
      await putBatchRequestRecord({ originalRequestCount: 1, providerConfig })
      return executeTranslate(text, langConfig, providerConfig, { content, chunkMetadata })
    }
    return requestQueue.enqueue(thunk, scheduleAt, hash)
  }

  const enqueueGenAIRequest = async (data: TranslateBatchData & { providerConfig: GenAIProviderConfig }) => {
    const backlogSize = incrementGenAIBacklog(data.providerConfig)
    requestGenAIWarmSlots(data.providerConfig, backlogSize)

    try {
      const { text, langConfig, providerConfig, hash, scheduleAt, content, chunkMetadata } = data
      const runTask = async () => {
        await putBatchRequestRecord({ originalRequestCount: 1, providerConfig })
        return executeTranslate(text, langConfig, providerConfig, { content, chunkMetadata })
      }
      return await requestQueue.enqueue(runTask, scheduleAt, hash)
    }
    finally {
      decrementGenAIBacklog(data.providerConfig)
    }
  }

  /**
   * Get cached summary or generate a new one (using requestQueue for deduplication)
   */
  async function getOrGenerateSummary(
    articleTitle: string,
    articleTextContent: string,
    providerConfig: LLMTranslateProviderConfig,
  ): Promise<string | undefined> {
    // Prepare text for cache key
    const preparedText = cleanText(articleTextContent)
    if (!preparedText) {
      return undefined
    }

    // Generate cache key from text content hash and provider config
    const textHash = Sha256Hex(preparedText)
    const cacheKey = Sha256Hex(textHash, JSON.stringify(providerConfig))

    // Check cache first
    const cached = await db.articleSummaryCache.get(cacheKey)
    if (cached) {
      logger.info('Using cached article summary')
      return cached.summary
    }

    // Use requestQueue to deduplicate concurrent summary generation requests
    const thunk = async () => {
      // Double-check cache inside thunk (another request might have cached it)
      const cachedAgain = await db.articleSummaryCache.get(cacheKey)
      if (cachedAgain) {
        return cachedAgain.summary
      }

      // Generate new summary
      const summary = await generateArticleSummary(articleTitle, articleTextContent, providerConfig)
      if (!summary) {
        return ''
      }

      // Cache the summary
      await db.articleSummaryCache.put({
        key: cacheKey,
        summary,
        createdAt: new Date(),
      })

      logger.info('Generated and cached new article summary')
      return summary
    }

    try {
      const summary = await requestQueue.enqueue(thunk, Date.now(), cacheKey)
      return summary || undefined
    }
    catch (error) {
      logger.warn('Failed to get/generate article summary:', error)
      return undefined
    }
  }

  const batchQueue = new BatchQueue<TranslateBatchData, string>({
    maxCharactersPerBatch,
    maxItemsPerBatch,
    batchDelay: 100,
    maxRetries: 3,
    enableFallbackToIndividual: true,
    getBatchKey: (data) => {
      return Sha256Hex(`${data.langConfig.sourceCode}-${data.langConfig.targetCode}-${data.providerConfig.id}`)
    },
    getCharacters: (data) => {
      return data.text.length
    },
    getMaxCharactersForTask: (data) => data.maxCharsPerRequest,
    executeBatch: async (dataList) => {
      if (dataList.length === 1)
        return [await enqueueLLMRequest(dataList[0])]

      const { langConfig, providerConfig, content } = dataList[0]
      const texts = dataList.map(d => d.text)
      const batchText = texts.join(`\n\n${BATCH_SEPARATOR}\n\n`)
      const hash = Sha256Hex(...dataList.map(d => d.hash))
      const earliestScheduleAt = Math.min(...dataList.map(d => d.scheduleAt))

      const batchThunk = async (): Promise<string[]> => {
        await putBatchRequestRecord({ originalRequestCount: dataList.length, providerConfig })
        const result = await executeTranslate(batchText, langConfig, providerConfig, { isBatch: true, content })
        return parseBatchResult(result)
      }

      return requestQueue.enqueue(batchThunk, earliestScheduleAt, hash)
    },
    executeIndividual: async (data) => {
      return enqueueLLMRequest(data)
    },
    onError: (error, context) => {
      const errorType = context.isFallback ? 'Individual request' : 'Batch request'
      logger.error(
        `${errorType} failed (batchKey: ${context.batchKey}, retry: ${context.retryCount}):`,
        error.message,
      )
    },
  })

  if (!hasRegisteredTabRemovalListener) {
    browser.tabs.onRemoved.addListener((tabId) => {
      const requestIds = tabToClientRequestIds.get(tabId)
      if (!requestIds?.size)
        return

      tabToClientRequestIds.delete(tabId)
      for (const requestId of requestIds) {
        batchQueue.cancelTasks(data => data.clientRequestId === requestId, 'Tab closed before translation finished')
      }
    })

    hasRegisteredTabRemovalListener = true
  }

  onMessage('enqueueTranslateRequest', async (message) => {
    const { data: { text, langConfig, providerConfig, scheduleAt, hash, articleTitle, articleTextContent, clientRequestId, chunkMetadata } } = message
    const tabId = message.sender.tab?.id

    registerClientRequest(clientRequestId, tabId)

    try {
      // Check cache first
      if (hash) {
        const cached = await db.translationCache.get(hash)
        if (cached) {
          return cached.translation
        }
      }

      let result = ''
      const content: ArticleContent = {
        title: articleTitle || '',
      }

      if (isLLMTranslateProviderConfig(providerConfig)) {
        const effectiveBatchLimit = resolveProviderBatchLimit(providerConfig, maxCharactersPerBatch)
        // Generate or fetch cached summary if AI Content Aware is enabled
        const config = await ensureInitializedConfig()
        if (config?.translate.enableAIContentAware && articleTitle !== undefined && articleTextContent !== undefined) {
          content.summary = await getOrGenerateSummary(articleTitle, articleTextContent, providerConfig)
        }

        const data = {
          text,
          langConfig,
          providerConfig,
          hash,
          scheduleAt,
          content,
          maxCharsPerRequest: effectiveBatchLimit,
          clientRequestId,
          tabId,
          chunkMetadata,
        }

        if (isGenAIProviderConfig(providerConfig))
          result = await enqueueGenAIRequest({ ...data, providerConfig })
        else
          result = await batchQueue.enqueue(data)
      }
      else {
        // Create thunk based on type and params
        const thunk = () => executeTranslate(text, langConfig, providerConfig, { chunkMetadata })
        result = await requestQueue.enqueue(thunk, scheduleAt, hash)
      }

      // Cache the translation result if successful
      if (result && hash) {
        await db.translationCache.put({
          key: hash,
          translation: result,
          createdAt: new Date(),
        })
      }

      return result
    }
    finally {
      releaseClientRequest(clientRequestId)
    }
  })

  onMessage('setTranslateRequestQueueConfig', (message) => {
    const { data } = message
    requestQueue.setQueueOptions(data)
  })

  onMessage('setTranslateBatchQueueConfig', (message) => {
    const { data } = message
    batchQueue.setBatchConfig(data)
  })
}
