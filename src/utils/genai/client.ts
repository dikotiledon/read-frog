import type { EventSourceMessage } from 'eventsource-parser'
import type { GenAIProviderConfig } from '@/types/config/provider'
import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { createParser } from 'eventsource-parser'
import { logger } from '@/utils/logger'
import { getTranslatePrompt } from '@/utils/prompts/translate'
import { GENAI_ENDPOINTS, GENAI_MESSAGE_POLL_INTERVAL_MS, GENAI_MESSAGE_POLL_MAX_BACKOFF_MULTIPLIER, GENAI_MESSAGE_POLL_TIMEOUT_MS, GENAI_STREAM_COMPLETE_EVENTS } from './constants'
import type { GenAIChatLease, GenAIChatPurpose } from './chat-pool'
import { acquireGenAIChat, scaleGenAIChatPool } from './chat-pool'
import { registerActiveGenAIRequest } from './request-registry'
import { resolveGenAIModelGuid } from './models'
import { ensureGenAISession } from './session'

const GENAI_CHAT_MAX_RECOVERY_ATTEMPTS = 3

function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined')
    return new DOMException(message, 'AbortError')
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): error is DOMException | Error {
  if (!error)
    return false
  if (error instanceof DOMException)
    return error.name === 'AbortError'
  if (error instanceof Error)
    return error.name === 'AbortError'
  return false
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw (signal.reason instanceof Error ? signal.reason : createAbortError('GenAI request aborted'))
}

class GenAIHttpError extends Error {
  status: number
  statusText: string
  body: unknown

  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(message)
    this.name = 'GenAIHttpError'
    this.status = status
    this.statusText = statusText
    this.body = body
  }
}

class GenAIPendingResponseError extends Error {
  code: string | null | undefined

  constructor(code?: string | null) {
    super('[GenAI] Previous response is still processing')
    this.name = 'GenAIPendingResponseError'
    this.code = code
  }
}

type ModelType = 'read' | 'translate'

function joinURL(baseURL: string, path: string) {
  return `${baseURL.replace(/\/$/, '')}${path}`
}

function getModelName(providerConfig: GenAIProviderConfig, type: ModelType): string | null | undefined {
  const modelConfig = providerConfig.models[type]
  if (!modelConfig)
    return null
  return modelConfig.isCustomModel ? modelConfig.customModel : modelConfig.model
}

function normalizeAssistantResponse(text: string): string {
  const [, content = text] = text.match(/<\/think>([\s\S]*)/) || []
  return content.trim()
}

function normalizeResponseCode(code?: string | null) {
  return typeof code === 'string' ? code.trim().toUpperCase() : null
}

function extractGuidFromChunk(chunk: string): string | null {
  const pairMatch = chunk.match(/"guid"\s*:\s*"[^"]+"/i)
  if (!pairMatch)
    return null

  const valueMatch = pairMatch[0].match(/"[^"]+"$/)
  if (!valueMatch)
    return null

  return valueMatch[0].slice(1, -1)
}

function chunkLooksComplete(chunk: string): boolean {
  return /\b(?:FINAL_ANSWER|SUCCESS|R20000|DONE|COMPLETED|COMPLETE)\b/i.test(chunk)
}

async function genaiFetch(baseURL: string, path: string, init: RequestInit = {}) {
  const url = joinURL(baseURL, path)
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    let errorBody: unknown
    try {
      errorBody = await response.clone().json()
    }
    catch {
      errorBody = await response.text()
    }
    const errorMessage = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)
    throw new GenAIHttpError(response.status, response.statusText, errorBody, `[GenAI] ${response.status} ${response.statusText}: ${errorMessage}`)
  }

  return response
}

async function genaiFetchJson<T>(baseURL: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await genaiFetch(baseURL, path, init)
  return await response.json() as T
}

