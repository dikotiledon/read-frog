import type { EventSourceMessage } from 'eventsource-parser'
import type { GenAIProviderConfig } from '@/types/config/provider'
import type { ArticleContent } from '@/types/content'
import { createParser } from 'eventsource-parser'
import { logger } from '@/utils/logger'
import { getTranslatePrompt } from '@/utils/prompts/translate'
import { GENAI_ENDPOINTS, GENAI_MESSAGE_POLL_INTERVAL_MS, GENAI_MESSAGE_POLL_MAX_BACKOFF_MULTIPLIER, GENAI_MESSAGE_POLL_TIMEOUT_MS, GENAI_STREAM_COMPLETE_EVENTS } from './constants'
import { acquireGenAIChat } from './chat-pool'
import { resolveGenAIModelGuid } from './models'
import { ensureGenAISession } from './session'

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

async function sendUserMessage(baseURL: string, chatGuid: string, content: string, parentMessageGuid?: string | null) {
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

  const data = await genaiFetchJson<{ guid: string }>(baseURL, GENAI_ENDPOINTS.messages, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return data.guid
}

const COMPLETE_STATUS_SET = new Set<string>([...GENAI_STREAM_COMPLETE_EVENTS, 'R20000', 'DONE', 'COMPLETED', 'COMPLETE'])
const FAILURE_STATUS_SET = new Set(['FAIL', 'FAILED', 'ERROR'])
const MISSING_RESPONSE_HTTP_STATUS = new Set([404, 410])
const INVALIDATE_CHAT_HTTP_STATUS = new Set([401, 403, 404, 410])

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
  onInvalidateChat?: () => void
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

async function readEventStream(response: Response): Promise<ReadEventResult> {
  const reader = response.body?.getReader()
  if (!reader)
    throw new Error('[GenAI] Missing response stream')

  const decoder = new TextDecoder()
  let latestGuid: string | null = null
  let completedGuid: string | null = null
  let rawStreamText = ''
  const collectedContent: string[] = []

  let hasLoggedChunkFallbackError = false

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

  while (true) {
    const { value, done } = await reader.read()
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

async function waitForAssistantMessage(baseURL: string, chatGuid: string, messageGuid: string, modelGuid: string): Promise<ReadEventResult> {
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
  })

  return await readEventStream(response)
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
): Promise<string> {
  const pollIntervalMs = options?.pollIntervalMs ?? GENAI_MESSAGE_POLL_INTERVAL_MS
  const timeoutMs = options?.timeoutMs ?? GENAI_MESSAGE_POLL_TIMEOUT_MS
  const sleepFn = options?.sleep ?? sleep
  const fallbackContent = options?.fallbackContent ?? null
  const hasFallback = typeof fallbackContent === 'string' && fallbackContent.trim().length > 0
  const deadline = Date.now() + timeoutMs
  const normalizedPollInterval = Math.max(pollIntervalMs, 0)
  let attempts = 0
  let lastStatus: string | null = null

  while (true) {
    attempts += 1
    let data: GenAIMessageResponse
    try {
      data = await genaiFetchJson<GenAIMessageResponse>(baseURL, GENAI_ENDPOINTS.message(responseGuid), {
        method: 'GET',
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

        options?.onInvalidateChat?.()

        if (hasFallback) {
          logger.warn('[GenAI] Response message missing, using SSE fallback content', logContext)
          return fallbackContent as string
        }

        logger.warn('[GenAI] Response message missing, aborting polling', logContext)
        throw new Error(`[GenAI] Response ${responseGuid} is no longer available (HTTP ${error.status})`)
      }

      throw error
    }

    const content = typeof data.content === 'string' ? data.content : ''
    const trimmedContent = content.trim()
    const status: string | null = normalizeStatus(data.status) ?? lastStatus
    const responseCode = normalizeStatus(data.responseCode)

    if (trimmedContent.length > 0)
      return content

    if (status && FAILURE_STATUS_SET.has(status))
      throw new Error(`[GenAI] Response failed with status ${status}`)

    if (hasFallback && (status === 'SUCCESS' || responseCode)) {
      logger.warn('[GenAI] Using SSE fallback content due to empty response payload', {
        responseGuid,
        attempts,
        status,
        responseCode,
      })
      return fallbackContent as string
    }

    if (Date.now() >= deadline) {
      if (hasFallback) {
        logger.warn('[GenAI] Timed out waiting for response content, using SSE fallback', {
          responseGuid,
          attempts,
          lastStatus: status,
        })
        return fallbackContent as string
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
    await sleepFn(delayMs)
  }
}

export async function genaiTranslate(
  text: string,
  targetLangName: string,
  providerConfig: GenAIProviderConfig,
  options?: { isBatch?: boolean, content?: ArticleContent },
): Promise<string> {
  const baseURL = await ensureGenAISession(providerConfig)

  const { systemPrompt, prompt } = await getTranslatePrompt(targetLangName, text, options)
  const combinedContent = [systemPrompt, prompt].filter(Boolean).join('\n\n')
  if (!combinedContent.trim())
    return ''

  const chatLease = await acquireGenAIChat(providerConfig, baseURL, 'translate', () => createChat(baseURL))

  try {
    const parentGuid = chatLease.parentMessageGuid ?? undefined
    const messageGuid = await sendUserMessage(baseURL, chatLease.chatGuid, combinedContent, parentGuid)

    const modelRef = getModelName(providerConfig, 'translate')
    const modelGuid = resolveGenAIModelGuid(modelRef)

    const { responseGuid: assistantGuid, fallbackContent } = await waitForAssistantMessage(baseURL, chatLease.chatGuid, messageGuid, modelGuid)
    const translation = await waitForMessageContent(baseURL, assistantGuid, {
      fallbackContent,
      onInvalidateChat: chatLease.invalidate,
    })

    chatLease.setParentMessageGuid(assistantGuid)
    return normalizeAssistantResponse(translation)
  }
  catch (error) {
    if (shouldInvalidateChatFromHttpError(error))
      chatLease.invalidate()
    throw error
  }
  finally {
    chatLease.release()
  }
}

export async function genaiGenerateText(
  prompt: string,
  providerConfig: GenAIProviderConfig,
  options?: { system?: string, modelType?: ModelType },
): Promise<string> {
  const baseURL = await ensureGenAISession(providerConfig)
  const system = options?.system ?? ''
  const content = [system, prompt].filter(Boolean).join('\n\n')
  if (!content.trim())
    return ''

  const modelType = options?.modelType ?? 'translate'
  const chatLease = await acquireGenAIChat(providerConfig, baseURL, modelType, () => createChat(baseURL))

  try {
    const parentGuid = chatLease.parentMessageGuid ?? undefined
    const messageGuid = await sendUserMessage(baseURL, chatLease.chatGuid, content, parentGuid)

    const modelRef = getModelName(providerConfig, modelType)
    const modelGuid = resolveGenAIModelGuid(modelRef)

    const { responseGuid: assistantGuid, fallbackContent } = await waitForAssistantMessage(baseURL, chatLease.chatGuid, messageGuid, modelGuid)
    const text = await waitForMessageContent(baseURL, assistantGuid, {
      fallbackContent,
      onInvalidateChat: chatLease.invalidate,
    })
    chatLease.setParentMessageGuid(assistantGuid)
    return normalizeAssistantResponse(text)
  }
  catch (error) {
    if (shouldInvalidateChatFromHttpError(error))
      chatLease.invalidate()
    throw error
  }
  finally {
    chatLease.release()
  }
}

export const __private__ = {
  readEventStream,
  parseGuidsFromRawSSE,
  waitForMessageContent,
  GenAIHttpError,
}

