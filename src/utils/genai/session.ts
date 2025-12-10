import type { GenAIProviderConfig } from '@/types/config/provider'
import { browser } from '#imports'
import { logger } from '@/utils/logger'
import { sendMessage } from '@/utils/message'
import { GENAI_DEFAULT_BASE_URL, GENAI_ENDPOINTS, GENAI_LOGIN_TIMEOUT_MS, GENAI_SESSION_RETRY_INTERVAL_MS } from './constants'
import { fetchWithGenAIFallback } from './http'

type BrowserAPI = typeof browser

function getBrowserApi(): BrowserAPI {
  const globalBrowser = (globalThis as typeof globalThis & { browser?: BrowserAPI }).browser
  return globalBrowser ?? browser
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function joinURL(baseURL: string, path: string) {
  return `${baseURL.replace(/\/$/, '')}${path}`
}

export function getGenAIBaseURL(providerConfig?: GenAIProviderConfig): string {
  const configured = providerConfig?.baseURL?.trim()
  if (configured)
    return configured.replace(/\/$/, '')
  return GENAI_DEFAULT_BASE_URL
}

function hasSessionPayloadData(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object')
    return false

  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object')
    return false

  return Object.keys(data as Record<string, unknown>).length > 0
}

async function fetchSessionStatus(baseURL: string): Promise<boolean> {
  const sessionUrl = joinURL(baseURL, GENAI_ENDPOINTS.session)
  const response = await fetchWithGenAIFallback(sessionUrl, {
    method: 'GET',
    credentials: 'include',
  })

  if (response.status !== 200) {
    if (response.status === 401 || response.status === 403)
      return false

    logger.warn('[GenAI] Unexpected session status', response.status)
    return false
  }

  try {
    const payload = await response.json()
    return hasSessionPayloadData(payload)
  }
  catch (error) {
    logger.warn('[GenAI] Failed to parse session payload', error)
    return false
  }
}

async function waitForSession(baseURL: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < GENAI_LOGIN_TIMEOUT_MS) {
    try {
      const ready = await fetchSessionStatus(baseURL)
      if (ready)
        return
    }
    catch (error) {
      logger.warn('[GenAI] Session check failed during wait', error)
    }
    await delay(GENAI_SESSION_RETRY_INTERVAL_MS)
  }
  throw new Error('Timed out waiting for Samsung GenAI login to complete')
}

async function openInteractiveLoginTab(baseURL: string): Promise<number | undefined> {
  const browserApi = getBrowserApi()
  try {
    if (browserApi.tabs?.create) {
      const tab = await browserApi.tabs.create({ url: baseURL, active: true })
      return tab.id ?? undefined
    }

    logger.info('[GenAI] Delegating login tab creation to background context')
    return await sendMessage('openExtensionTab', { url: baseURL, active: true })
  }
  catch (error) {
    logger.error('[GenAI] Failed to open login tab', error)
    throw error
  }
}

async function closeTab(tabId?: number) {
  if (tabId === undefined)
    return
  const browserApi = getBrowserApi()
  try {
    if (browserApi.tabs?.remove) {
      await browserApi.tabs.remove(tabId)
      return
    }

    logger.info('[GenAI] Delegating login tab close to background context', { tabId })
    await sendMessage('closeExtensionTab', { tabId })
  }
  catch (error) {
    logger.warn('[GenAI] Failed to close GenAI login tab', error)
  }
}

let interactiveLoginPromise: Promise<void> | null = null

async function runInteractiveLogin(baseURL: string): Promise<void> {
  const tabId = await openInteractiveLoginTab(baseURL)
  try {
    await waitForSession(baseURL)
  }
  finally {
    await closeTab(tabId)
  }
}

export async function ensureGenAISession(providerConfig: GenAIProviderConfig): Promise<string> {
  const baseURL = getGenAIBaseURL(providerConfig)
  let hasActiveSession = false
  try {
    hasActiveSession = await fetchSessionStatus(baseURL)
  }
  catch (error) {
    logger.warn('[GenAI] Session check failed before interactive login', error)
    hasActiveSession = false
  }

  if (hasActiveSession) {
    logger.info('[GenAI] Session already active')
    return baseURL
  }

  if (!interactiveLoginPromise) {
    interactiveLoginPromise = runInteractiveLogin(baseURL)
      .catch((error) => {
        logger.error('[GenAI] Interactive login failed', error)
        throw error
      })
      .finally(() => {
        interactiveLoginPromise = null
      })
  }

  await interactiveLoginPromise
  return baseURL
}