async function createChat(baseURL: string) {
  const payload = {
    title: 'Translate',
    type: 'chat',
    clientType: 'portal',
    fileUuids: [] as string[],
  }

  const data = await genaiFetchJson<{ guid: string }>(baseURL, GENAI_ENDPOINTS.chats, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return data.guid
}

async function deleteChats(baseURL: string, chatGuids: string[]) {
  if (chatGuids.length === 0)
    return

  await genaiFetch(baseURL, GENAI_ENDPOINTS.chats, {
    method: 'DELETE',
    body: JSON.stringify({ chatGuids }),
  })
}

async function sendUserMessage(
  baseURL: string,
  chatGuid: string,
  content: string,
  parentMessageGuid?: string | null,
  options?: { signal?: AbortSignal },
) {
  const payload = {
    chatGuid,
    messageType: 'chat',
    content,
    attributes: {
      plugins: [],
      mcpServers: [],
      knowledge: [],
      embeddingKnowledge: [],
      codeInterpreters: false,
    },
    fileUuids: [] as string[],
    ...(parentMessageGuid ? { parentMessageGuid } : {}),
  }

  try {
    const data = await genaiFetchJson<{ guid: string }>(baseURL, GENAI_ENDPOINTS.messages, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: options?.signal,
    })

    return data.guid
  }
  catch (error) {
    if (error instanceof GenAIHttpError && error.status === 422) {
      const body = error.body as { errorCode?: string | null } | undefined
      const errorCode = typeof body?.errorCode === 'string' ? body.errorCode : null

      if (errorCode === 'CHAT_ERROR_4')
        throw new GenAIPendingResponseError(errorCode)
    }
    throw error
  }
}

async function invalidateChatWithRemoteDelete(baseURL: string, chatLease: GenAIChatLease, reason: string) {
  try {
    await deleteChats(baseURL, [chatLease.chatGuid])
    logger.info('[GenAI] Deleted chat conversation before retry', {
      chatGuid: chatLease.chatGuid,
      reason,
    })
  }
  catch (error) {
    logger.warn('[GenAI] Failed to delete chat conversation', {
      chatGuid: chatLease.chatGuid,
      reason,
      error,
    })
  }
  finally {
    await chatLease.invalidate()
  }
}

async function settlePendingMessageIfNeeded(baseURL: string, chatLease: GenAIChatLease, signal?: AbortSignal): Promise<boolean> {
  if (!chatLease.pendingMessageGuid)
    return true

  try {
    await waitForMessageCompletion(baseURL, chatLease.pendingMessageGuid, { signal })
    chatLease.setPendingMessageGuid(null)
    return true
  }
  catch (error) {
    if (isAbortError(error))
      throw error
    logger.warn('[GenAI] Pending user message did not complete', {
      chatGuid: chatLease.chatGuid,
      pendingMessageGuid: chatLease.pendingMessageGuid,
      error,
    })
    return false
  }
}

const COMPLETE_STATUS_SET = new Set<string>([...GENAI_STREAM_COMPLETE_EVENTS, 'R20000', 'DONE', 'COMPLETED', 'COMPLETE'])
const FAILURE_STATUS_SET = new Set(['FAIL', 'FAILED', 'ERROR'])
const MISSING_RESPONSE_HTTP_STATUS = new Set([404, 410])
const INVALIDATE_CHAT_HTTP_STATUS = new Set([401, 403, 404, 410])

function isSuccessfulResponseCode(code: string | null): boolean {
  if (!code)
    return false
  return /^R2\d{4}$/i.test(code)
}

function isFailedResponseCode(code: string | null): boolean {
  if (!code)
    return false
  return /^R5\d{4}$/i.test(code)
}

interface GenAIStreamEvent {
  guid?: string | null
  id?: string | null
  message_guid?: string | null
  messageGuid?: string | null
  response_guid?: string | null
  responseGuid?: string | null
  event_status?: string | null
  eventStatus?: string | null
  status?: string | null
  response_code?: string | null
  responseCode?: string | null
  content?: string | null
  truncated?: boolean | null
  processing_content?: Array<{ event_status?: string | null, eventStatus?: string | null }>
  processingContent?: Array<{ event_status?: string | null, eventStatus?: string | null }>
}

function getGuidFromPayload(payload: GenAIStreamEvent): string | null {
  const candidates = [
    payload.guid,
    payload.response_guid,
    payload.responseGuid,
    payload.message_guid,
    payload.messageGuid,
    payload.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0)
      return candidate
  }
  return null
}

function appendStatusCandidate(candidates: string[], value?: string | null) {
  if (typeof value === 'string' && value.trim().length > 0)
    candidates.push(value.trim().toUpperCase())
}

function extractVisibleContent(payload: GenAIStreamEvent): string | null {
  const status = normalizeStatus(payload.event_status) ?? normalizeStatus(payload.eventStatus)
  const responseCode = payload.response_code ?? payload.responseCode
  const content = typeof payload.content === 'string' ? payload.content : null

  if (!content || content.length === 0)
    return null

  if (responseCode !== null && typeof responseCode !== 'undefined')
    return null

  const normalizedStatus = status ?? 'CHUNK'
  if (normalizedStatus === 'CHUNK' || normalizedStatus === 'STREAM')
    return content

  return null
}

