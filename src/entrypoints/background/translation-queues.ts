import type { Config } from '@/types/config/config'
import type { GenAIProviderConfig, LLMTranslateProviderConfig, ProviderConfig, TranslateProviderTypes } from '@/types/config/provider'
import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'

import { browser } from '#imports'
import { isGenAIProviderConfig, isLLMTranslateProviderConfig } from '@/types/config/provider'
import { putBatchRequestRecord } from '@/utils/batch-request-record'
import { DEFAULT_CONFIG } from '@/utils/constants/config'
import { BATCH_SEPARATOR } from '@/utils/constants/prompt'
import { TRANSLATE_PROVIDER_CHARACTER_LIMITS } from '@/utils/constants/providers'
import { MIN_BATCH_CHARACTERS } from '@/utils/constants/translate'
import { generateArticleSummary } from '@/utils/content/summary'
import { cleanText } from '@/utils/content/utils'
import { db } from '@/utils/db/dexie/db'
import { warmGenAIChatPool } from '@/utils/genai/client'
import { GENAI_CHAT_MAX_SLOTS_PER_KEY } from '@/utils/genai/constants'
import { cancelActiveGenAIRequest } from '@/utils/genai/request-registry'
import { logGenAIReliabilityEvent, resolveGenAIModelName } from '@/utils/genai/telemetry'
import { Sha256Hex } from '@/utils/hash'
import { executeTranslate } from '@/utils/host/translate/execute-translate'
import { logger } from '@/utils/logger'
import { onMessage } from '@/utils/message'
import { createPerfTimer } from '@/utils/perf/perf-timer'
import { BatchQueue } from '@/utils/request/batch-queue'
import { RequestQueue } from '@/utils/request/request-queue'

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

interface GenAIBatchChunkData {
  text: string
  hash: string
  chunkMetadata?: TranslationChunkMetadata
}

interface TranslationCacheEntry { translation: string }

const RECOVERABLE_GENAI_RESPONSE_CODES = new Set(['R50004'])
const RECOVERABLE_GENAI_ERROR_PATTERNS = [
  /Unexpected token\s+200007/i,
  /Model Execution Error/i,
]
const GENAI_BATCH_MISMATCH_ERROR_PREFIX = 'GenAI batch result mismatch'

type RecoverableBatchErrorReason = 'response-code' | 'message-pattern' | 'result-mismatch' | 'unknown'

interface BatchErrorClassification {
  recoverable: boolean
  reason: RecoverableBatchErrorReason
  code: string | null
}

function extractGenAIResponseCode(message: string): string | null {
  const match = message.match(/R\d{5}/i)
  return match ? match[0].toUpperCase() : null
}

