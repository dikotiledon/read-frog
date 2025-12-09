import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenAIProviderConfig } from '@/types/config/provider'
import { GENAI_COOKIE_BRIDGE_DEFAULT_PORT } from '@/utils/constants/providers'
import { ensureGenAISession } from '../session'
import { GENAI_DEFAULT_BASE_URL, GENAI_SESSION_RETRY_INTERVAL_MS } from '../constants'

const tabsCreate = vi.fn()
const tabsRemove = vi.fn()

const mockBrowser = {
  tabs: {
    create: tabsCreate,
    remove: tabsRemove,
  },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>
let fetchMock: FetchMock

vi.stubGlobal('browser', mockBrowser as any)

vi.mock('#imports', () => ({
  browser: mockBrowser,
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const baseConfig: GenAIProviderConfig = {
  id: 'genai-test',
  name: 'Samsung GenAI',
  enabled: true,
  provider: 'genai',
  baseURL: GENAI_DEFAULT_BASE_URL,
  description: 'test',
  cookieBridge: {
    enabled: false,
    port: GENAI_COOKIE_BRIDGE_DEFAULT_PORT,
  },
  models: {
    read: {
      model: 'GPT-OSS',
      isCustomModel: false,
      customModel: null,
    },
    translate: {
      model: 'GPT-OSS',
      isCustomModel: false,
      customModel: null,
    },
  },
}

describe('ensureGenAISession', () => {
  beforeEach(() => {
    vi.useRealTimers()
    tabsCreate.mockReset()
    tabsRemove.mockReset()
    fetchMock = vi.fn<typeof fetch>()
    global.fetch = fetchMock
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns immediately when the session is already active', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ statusCode: 200, data: { name: 'Test' } }))

    const baseURL = await ensureGenAISession(baseConfig)

    expect(baseURL).toBe(GENAI_DEFAULT_BASE_URL)
    expect(tabsCreate).not.toHaveBeenCalled()
    expect(tabsRemove).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opens a login tab and waits for the session to warm up when cookies are missing', async () => {
    vi.useFakeTimers()
    const responses = [
      new Response('', { status: 401 }),
      new Response('', { status: 401 }),
      jsonResponse({ statusCode: 200, data: { name: 'Test' } }),
    ]
    fetchMock.mockImplementation(() => {
      const next = responses.shift() ?? new Response('', { status: 200 })
      return Promise.resolve(next)
    })

    tabsCreate.mockResolvedValue({ id: 777 })
    tabsRemove.mockResolvedValue(undefined)

    const promise = ensureGenAISession(baseConfig)

    await vi.advanceTimersByTimeAsync(GENAI_SESSION_RETRY_INTERVAL_MS * 2)
    const baseURL = await promise

    expect(baseURL).toBe(GENAI_DEFAULT_BASE_URL)
    expect(tabsCreate).toHaveBeenCalledWith({ url: GENAI_DEFAULT_BASE_URL, active: true })
    expect(tabsRemove).toHaveBeenCalledWith(777)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('opens a login tab when the initial session check throws', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ statusCode: 200, data: { name: 'Test' } }))

    tabsCreate.mockResolvedValue({ id: 999 })
    tabsRemove.mockResolvedValue(undefined)

    const promise = ensureGenAISession(baseConfig)

    await vi.advanceTimersByTimeAsync(GENAI_SESSION_RETRY_INTERVAL_MS)
    const baseURL = await promise

    expect(baseURL).toBe(GENAI_DEFAULT_BASE_URL)
    expect(tabsCreate).toHaveBeenCalledWith({ url: GENAI_DEFAULT_BASE_URL, active: true })
    expect(tabsRemove).toHaveBeenCalledWith(999)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats session payload without user data as inactive', async () => {
    vi.useFakeTimers()
    const responses = [
      jsonResponse({ statusCode: 200 }),
      jsonResponse({ statusCode: 200 }),
      jsonResponse({ statusCode: 200, data: { name: 'Recovered' } }),
    ]

    fetchMock.mockImplementation(() => Promise.resolve(responses.shift() ?? jsonResponse({ statusCode: 200, data: { id: 'fallback' } })))

    tabsCreate.mockResolvedValue({ id: 432 })
    tabsRemove.mockResolvedValue(undefined)

    const promise = ensureGenAISession(baseConfig)

    await vi.advanceTimersByTimeAsync(GENAI_SESSION_RETRY_INTERVAL_MS * 2)
    const baseURL = await promise

    expect(baseURL).toBe(GENAI_DEFAULT_BASE_URL)
    expect(tabsCreate).toHaveBeenCalledWith({ url: GENAI_DEFAULT_BASE_URL, active: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats 200 responses without user data as unauthenticated', async () => {
    vi.useFakeTimers()
    const responses = [
      jsonResponse({ statusCode: 200 }),
      jsonResponse({ statusCode: 200, data: { name: 'Recovered' } }),
    ]

    fetchMock.mockImplementation(() => Promise.resolve(responses.shift()!))
    tabsCreate.mockResolvedValue({ id: 321 })
    tabsRemove.mockResolvedValue(undefined)

    const promise = ensureGenAISession(baseConfig)

    await vi.advanceTimersByTimeAsync(GENAI_SESSION_RETRY_INTERVAL_MS)
    const baseURL = await promise

    expect(baseURL).toBe(GENAI_DEFAULT_BASE_URL)
    expect(tabsCreate).toHaveBeenCalledWith({ url: GENAI_DEFAULT_BASE_URL, active: true })
    expect(tabsRemove).toHaveBeenCalledWith(321)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