function isCompletionEvent(event: GenAIStreamEvent): boolean {
  const statusCandidates: string[] = []

  appendStatusCandidate(statusCandidates, event.event_status)
  appendStatusCandidate(statusCandidates, event.eventStatus)
  appendStatusCandidate(statusCandidates, event.status)
  appendStatusCandidate(statusCandidates, event.response_code)
  appendStatusCandidate(statusCandidates, event.responseCode)

  const collections = [event.processing_content, event.processingContent]
  for (const collection of collections) {
    if (!Array.isArray(collection))
      continue
    for (const item of collection) {
      appendStatusCandidate(statusCandidates, item.event_status)
      appendStatusCandidate(statusCandidates, item.eventStatus)
    }
  }

  return statusCandidates.some(status => COMPLETE_STATUS_SET.has(status))
}

type GuidParseState = {
  latestGuid: string | null
  completedGuid: string | null
}

type WaitForContentOptions = {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  fallbackContent?: string | null
  onInvalidateChat?: () => void | Promise<void>
  signal?: AbortSignal
}

type MessageContentResult = {
  content: string
  completed: boolean
}

type GenAIMessageResponse = {
  content?: string | null
  status?: string | null
  responseCode?: string | null
}

type ReadEventResult = {
  responseGuid: string
  fallbackContent: string | null
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
  sleepFn: (ms: number) => Promise<void> = sleep,
) {
  if (!signal)
    return await sleepFn(ms)

  throwIfAborted(signal)

  let abortHandler: (() => void) | null = null

  try {
    await Promise.race([
      sleepFn(ms),
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError('GenAI request aborted'))
        }
        abortHandler = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  }
  finally {
    if (abortHandler)
      signal.removeEventListener('abort', abortHandler)
  }
}

function parseGuidsFromRawSSE(rawText: string): GuidParseState {
  const state: GuidParseState = { latestGuid: null, completedGuid: null }
  let buffer = ''
  let hasLoggedRawFallbackError = false

  const flushBuffer = () => {
    const data = buffer.trim()
    buffer = ''
    if (!data || data === '[DONE]')
      return

    try {
      const payload = JSON.parse(data) as GenAIStreamEvent
      const payloadGuid = getGuidFromPayload(payload)
      if (payloadGuid)
        state.latestGuid = payloadGuid

      if (!state.completedGuid && isCompletionEvent(payload))
        state.completedGuid = payloadGuid ?? state.latestGuid ?? null
    }
    catch (error) {
      if (!hasLoggedRawFallbackError) {
        logger.warn('[GenAI] Failed to parse raw SSE chunk, using fallback heuristics', error)
        hasLoggedRawFallbackError = true
      }

      const fallbackGuid = extractGuidFromChunk(data)
      if (fallbackGuid)
        state.latestGuid = fallbackGuid

      if (!state.completedGuid && chunkLooksComplete(data))
        state.completedGuid = fallbackGuid ?? state.latestGuid ?? null
    }
  }

  for (const line of rawText.split(/\r?\n/)) {
    const dataMatch = line.match(/^data:\s?(.*)$/)
    if (dataMatch) {
      const value = dataMatch[1]
      buffer += buffer ? `\n${value}` : value
      continue
    }

    if (line.trim() === '')
      flushBuffer()
  }

  flushBuffer()
  return state
}