function classifyGenAIBatchError(error: unknown): BatchErrorClassification {
  if (!(error instanceof Error)) {
    return { recoverable: false, reason: 'unknown', code: null }
  }

  const responseCode = extractGenAIResponseCode(error.message)
  if (responseCode && RECOVERABLE_GENAI_RESPONSE_CODES.has(responseCode)) {
    return { recoverable: true, reason: 'response-code', code: responseCode }
  }

  if (RECOVERABLE_GENAI_ERROR_PATTERNS.some(pattern => pattern.test(error.message))) {
    return { recoverable: true, reason: 'message-pattern', code: responseCode }
  }

  if (error.message.startsWith(GENAI_BATCH_MISMATCH_ERROR_PREFIX)) {
    return { recoverable: true, reason: 'result-mismatch', code: null }
  }

  return { recoverable: false, reason: 'unknown', code: responseCode }
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
    const { text, langConfig, providerConfig, hash, scheduleAt, content, chunkMetadata, clientRequestId } = data
    const thunk = async () => {
      await putBatchRequestRecord({ originalRequestCount: 1, providerConfig })
      return executeTranslate(text, langConfig, providerConfig, { content, chunkMetadata, clientRequestId })
    }
    return requestQueue.enqueue(thunk, scheduleAt, hash)
  }

  const enqueueGenAIRequest = async (data: TranslateBatchData & { providerConfig: GenAIProviderConfig }) => {
    const backlogSize = incrementGenAIBacklog(data.providerConfig)
    requestGenAIWarmSlots(data.providerConfig, backlogSize)

    try {
      const { text, langConfig, providerConfig, hash, scheduleAt, content, chunkMetadata, clientRequestId } = data
      const runTask = async () => {
        await putBatchRequestRecord({ originalRequestCount: 1, providerConfig })
        return executeTranslate(text, langConfig, providerConfig, { content, chunkMetadata, clientRequestId })
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
    getMaxCharactersForTask: data => data.maxCharsPerRequest,
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
    browser.tabs.onRemoved.addListener((tabId: number) => {
      const requestIds = tabToClientRequestIds.get(tabId)
      if (!requestIds?.size)
        return

      tabToClientRequestIds.delete(tabId)
      for (const requestId of requestIds) {
        batchQueue.cancelTasks(data => data.clientRequestId === requestId, 'Tab closed before translation finished')
        void cancelActiveGenAIRequest(requestId, 'Tab closed before translation finished').catch(() => {})
      }
    })

    hasRegisteredTabRemovalListener = true
  }

  onMessage('enqueueTranslateRequest', async (message: any) => {
    const { data: { text, langConfig, providerConfig, scheduleAt, hash, articleTitle, articleTextContent, clientRequestId, chunkMetadata } } = message
    const tabId = message.sender.tab?.id
    const perf = createPerfTimer(`queue:${clientRequestId}`)
    perf.step('received', {
      chars: text.length,
      providerId: providerConfig.provider,
    })

    registerClientRequest(clientRequestId, tabId)

    try {
      // Check cache first
      if (hash) {
        const cached = await db.translationCache.get(hash)
        if (cached) {
          perf.step('cache-hit', { hash })
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
        const thunk = () => executeTranslate(text, langConfig, providerConfig, { chunkMetadata, clientRequestId })
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

      perf.step('completed', {
        hash,
        providerId: providerConfig.provider,
        cached: false,
      })
      return result
    }
    finally {
      releaseClientRequest(clientRequestId)
      perf.step('released')
    }
  })

  onMessage('enqueueGenAIBatch', async (message: any) => {
    const { data } = message
    const { langConfig, providerConfig, scheduleAt, clientRequestId, articleTitle, articleTextContent } = data
    const chunks: GenAIBatchChunkData[] = data.chunks
    const tabId = message.sender.tab?.id

    if (!isGenAIProviderConfig(providerConfig))
      throw new Error('enqueueGenAIBatch requires a GenAI provider config')

    registerClientRequest(clientRequestId, tabId)

    const telemetryModelName = resolveGenAIModelName(providerConfig, 'translate')

    try {
      if (!chunks.length)
        return []

      const chunkHashes = chunks.map(chunk => chunk.hash)
      const cachedEntries = await Promise.all(chunkHashes.map(hash => db.translationCache.get(hash))) as Array<TranslationCacheEntry | undefined>
      if (cachedEntries.every(entry => entry?.translation))
        return cachedEntries.map(entry => entry?.translation ?? '')

      const content: ArticleContent = {
        title: articleTitle || '',
      }

      const config = await ensureInitializedConfig()
      if (config?.translate.enableAIContentAware && articleTitle !== undefined && articleTextContent !== undefined)
        content.summary = await getOrGenerateSummary(articleTitle, articleTextContent, providerConfig)

      const chunkMetadataList = chunks.map(chunk => chunk.chunkMetadata)
      const batchText = chunks.map(chunk => chunk.text).join(`\n\n${BATCH_SEPARATOR}\n\n`)
      const aggregateHash = Sha256Hex(...chunkHashes)
      const effectiveBatchLimit = resolveProviderBatchLimit(providerConfig, maxCharactersPerBatch)

      const runTask = async (): Promise<string[]> => {
        await putBatchRequestRecord({ originalRequestCount: chunks.length, providerConfig })
        const rawResult = await executeTranslate(batchText, langConfig, providerConfig, {
          isBatch: true,
          content,
          chunkMetadataList,
          clientRequestId,
        })
        return parseBatchResult(rawResult)
      }

      const translateChunksIndividually = async (fallbackReason: string): Promise<string[]> => {
        logger.warn('[GenAI Batch] Falling back to individual chunk translations', {
          providerId: providerConfig.id,
          chunkCount: chunks.length,
          fallbackReason,
        })

        const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())
        const startedAt = now()
        let success = false

        try {
          const individualResults: string[] = []
          for (let index = 0; index < chunks.length; index++) {
            const cachedEntry = cachedEntries[index]
            if (cachedEntry?.translation) {
              individualResults.push(cachedEntry.translation)
              continue
            }

            const chunk = chunks[index]
            const translation = await enqueueGenAIRequest({
              text: chunk.text,
              langConfig,
              providerConfig,
              hash: chunk.hash,
              scheduleAt,
              content,
              maxCharsPerRequest: effectiveBatchLimit,
              clientRequestId,
              tabId,
              chunkMetadata: chunk.chunkMetadata,
            })
            individualResults.push(translation)
          }

          success = true
          return individualResults
        }
        finally {
          const durationMs = Math.max(0, now() - startedAt)
          void logGenAIReliabilityEvent({
            type: 'batch-fallback',
            providerId: providerConfig.id,
            modelType: 'translate',
            model: telemetryModelName,
            reason: fallbackReason,
            durationMs,
            metadata: {
              chunkCount: chunks.length,
              success,
            },
          })
        }
      }

      const attemptBatch = async (): Promise<string[]> => {
        const translations = await requestQueue.enqueue(runTask, scheduleAt, aggregateHash)
        if (translations.length !== chunks.length)
          throw new Error(`${GENAI_BATCH_MISMATCH_ERROR_PREFIX}: expected ${chunks.length}, got ${translations.length}`)
        return translations
      }

      const executeBatchWithFallback = async (): Promise<string[]> => {
        const MAX_BATCH_ATTEMPTS = 2
        for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS; attempt++) {
          try {
            return await attemptBatch()
          }
          catch (error) {
            const classification = classifyGenAIBatchError(error)
            if (!classification.recoverable)
              throw error

            if (attempt < MAX_BATCH_ATTEMPTS - 1) {
              logger.warn('[GenAI Batch] Recoverable error during batch attempt, retrying once', {
                providerId: providerConfig.id,
                attempt: attempt + 1,
                reason: classification.reason,
                responseCode: classification.code,
              })
              void logGenAIReliabilityEvent({
                type: 'batch-retry',
                providerId: providerConfig.id,
                modelType: 'translate',
                model: telemetryModelName,
                reason: classification.reason,
                responseCode: classification.code,
                retryCount: attempt + 1,
                metadata: {
                  chunkCount: chunks.length,
                  action: 'retry',
                },
              })
              continue
            }

            void logGenAIReliabilityEvent({
              type: 'batch-retry',
              providerId: providerConfig.id,
              modelType: 'translate',
              model: telemetryModelName,
              reason: classification.reason,
              responseCode: classification.code,
              retryCount: attempt + 1,
              metadata: {
                chunkCount: chunks.length,
                action: 'fallback',
              },
            })
            return await translateChunksIndividually(classification.reason)
          }
        }
        throw new Error('GenAI batch attempts exhausted')
      }

      const backlogSize = incrementGenAIBacklog(providerConfig)
      requestGenAIWarmSlots(providerConfig, backlogSize)

      try {
        const translations = await executeBatchWithFallback()

        await Promise.all(translations.map(async (translation, index) => {
          const hash = chunkHashes[index]
          if (!hash)
            return
          await db.translationCache.put({
            key: hash,
            translation,
            createdAt: new Date(),
          })
        }))

        return translations
      }
      finally {
        decrementGenAIBacklog(providerConfig)
      }
    }
    finally {
      releaseClientRequest(clientRequestId)
    }
  })

  onMessage('setTranslateRequestQueueConfig', (message: any) => {
    const { data } = message
    requestQueue.setQueueOptions(data)
  })

  onMessage('setTranslateBatchQueueConfig', (message: any) => {
    const { data } = message
    batchQueue.setBatchConfig(data)
  })
}

export const __private__ = {
  classifyGenAIBatchError,
}
