import type { ProxyResponse } from '@/types/proxy-fetch'
import { logger } from '@/utils/logger'
import { sendMessage } from '@/utils/message'

const BACKGROUND_FETCH_MAX_ATTEMPTS = 3
const BACKGROUND_FETCH_RETRY_BASE_DELAY_MS = 120
const BACKGROUND_FETCH_RETRY_MAX_DELAY_MS = 800

interface RuntimeLike {
  id?: string
  sendMessage?: unknown
}

function hasExtensionRuntimeMessaging(): boolean {
  try {
    const scope = globalThis as typeof globalThis & {
      browser?: { runtime?: RuntimeLike }
      chrome?: { runtime?: RuntimeLike }
    }
    const runtime = scope.browser?.runtime ?? scope.chrome?.runtime
    return Boolean(runtime?.id && typeof runtime.sendMessage === 'function')
  }
  catch {
    return false
  }
}

function isDocumentContext(): boolean {
  try {
    return typeof document !== 'undefined'
  }
  catch {
    return false
  }
}

function isExtensionOrigin(): boolean {
  try {
    const origin = globalThis.location?.origin
    if (!origin)
      return false
    return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')
  }
  catch {
    return false
  }
}

type ProxyMode = 'proxy' | 'direct' | 'direct-unsafe'

const PROXY_MODE: ProxyMode = (() => {
  if (!isDocumentContext())
    return 'direct'

  if (isExtensionOrigin())
    return 'direct'

  if (hasExtensionRuntimeMessaging())
    return 'proxy'

  return 'direct-unsafe'
})()

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableMessagingError(error: unknown): boolean {
  if (!error)
    return false
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : null
  if (!message)
    return false

  const normalized = message.toLowerCase()
  return normalized.includes('no receiver')
    || normalized.includes('receiving end does not exist')
    || normalized.includes('extension context invalidated')
    || normalized.includes('invalid extension id')
}

function createResponseFromProxy(proxyResponse: ProxyResponse): Response {
  return new Response(proxyResponse.body ?? null, {
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers: proxyResponse.headers,
  })
}

async function fetchViaBackground(url: string, init?: RequestInit): Promise<Response> {
  const proxyResponse = await sendMessage('backgroundFetch', {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers ? Array.from(new Headers(init.headers).entries()) : undefined,
    body: typeof init?.body === 'string' ? init.body : undefined,
    credentials: init?.credentials ?? 'include',
  })
  return createResponseFromProxy(proxyResponse)
}

async function fetchViaBackgroundWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < BACKGROUND_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchViaBackground(url, init)
    }
    catch (error) {
      lastError = error
      if (!isRetryableMessagingError(error) || attempt === BACKGROUND_FETCH_MAX_ATTEMPTS - 1)
        throw error

      const delayMs = Math.min(
        BACKGROUND_FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt,
        BACKGROUND_FETCH_RETRY_MAX_DELAY_MS,
      )

      logger.info('[GenAI] Waiting for background fetch proxy to attach', {
        url,
        method: init?.method ?? 'GET',
        attempt: attempt + 1,
        delayMs,
        error,
      })

      await delay(delayMs)
    }
  }

  throw lastError ?? new Error('Background fetch proxy unavailable')
}

export async function fetchWithGenAIFallback(url: string, init?: RequestInit): Promise<Response> {
  if (PROXY_MODE === 'direct')
    return await fetch(url, init)

  if (PROXY_MODE === 'direct-unsafe') {
    logger.warn('[GenAI] Background proxy unavailable in this context; falling back to direct fetch (may hit CORS)', {
      url,
      method: init?.method ?? 'GET',
    })
    return await fetch(url, init)
  }

  return await fetchViaBackgroundWithRetry(url, init)
}