async function readEventStream(response: Response, options?: { signal?: AbortSignal }): Promise<ReadEventResult> {
  const reader = response.body?.getReader()
  if (!reader)
    throw new Error('[GenAI] Missing response stream')

  const signal = options?.signal
  throwIfAborted(signal)

  const decoder = new TextDecoder()
  let latestGuid: string | null = null
  let completedGuid: string | null = null
  let rawStreamText = ''
  const collectedContent: string[] = []

  let hasLoggedChunkFallbackError = false

  let abortError: Error | null = null
  const abortListener = signal
    ? () => {
        abortError = signal.reason instanceof Error ? signal.reason : createAbortError('GenAI request aborted')
        void reader.cancel().catch(() => {})
      }
    : null

  if (signal && abortListener)
    signal.addEventListener('abort', abortListener, { once: true })

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      const data = event.data.trim()
      if (!data || data === '[DONE]')
        return

      try {
        const payload = JSON.parse(data) as GenAIStreamEvent

        const payloadGuid = getGuidFromPayload(payload)
        const candidateGuid = payloadGuid ?? extractGuidFromChunk(data)
        if (candidateGuid)
          latestGuid = candidateGuid

        if (!completedGuid && isCompletionEvent(payload))
          completedGuid = candidateGuid ?? latestGuid ?? null

        const visibleContent = extractVisibleContent(payload)
        if (visibleContent)
          collectedContent.push(visibleContent)
      }
      catch (error) {
        if (!hasLoggedChunkFallbackError) {
          logger.warn('[GenAI] Failed to parse SSE chunk, using fallback heuristics', error)
          hasLoggedChunkFallbackError = true
        }

        const fallbackGuid = extractGuidFromChunk(data)
        if (fallbackGuid)
          latestGuid = fallbackGuid

        if (!completedGuid && chunkLooksComplete(data))
          completedGuid = fallbackGuid ?? latestGuid ?? null
      }
    },
    onError(error) {
      logger.warn('[GenAI] SSE parser error', error)
    },
  })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (abortError)
        throw abortError
      if (done)
        break

      const text = decoder.decode(value, { stream: true })
      rawStreamText += text
      parser.feed(text)

      if (completedGuid)
        return {
          responseGuid: completedGuid,
          fallbackContent: collectedContent.join('') || null,
        }
    }

    const remaining = decoder.decode()
    if (remaining) {
      rawStreamText += remaining
      parser.feed(remaining)
    }

    parser.feed('\n\n')
    parser.reset({ consume: true })

    if (!completedGuid || !latestGuid) {
      const fallbackState = parseGuidsFromRawSSE(rawStreamText)
      if (!completedGuid && fallbackState.completedGuid)
        completedGuid = fallbackState.completedGuid
      if (!latestGuid && fallbackState.latestGuid)
        latestGuid = fallbackState.latestGuid
    }

    const fallbackContent = collectedContent.join('') || null

    if (completedGuid)
      return { responseGuid: completedGuid, fallbackContent }
    if (latestGuid)
      return { responseGuid: latestGuid, fallbackContent }

    throw new Error('[GenAI] Stream ended without response guid')
  }
  finally {
    if (signal && abortListener)
      signal.removeEventListener('abort', abortListener)
  }
}

function forwardAbortSignal(source: AbortSignal | null | undefined, targetController: AbortController): () => void {
  if (!source)
    return () => {}

  const listener = () => {
    if (targetController.signal.aborted)
      return
    const abortReason = (source as AbortSignal & { reason?: unknown }).reason
    targetController.abort(abortReason ?? createAbortError('GenAI request aborted by linked signal'))
  }

  source.addEventListener('abort', listener)
  return () => source.removeEventListener('abort', listener)
}

function createMessageResponseCanceler(baseURL: string, messageGuid: string) {
  let invoked = false
  return async (reason?: string) => {
    if (invoked)
      return
    invoked = true

    try {
      await genaiFetch(baseURL, GENAI_ENDPOINTS.messagesResponseCancel, {
        method: 'POST',
        body: JSON.stringify({ messageGuid }),
      })
      logger.info('[GenAI] Cancelled messages-response stream', {
        messageGuid,
        reason,
      })
    }
    catch (error) {
      logger.warn('[GenAI] Failed to cancel messages-response stream', {
        messageGuid,
        reason,
        error,
      })
    }
  }
}

async function waitForAssistantMessage(
  baseURL: string,
  chatGuid: string,
  messageGuid: string,
  modelGuid: string,
  options?: { signal?: AbortSignal },
): Promise<ReadEventResult> {
  const payload = {
    chatGuid,
    messageGuid,
    locale: 'en',
    modelGuids: [modelGuid],
    isArtifact: false,
  }

  const response = await genaiFetch(baseURL, GENAI_ENDPOINTS.messagesResponse, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: options?.signal,
  })

  return await readEventStream(response, { signal: options?.signal })
}

function normalizeStatus(status?: string | null) {
  return typeof status === 'string' ? status.trim().toUpperCase() : null
}

function isMissingResponseStatus(status: number | null | undefined): boolean {
  return typeof status === 'number' && MISSING_RESPONSE_HTTP_STATUS.has(status)
}

function shouldInvalidateChatFromHttpError(error: unknown): error is GenAIHttpError {
  return error instanceof GenAIHttpError && INVALIDATE_CHAT_HTTP_STATUS.has(error.status)
}

