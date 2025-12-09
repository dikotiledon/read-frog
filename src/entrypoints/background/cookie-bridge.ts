import type { Config } from '@/types/config/config'
import type { GenAIProviderConfig, ProviderConfig } from '@/types/config/provider'
import { browser, storage } from '#imports'
import { CONFIG_STORAGE_KEY } from '@/utils/constants/config'
import { GENAI_COOKIE_BRIDGE_DEFAULT_PORT } from '@/utils/constants/providers'
import { logger } from '@/utils/logger'

const TARGET_DOMAIN_SUFFIXES = ['.sec.samsung.net', '.secsso.net']
const BRIDGE_HOST = '127.0.0.1'
const ENDPOINT_PATH = '/cookies'
const PUSH_DEBOUNCE_MS = 1500

type CookieChangeListener = Parameters<typeof browser.cookies.onChanged.addListener>[0]
type TabUpdateListener = Parameters<typeof browser.tabs.onUpdated.addListener>[0]
type StorageChangeListener = Parameters<typeof browser.storage.onChanged.addListener>[0]
type StorageChangeRecord = Parameters<StorageChangeListener>[0]
type StorageAreaName = Parameters<StorageChangeListener>[1]

interface BridgeSettings {
  enabled: boolean
  port: number
}

interface CookiePayloadItem {
  name: string
  value: string
}

let currentSettings: BridgeSettings = { enabled: false, port: GENAI_COOKIE_BRIDGE_DEFAULT_PORT }
let debounceHandle: ReturnType<typeof setTimeout> | null = null
let cookieListener: CookieChangeListener | null = null
let tabUpdateListener: TabUpdateListener | null = null
let lastSignature: string | null = null

export async function setupGenAICookieBridge() {
  await refreshSettings()
  browser.storage.onChanged.addListener(handleStorageChange)
}

async function refreshSettings() {
  try {
    const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
    applySettings(config)
  }
  catch (error) {
    logger.warn('[GenAI CookieBridge] Failed to read config', error)
  }
}

function handleStorageChange(changes: StorageChangeRecord, areaName: StorageAreaName) {
  if (areaName !== 'local')
    return
  if (!Object.prototype.hasOwnProperty.call(changes, CONFIG_STORAGE_KEY))
    return

  const newConfig = changes[CONFIG_STORAGE_KEY].newValue as Config | null | undefined
  applySettings(newConfig ?? null)
}

function applySettings(config: Config | null) {
  const next = extractBridgeSettings(config)
  if (next.enabled === currentSettings.enabled && next.port === currentSettings.port)
    return

  logger.info('[GenAI CookieBridge] Updating settings', next)
  currentSettings = next
  lastSignature = null

  if (currentSettings.enabled)
    enableBridge()
  else
    disableBridge()
}

function extractBridgeSettings(config: Config | null): BridgeSettings {
  if (!config)
    return { enabled: true, port: GENAI_COOKIE_BRIDGE_DEFAULT_PORT }

  const genaiProviders = config.providersConfig
    .filter((provider: ProviderConfig): provider is GenAIProviderConfig => provider.provider === 'genai')

  if (genaiProviders.length === 0)
    return { enabled: true, port: GENAI_COOKIE_BRIDGE_DEFAULT_PORT }

  const enabledProvider = genaiProviders.find((provider: GenAIProviderConfig) => provider.cookieBridge?.enabled)
  if (enabledProvider)
    return { enabled: true, port: resolvePort(enabledProvider) }

  const fallback = genaiProviders.find((provider: GenAIProviderConfig) => provider.cookieBridge)
  return { enabled: false, port: resolvePort(fallback) }
}

function resolvePort(provider?: GenAIProviderConfig) {
  const candidate = provider?.cookieBridge?.port
  return typeof candidate === 'number' ? candidate : GENAI_COOKIE_BRIDGE_DEFAULT_PORT
}

function enableBridge() {
  if (!cookieListener) {
    const listener: CookieChangeListener = (changeInfo) => {
      const domain = changeInfo.cookie?.domain ?? ''
      if (!matchesTargetDomain(domain))
        return
      schedulePush('cookie-change')
    }
    cookieListener = listener
    browser.cookies.onChanged.addListener(listener)
  }

  if (!tabUpdateListener) {
    const listener: TabUpdateListener = (tabId, changeInfo, tab) => {
      if (changeInfo.status !== 'complete' || !tab.url)
        return
      if (TARGET_DOMAIN_SUFFIXES.some(suffix => tab.url?.includes(suffix)))
        schedulePush('tab-complete')
    }
    tabUpdateListener = listener
    browser.tabs.onUpdated.addListener(listener)
  }

  schedulePush('enabled')
}

function disableBridge() {
  if (cookieListener) {
    browser.cookies.onChanged.removeListener(cookieListener)
    cookieListener = null
  }

  if (tabUpdateListener) {
    browser.tabs.onUpdated.removeListener(tabUpdateListener)
    tabUpdateListener = null
  }

  if (debounceHandle) {
    clearTimeout(debounceHandle)
    debounceHandle = null
  }
}

function matchesTargetDomain(domain: string) {
  const normalized = domain.startsWith('.') ? domain : `.${domain}`
  return TARGET_DOMAIN_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

function schedulePush(trigger: string) {
  if (!currentSettings.enabled)
    return

  if (debounceHandle)
    clearTimeout(debounceHandle)

  debounceHandle = setTimeout(() => {
    void pushCookies(trigger)
  }, PUSH_DEBOUNCE_MS)
}

async function collectCookies(): Promise<CookiePayloadItem[]> {
  const allCookies = await browser.cookies.getAll({})
  const seen = new Set<string>()
  const filtered: CookiePayloadItem[] = []

  for (const cookie of allCookies) {
    if (!matchesTargetDomain(cookie.domain ?? ''))
      continue
    if (!cookie.name || typeof cookie.value === 'undefined')
      continue

    const key = `${cookie.domain}:${cookie.name}`
    if (seen.has(key))
      continue
    seen.add(key)

    filtered.push({ name: cookie.name, value: cookie.value })
  }

  return filtered
}

async function pushCookies(trigger: string) {
  if (!currentSettings.enabled)
    return

  try {
    const cookies = await collectCookies()
    if (cookies.length === 0) {
      logger.info('[GenAI CookieBridge] No cookies to push', { trigger })
      return
    }

    const signature = JSON.stringify(cookies)
    if (signature === lastSignature) {
      logger.info('[GenAI CookieBridge] Skipping duplicate payload', { trigger })
      return
    }

    const response = await fetch(`http://${BRIDGE_HOST}:${currentSettings.port}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'read-frog',
        cookies,
      }),
    })

    if (!response.ok)
      throw new Error(`Bridge responded with ${response.status}`)

    lastSignature = signature
    logger.info('[GenAI CookieBridge] Posted cookies to bridge', { count: cookies.length, trigger })
  }
  catch (error) {
    logger.warn('[GenAI CookieBridge] Failed to push cookies', { trigger, error })
  }
}
