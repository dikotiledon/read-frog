import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenAIProviderConfig } from '@/types/config/provider'
import { GENAI_CHAT_IDLE_TTL_MS, GENAI_CHAT_MAX_SLOTS_PER_KEY } from '../constants'
const storageMock = vi.hoisted(() => {
  const state: Record<string, any> = {}
  const storage = {
    getItem: vi.fn(async (key: string) => state[key] ?? null),
    setItem: vi.fn(async (key: string, value: any) => {
      state[key] = value
    }),
  }
  return { state, storage }
})

const { acquireGenAIChat, scaleGenAIChatPool, __private__ } = await import('../chat-pool')
__private__.setStorageOverrideForTest(storageMock.storage as any)

function resetStorageState() {
  Object.keys(storageMock.state).forEach(key => delete storageMock.state[key])
  storageMock.storage.getItem.mockClear()
  storageMock.storage.setItem.mockClear()
}

const baseProviderConfig: GenAIProviderConfig = {
  id: 'genai-default',
  name: 'Samsung GenAI',
  enabled: true,
  provider: 'genai',
  baseURL: 'https://genai.sec.samsung.net',
  description: 'test',
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

describe('acquireGenAIChat', () => {
  afterEach(async () => {
    await __private__.clearPoolsForTest()
    resetStorageState()
    vi.useRealTimers()
  })

  it('reuses the same chat for sequential acquisitions', async () => {
    const createChat = vi.fn().mockResolvedValue('chat-1')

    const leaseA = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseA.release()

    const leaseB = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseB.release()

    expect(createChat).toHaveBeenCalledTimes(1)
    expect(leaseB.chatGuid).toBe('chat-1')
  })

  it('creates a new chat after invalidation', async () => {
    const createChat = vi.fn().mockResolvedValueOnce('chat-1').mockResolvedValueOnce('chat-2')

    const leaseA = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseA.invalidate()

    const leaseB = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseB.release()

    expect(createChat).toHaveBeenCalledTimes(2)
    expect(leaseB.chatGuid).toBe('chat-2')
  })

  it('evicts idle chats after the TTL elapses', async () => {
    vi.useFakeTimers()
    const createChat = vi.fn().mockResolvedValueOnce('chat-ttl-1').mockResolvedValueOnce('chat-ttl-2')

    const leaseA = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseA.release()

    await vi.advanceTimersByTimeAsync(GENAI_CHAT_IDLE_TTL_MS + 1)

    const leaseB = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    await leaseB.release()

    expect(createChat).toHaveBeenCalledTimes(2)
    expect(leaseB.chatGuid).toBe('chat-ttl-2')
  })

  it('tracks parent message guid across leases and resets on invalidation', async () => {
    const createChat = vi.fn().mockResolvedValue('chat-parent')

    const leaseA = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseA.parentMessageGuid).toBeNull()
    leaseA.setParentMessageGuid('assistant-1')
    await leaseA.release()

    const leaseB = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseB.parentMessageGuid).toBe('assistant-1')
    await leaseB.invalidate()

    const leaseC = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseC.parentMessageGuid).toBeNull()
    await leaseC.release()
  })

  it('persists pending message guid so busy chats can be skipped later', async () => {
    const createChat = vi.fn().mockResolvedValue('chat-pending')

    const leaseA = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseA.pendingMessageGuid).toBeNull()
    leaseA.setPendingMessageGuid('user-1')
    await leaseA.release()

    const leaseB = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseB.pendingMessageGuid).toBe('user-1')
    await leaseB.invalidate()

    const leaseC = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)
    expect(leaseC.pendingMessageGuid).toBeNull()
    await leaseC.release()
  })

  it('hydrates persisted chat state on first acquisition', async () => {
    const now = Date.now()
    storageMock.state['local:genai_chat_pool'] = {
      'genai-default:translate:https://genai.sec.samsung.net': {
        slots: [
          {
            slotId: 'slot-1',
            chatGuid: 'persisted-chat',
            lastMessageGuid: 'assistant-prev',
            lastUsed: now,
            pendingMessageGuid: null,
            pendingSince: null,
          },
        ],
      },
    }

    const createChat = vi.fn()
    const lease = await acquireGenAIChat(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', createChat)

    expect(createChat).not.toHaveBeenCalled()
    expect(lease.chatGuid).toBe('persisted-chat')
    expect(lease.parentMessageGuid).toBe('assistant-prev')
    await lease.release()
  })

  it('warms idle slots up to the requested capacity', async () => {
    const createChat = vi.fn().mockResolvedValueOnce('warm-1').mockResolvedValueOnce('warm-2')

    await scaleGenAIChatPool(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', 2, createChat)

    const snapshot = __private__.getPoolSnapshot()
    const entry = snapshot.get('genai-default:translate:https://genai.sec.samsung.net')
    expect(entry?.slots).toHaveLength(2)
    entry?.slots.forEach(slot => expect(slot.busy).toBe(false))
    expect(createChat).toHaveBeenCalledTimes(2)
  })

  it('respects the max slots per key when warming', async () => {
    const createChat = vi.fn().mockImplementation(() => Promise.resolve(`chat-${crypto.randomUUID()}`))

    await scaleGenAIChatPool(baseProviderConfig, baseProviderConfig.baseURL!, 'translate', 10, createChat)

    const snapshot = __private__.getPoolSnapshot()
    const entry = snapshot.get('genai-default:translate:https://genai.sec.samsung.net')
    expect(entry?.slots.length).toBeLessThanOrEqual(GENAI_CHAT_MAX_SLOTS_PER_KEY)
  })
})