async function waitForMessageContent(
  baseURL: string,
  responseGuid: string,
  options?: WaitForContentOptions,
): Promise<MessageContentResult> {
  const pollIntervalMs = options?.pollIntervalMs ?? GENAI_MESSAGE_POLL_INTERVAL_MS
  const timeoutMs = options?.timeoutMs ?? GENAI_MESSAGE_POLL_TIMEOUT_MS
  const sleepFn = options?.sleep ?? sleep
  const signal = options?.signal
  const fallbackContent = options?.fallbackContent ?? null
  const hasFallback = typeof fallbackContent === 'string' && fallbackContent.trim().length > 0
  const deadline = Date.now() + timeoutMs
  const normalizedPollInterval = Math.max(pollIntervalMs, 0)
  let attempts = 0
  let lastStatus: string | null = null
  let latestContent: string | null = hasFallback ? fallbackContent : null

  while (true) {
    throwIfAborted(signal)
    attempts += 1
    let data: GenAIMessageResponse
    try {
      data = await genaiFetchJson<GenAIMessageResponse>(baseURL, GENAI_ENDPOINTS.message(responseGuid), {
        method: 'GET',
        signal,
      })
    }
    catch (error) {
      if (error instanceof GenAIHttpError && isMissingResponseStatus(error.status)) {
        const logContext = {
          responseGuid,
          attempts,
          status: error.status,
          statusText: error.statusText,
        }

        await options?.onInvalidateChat?.()

        if (hasFallback) {
          logger.warn('[GenAI] Response message missing, using SSE fallback content', logContext)
          return {
            content: fallbackContent as string,
            completed: false,
          }
        }

        logger.warn('[GenAI] Response message missing, aborting polling', logContext)
        throw new Error(`[GenAI] Response ${responseGuid} is no longer available (HTTP ${error.status})`)
      }

      throw error
    }

    const content = typeof data.content === 'string' ? data.content : ''
    const trimmedContent = content.trim()
    const status: string | null = normalizeStatus(data.status) ?? lastStatus
    const responseCode = normalizeResponseCode(data.responseCode)

    if (trimmedContent.length > 0)
      latestContent = content

    if (status && FAILURE_STATUS_SET.has(status))
      throw new Error(`[GenAI] Response failed with status ${status}`)

    if (isFailedResponseCode(responseCode))
      throw new Error(`[GenAI] Response failed with response code ${responseCode}`)

    const isComplete = (status && COMPLETE_STATUS_SET.has(status)) || isSuccessfulResponseCode(responseCode)
    if (isComplete) {
      if (latestContent !== null)
        return {
          content: latestContent,
          completed: true,
        }

      if (hasFallback) {
        logger.warn('[GenAI] Using SSE fallback content due to empty response payload', {
          responseGuid,
          attempts,
          status,
          responseCode,
        })
        return {
          content: fallbackContent as string,
          completed: true,
        }
      }

      logger.warn('[GenAI] Response reported completion but payload is empty, returning empty string', {
        responseGuid,
        attempts,
        status,
        responseCode,
      })
      return {
        content: '',
        completed: true,
      }
    }

    if (Date.now() >= deadline) {
      if (hasFallback) {
        logger.warn('[GenAI] Timed out waiting for response content, using SSE fallback', {
          responseGuid,
          attempts,
          lastStatus: status,
        })
        return {
          content: fallbackContent as string,
          completed: false,
        }
      }

      logger.warn('[GenAI] Timed out waiting for response content', {
        responseGuid,
        attempts,
        lastStatus: status,
      })
      throw new Error('[GenAI] Timed out waiting for response content')
    }

    lastStatus = status ?? lastStatus
    const backoffStep = Math.min(Math.max(attempts, 1), GENAI_MESSAGE_POLL_MAX_BACKOFF_MULTIPLIER)
    const delayMs = normalizedPollInterval * backoffStep
    await sleepWithSignal(delayMs, signal, sleepFn)
  }
}

