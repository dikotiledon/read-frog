import type { Config } from '@/types/config/config'
import type { GenAIProviderConfig } from '@/types/config/provider'
import type { BatchQueueConfig } from '@/types/config/translate'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { Sha256Hex } from '@/utils/hash'
import { logger } from '@/utils/logger'
import { sendMessage } from '@/utils/message'

interface PendingChunk {
  id: string
  text: string
  hash: string
  chunkMetadata?: TranslationChunkMetadata
  scheduleAt: number
  resolve: (value: string) => void
  reject: (error: Error) => void
  cleanup?: () => void
  cancelled?: boolean
  phase: 'pending' | 'in-flight' | 'settled'
  cleanedUp?: boolean
}

interface EnqueueOptions {
  text: string
  hash: string
  langConfig: Config['language']
  providerConfig: GenAIProviderConfig
  batchQueueConfig: BatchQueueConfig
  scheduleAt: number
  articleTitle?: string
  articleTextContent?: string
  chunkMetadata?: TranslationChunkMetadata
  signal?: AbortSignal
}

interface ControllerContext {
  langConfig: Config['language']
  providerConfig: GenAIProviderConfig
  articleTitle?: string
  articleTextContent?: string
}

const DEFAULT_FLUSH_DELAY_MS = 60
const DEFAULT_CANCEL_REASON = 'Translation aborted'
type FlushReason = 'timer' | 'budget' | 'context-change' | 'manual'

class GenAIBatchController {
  private pendingChunks: PendingChunk[] = []
  private pendingCharacters = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private contextKey: string | null = null
  private context: ControllerContext | null = null
  private maxCharactersPerBatch = 0
  private maxItemsPerBatch = 0
  private flushPromise: Promise<void> | null = null
  private chunkMap = new Map<string, PendingChunk>()
  private cancelledBeforeFlush = 0
  private cancelledInFlight = 0

  async enqueue(options: EnqueueOptions): Promise<string> {
    await this.prepareContext(options)

    return await new Promise<string>((resolve, reject) => {
      const chunk: PendingChunk = {
        id: crypto.randomUUID(),
        text: options.text,
        hash: options.hash,
        chunkMetadata: options.chunkMetadata,
        scheduleAt: options.scheduleAt,
        resolve,
        reject,
        phase: 'pending',
      }

      if (options.signal?.aborted) {
        reject(new DOMException(DEFAULT_CANCEL_REASON, 'AbortError'))
        return
      }

      this.attachAbortSignal(chunk, options.signal)

      this.chunkMap.set(chunk.id, chunk)

      this.pendingChunks.push(chunk)
      this.pendingCharacters += options.text.length

      if (this.shouldFlushImmediately()) {
        void this.flushPending('budget')
      }
      else if (!this.flushTimer) {
        this.flushTimer = globalThis.setTimeout(() => {
          this.flushTimer = null
          void this.flushPending('timer')
        }, DEFAULT_FLUSH_DELAY_MS)
      }
    })
  }

  private async prepareContext(options: EnqueueOptions): Promise<void> {
    const nextKey = this.computeContextKey(options.langConfig, options.providerConfig)
    const requiresFlush = this.contextKey && this.contextKey !== nextKey
    if (requiresFlush)
      await this.flushPending('context-change')

    const previousContext = requiresFlush ? null : this.context

    this.contextKey = nextKey
    this.context = {
      langConfig: options.langConfig,
      providerConfig: options.providerConfig,
      articleTitle: options.articleTitle ?? previousContext?.articleTitle,
      articleTextContent: options.articleTextContent ?? previousContext?.articleTextContent,
    }

    const { maxCharactersPerBatch, maxItemsPerBatch } = options.batchQueueConfig
    this.maxCharactersPerBatch = Math.max(maxCharactersPerBatch, 1)
    this.maxItemsPerBatch = Math.max(maxItemsPerBatch, 1)
  }

  private shouldFlushImmediately(): boolean {
    return (
      this.pendingChunks.length >= this.maxItemsPerBatch
      || this.pendingCharacters >= this.maxCharactersPerBatch
    )
  }