type WaitForMessageCompletionOptions = {
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

async function waitForMessageCompletion(
  baseURL: string,
  messageGuid: string,
  options?: WaitForMessageCompletionOptions,
): Promise<{ status: string | null, responseCode: string | null }> {
  const pollIntervalMs = options?.pollIntervalMs ?? GENAI_MESSAGE_POLL_INTERVAL_MS
  const timeoutMs = options?.timeoutMs ?? GENAI_MESSAGE_POLL_TIMEOUT_MS
  const sleepFn = options?.sleep ?? sleep
  const signal = options?.signal
  const deadline = Date.now() + timeoutMs
  const normalizedPollInterval = Math.max(pollIntervalMs, 0)
  let attempts = 0

  while (true) {
    throwIfAborted(signal)
    attempts += 1
    let data: GenAIMessageResponse
    try {
      data = await genaiFetchJson<GenAIMessageResponse>(baseURL, GENAI_ENDPOINTS.message(messageGuid), {
        method: 'GET',
        signal,
      })
    }
    catch (error) {
      if (error instanceof GenAIHttpError && isMissingResponseStatus(error.status))
        return { status: null, responseCode: null }
      throw error
    }

    const status = normalizeStatus(data.status)
    const responseCode = normalizeResponseCode(data.responseCode)

    if (status && FAILURE_STATUS_SET.has(status))
      throw new Error(`[GenAI] Message ${messageGuid} failed with status ${status}`)

    if (isFailedResponseCode(responseCode))
      throw new Error(`[GenAI] Message ${messageGuid} failed with response code ${responseCode}`)

    const isComplete = (status && COMPLETE_STATUS_SET.has(status)) || isSuccessfulResponseCode(responseCode)
    if (isComplete)
      return { status, responseCode }

    if (Date.now() >= deadline)
      throw new Error(`[GenAI] Timed out waiting for message ${messageGuid} to complete`)

    const backoffStep = Math.min(Math.max(attempts, 1), GENAI_MESSAGE_POLL_MAX_BACKOFF_MULTIPLIER)
    await sleepWithSignal(normalizedPollInterval * backoffStep, signal, sleepFn)
  }
}

type GenAIExecutionOptions = {
  isBatch?: boolean
  content?: ArticleContent
  chunkMetadata?: TranslationChunkMetadata
  chunkMetadataList?: Array<TranslationChunkMetadata | undefined>
  clientRequestId?: string
}

export async function genaiTranslate(
  text: string,
  targetLangName: string,
  providerConfig: GenAIProviderConfig,
  options?: GenAIExecutionOptions,
): Promise<string> {
  const baseURL = await ensureGenAISession(providerConfig)

  const { systemPrompt, prompt } = await getTranslatePrompt(targetLangName, text, options)
  const combinedContent = [systemPrompt, prompt].filter(Boolean).join('\n\n')
  if (!combinedContent.trim())
    return ''

  const abortController = new AbortController()
  const unregister = options?.clientRequestId
    ? registerActiveGenAIRequest(options.clientRequestId, (reason?: unknown) => {
        if (abortController.signal.aborted)
          return
        const abortReason = reason instanceof Error ? reason : createAbortError(typeof reason === 'string' ? reason : 'Tab closed during translation')
        abortController.abort(abortReason)
      })
    : null

  try {
    translateChatLoop:
    for (let attempt = 0; attempt < GENAI_CHAT_MAX_RECOVERY_ATTEMPTS; attempt++) {
      const chatLease = await acquireGenAIChat(providerConfig, baseURL, 'translate', () => createChat(baseURL))
      let shouldResetChat = false
      let resetReason: string | null = null
      let pendingSet = false
      let pendingMessageSettled = false

      try {
        if (chatLease.pendingMessageGuid) {
          const settled = await settlePendingMessageIfNeeded(baseURL, chatLease, abortController.signal)
          if (!settled) {
            shouldResetChat = true
            resetReason = 'stale-pending-message'
            continue translateChatLoop
          }
        }

        let parentCompletionWaitAttempted = false

        while (true) {
          throwIfAborted(abortController.signal)

          const parentGuid = chatLease.parentMessageGuid ?? undefined
          let messageGuid: string
          let cancelMessagesResponse: ((reason?: string) => Promise<void>) | null = null
          let messageResponseCompleted = false
          try {
            messageGuid = await sendUserMessage(baseURL, chatLease.chatGuid, combinedContent, parentGuid, { signal: abortController.signal })
          }
          catch (error) {
            if (error instanceof GenAIPendingResponseError && parentGuid && !parentCompletionWaitAttempted) {
              parentCompletionWaitAttempted = true
              try {
                await waitForMessageCompletion(baseURL, parentGuid, { signal: abortController.signal })
                continue
              }
              catch (completionError) {
                logger.warn('[GenAI] Parent message did not complete before retrying', {
                  chatGuid: chatLease.chatGuid,
                  parentGuid,
                  error: completionError,
                })
                shouldResetChat = true
                resetReason = 'parent-still-processing'
                break
              }
            }

            if (error instanceof GenAIPendingResponseError) {
              shouldResetChat = true
              resetReason = 'chat-error-4'
              break
            }

            throw error
          }

          chatLease.setPendingMessageGuid(messageGuid)
          pendingSet = true
          cancelMessagesResponse = createMessageResponseCanceler(baseURL, messageGuid)

          const modelRef = getModelName(providerConfig, 'translate')
          const modelGuid = resolveGenAIModelGuid(modelRef)

          let messageFailureError: Error | null = null
          const messagesResponseAbortController = new AbortController()
          const unlinkMessageResponseAbort = forwardAbortSignal(abortController.signal, messagesResponseAbortController)
          const completionAbortController = new AbortController()
          const unlinkCompletionAbort = forwardAbortSignal(abortController.signal, completionAbortController)

          const completionMonitor = (async () => {
            try {
              await waitForMessageCompletion(baseURL, messageGuid, { signal: completionAbortController.signal })
            }
            catch (error) {
              if (isAbortError(error))
                return
              const normalizedError = error instanceof Error ? error : new Error(String(error))
              messageFailureError = normalizedError
              if (!messagesResponseAbortController.signal.aborted)
                messagesResponseAbortController.abort(normalizedError)
            }
          })()

          try {
            const { responseGuid: assistantGuid, fallbackContent } = await waitForAssistantMessage(baseURL, chatLease.chatGuid, messageGuid, modelGuid, { signal: messagesResponseAbortController.signal })
            messageResponseCompleted = true

            completionAbortController.abort()
            await completionMonitor

            const translationResult = await waitForMessageContent(baseURL, assistantGuid, {
              fallbackContent,
              onInvalidateChat: chatLease.invalidate,
              signal: abortController.signal,
            })

            pendingMessageSettled = translationResult.completed

            if (translationResult.completed)
              chatLease.setParentMessageGuid(assistantGuid)
            else {
              shouldResetChat = true
              resetReason = 'response-incomplete'
            }

            return normalizeAssistantResponse(translationResult.content)
          }
          catch (error) {
            completionAbortController.abort()
            await completionMonitor

            if (!messageResponseCompleted)
              void cancelMessagesResponse?.(isAbortError(error) ? 'request-aborted' : 'messages-response-error')

            if (messageFailureError && isAbortError(error))
              throw messageFailureError

            throw error
          }
          finally {
            messagesResponseAbortController.abort()
            completionAbortController.abort()
            unlinkMessageResponseAbort()
            unlinkCompletionAbort()
          }
        }

        if (shouldResetChat)
          continue translateChatLoop
      }
      catch (error) {
        if (shouldInvalidateChatFromHttpError(error))
          await chatLease.invalidate()
        if (isAbortError(error)) {
          shouldResetChat = true
          resetReason = resetReason ?? 'request-aborted'
          throw error
        }
        throw error
      }
      finally {
        if (pendingSet && pendingMessageSettled)
          chatLease.setPendingMessageGuid(null)

        if (shouldResetChat)
          await invalidateChatWithRemoteDelete(baseURL, chatLease, resetReason ?? 'pending-message')
        else
          await chatLease.release()
      }
    }

    throw new Error('[GenAI] Unable to obtain an available chat conversation')
  }
  finally {
    unregister?.()
  }
}

type GenAIGenerateOptions = {
  system?: string
  modelType?: ModelType
  clientRequestId?: string
}

export async function genaiGenerateText(
  prompt: string,
  providerConfig: GenAIProviderConfig,
  options?: GenAIGenerateOptions,
): Promise<string> {
  const baseURL = await ensureGenAISession(providerConfig)
  const system = options?.system ?? ''
  const content = [system, prompt].filter(Boolean).join('\n\n')
  if (!content.trim())
    return ''

  const modelType = options?.modelType ?? 'translate'
  const abortController = new AbortController()
  const unregister = options?.clientRequestId
    ? registerActiveGenAIRequest(options.clientRequestId, (reason?: unknown) => {
        if (abortController.signal.aborted)
          return
        const abortReason = reason instanceof Error ? reason : createAbortError(typeof reason === 'string' ? reason : 'GenAI request aborted')
        abortController.abort(abortReason)
      })
    : null

  try {
    generateChatLoop:
    for (let attempt = 0; attempt < GENAI_CHAT_MAX_RECOVERY_ATTEMPTS; attempt++) {
      const chatLease = await acquireGenAIChat(providerConfig, baseURL, modelType, () => createChat(baseURL))
      let shouldResetChat = false
      let resetReason: string | null = null
      let pendingSet = false
      let pendingMessageSettled = false

      try {
        if (chatLease.pendingMessageGuid) {
          const settled = await settlePendingMessageIfNeeded(baseURL, chatLease, abortController.signal)
          if (!settled) {
            shouldResetChat = true
            resetReason = 'stale-pending-message'
            continue generateChatLoop
          }
        }

        let parentCompletionWaitAttempted = false

        while (true) {
          throwIfAborted(abortController.signal)

          const parentGuid = chatLease.parentMessageGuid ?? undefined
          let messageGuid: string
          let cancelMessagesResponse: ((reason?: string) => Promise<void>) | null = null
          let messageResponseCompleted = false
          try {
            messageGuid = await sendUserMessage(baseURL, chatLease.chatGuid, content, parentGuid, { signal: abortController.signal })
          }
          catch (error) {
            if (error instanceof GenAIPendingResponseError && parentGuid && !parentCompletionWaitAttempted) {
              parentCompletionWaitAttempted = true
              try {
                await waitForMessageCompletion(baseURL, parentGuid, { signal: abortController.signal })
                continue
              }
              catch (completionError) {
                logger.warn('[GenAI] Parent message did not complete before retrying', {
                  chatGuid: chatLease.chatGuid,
                  parentGuid,
                  error: completionError,
                })
                shouldResetChat = true
                resetReason = 'parent-still-processing'
                break
              }
            }

            if (error instanceof GenAIPendingResponseError) {
              shouldResetChat = true
              resetReason = 'chat-error-4'
              break
            }

            throw error
          }

          chatLease.setPendingMessageGuid(messageGuid)
          pendingSet = true
          cancelMessagesResponse = createMessageResponseCanceler(baseURL, messageGuid)

          const modelRef = getModelName(providerConfig, modelType)
          const modelGuid = resolveGenAIModelGuid(modelRef)

          let assistantGuid: string
          let fallbackContent: string | null
          try {
            ({ responseGuid: assistantGuid, fallbackContent } = await waitForAssistantMessage(baseURL, chatLease.chatGuid, messageGuid, modelGuid, { signal: abortController.signal }))
            messageResponseCompleted = true
          }
          catch (error) {
            if (!messageResponseCompleted)
              void cancelMessagesResponse?.(isAbortError(error) ? 'request-aborted' : 'messages-response-error')
            throw error
          }

          const textResult = await waitForMessageContent(baseURL, assistantGuid, {
            fallbackContent,
            onInvalidateChat: chatLease.invalidate,
            signal: abortController.signal,
          })

          pendingMessageSettled = textResult.completed

          if (textResult.completed)
            chatLease.setParentMessageGuid(assistantGuid)
          else {
            shouldResetChat = true
            resetReason = 'response-incomplete'
          }

          return normalizeAssistantResponse(textResult.content)
        }

        if (shouldResetChat)
          continue generateChatLoop
      }
      catch (error) {
        if (shouldInvalidateChatFromHttpError(error))
          await chatLease.invalidate()
        if (isAbortError(error)) {
          shouldResetChat = true
          resetReason = resetReason ?? 'request-aborted'
          throw error
        }
        throw error
      }
      finally {
        if (pendingSet && pendingMessageSettled)
          chatLease.setPendingMessageGuid(null)

        if (shouldResetChat)
          await invalidateChatWithRemoteDelete(baseURL, chatLease, resetReason ?? 'pending-message')
        else
          await chatLease.release()
      }
    }

    throw new Error('[GenAI] Unable to obtain an available chat conversation')
  }
  finally {
    unregister?.()
  }
}

export async function warmGenAIChatPool(
  providerConfig: GenAIProviderConfig,
  purpose: GenAIChatPurpose,
  desiredSlots: number,
): Promise<void> {
  if (desiredSlots <= 0)
    return

  const baseURL = await ensureGenAISession(providerConfig)
  await scaleGenAIChatPool(providerConfig, baseURL, purpose, desiredSlots, () => createChat(baseURL))
}

export const __private__ = {
  readEventStream,
  parseGuidsFromRawSSE,
  waitForMessageContent,
  waitForMessageCompletion,
  GenAIHttpError,
  GenAIPendingResponseError,
}