  private async flushPending(reason: FlushReason = 'manual'): Promise<void> {
    if (!this.pendingChunks.length) {
      return this.flushPromise ?? Promise.resolve()
    }

    if (this.flushPromise)
      return this.flushPromise

    const chunks = this.pendingChunks.splice(0)
    this.pendingCharacters = 0
    if (this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    chunks.forEach((chunk) => {
      chunk.phase = 'in-flight'
    })

    const context = this.context
    if (!context)
      throw new Error('GenAI batch context missing during flush')

    const payload = {
      chunks: chunks.map(chunk => ({
        text: chunk.text,
        hash: chunk.hash,
        chunkMetadata: chunk.chunkMetadata,
      })),
      langConfig: context.langConfig,
      providerConfig: context.providerConfig,
      scheduleAt: Math.min(...chunks.map(chunk => chunk.scheduleAt)),
      clientRequestId: crypto.randomUUID(),
      articleTitle: context.articleTitle,
      articleTextContent: context.articleTextContent,
    }

    const chunkCount = chunks.length
    const characterCount = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    const pendingCancelBeforeFlush = this.cancelledBeforeFlush
    this.cancelledBeforeFlush = 0

    const flushPromise = sendMessage('enqueueGenAIBatch', payload)
      .then((translations: string[]) => {
        if (!Array.isArray(translations) || translations.length !== chunks.length)
          throw new Error('GenAI batch response size mismatch')

        translations.forEach((translation, index) => {
          chunks[index].resolve(translation)
        })
      })
      .catch((error: Error) => {
        chunks.forEach(chunk => chunk.reject(error))
      })
      .finally(() => {
        logger.info('[GenAI Batch] Flush completed', {
          reason,
          chunkCount,
          characterCount,
          cancelledBeforeFlush: pendingCancelBeforeFlush,
          cancelledInFlight: this.cancelledInFlight,
        })
        this.cancelledInFlight = 0
        this.flushPromise = null
        if (this.pendingChunks.length && !this.flushTimer) {
          this.flushTimer = globalThis.setTimeout(() => {
            this.flushTimer = null
            void this.flushPending('timer')
          }, DEFAULT_FLUSH_DELAY_MS)
        }
      })

    this.flushPromise = flushPromise
    return flushPromise
  }

  public cancelChunk(chunkId: string, reason?: Error): boolean {
    const chunk = this.chunkMap.get(chunkId)
    if (!chunk)
      return false

    const error = reason ?? new DOMException(DEFAULT_CANCEL_REASON, 'AbortError')

    if (chunk.phase === 'pending') {
      const removed = this.removePendingChunk(chunk)
      if (removed)
        this.cancelledBeforeFlush += 1
      this.cancelChunkInternal(chunk, error)
      return true
    }

    if (chunk.phase === 'in-flight') {
      this.cancelledInFlight += 1
      this.cancelChunkInternal(chunk, error)
      return true
    }

    return false
  }

  private removePendingChunk(chunk: PendingChunk): boolean {
    const originalLength = this.pendingChunks.length
    if (!originalLength)
      return false

    const filtered: PendingChunk[] = []
    let removed = false
    for (const entry of this.pendingChunks) {
      if (entry === chunk) {
        removed = true
        continue
      }
      filtered.push(entry)
    }

    if (!removed)
      return false

    this.pendingChunks = filtered
    this.pendingCharacters = Math.max(0, this.pendingCharacters - chunk.text.length)

    if (!this.pendingChunks.length && this.flushTimer) {
      globalThis.clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    return true
  }

  private cancelChunkInternal(chunk: PendingChunk, error: Error): void {
    if (chunk.cancelled)
      return
    chunk.cancelled = true
    this.cleanupChunk(chunk)
    chunk.reject(error)
  }

  private cleanupChunk(chunk: PendingChunk): void {
    if (chunk.cleanedUp)
      return
    chunk.cleanedUp = true
    chunk.cleanup?.()
    this.chunkMap.delete(chunk.id)
  }

  private attachAbortSignal(chunk: PendingChunk, signal?: AbortSignal): void {
    if (!signal)
      return

    const onAbort = () => {
      this.cancelChunk(chunk.id)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    chunk.cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private computeContextKey(langConfig: Config['language'], providerConfig: GenAIProviderConfig): string {
    return Sha256Hex(JSON.stringify(langConfig), JSON.stringify(providerConfig))
  }
}

let controller: GenAIBatchController | null = null

export function getGenAIBatchController(): GenAIBatchController {
  if (!controller)
    controller = new GenAIBatchController()
  return controller
}
