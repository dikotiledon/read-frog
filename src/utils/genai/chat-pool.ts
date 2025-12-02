import type { GenAIProviderConfig } from '@/types/config/provider'
import { logger } from '@/utils/logger'
import { GENAI_CHAT_IDLE_TTL_MS } from './constants'

export type GenAIChatPurpose = 'translate' | 'read'

interface ChatPoolEntry {
  chatGuid: string
  lastUsed: number
  lastMessageGuid: string | null
}

class Mutex {
  private queue: Array<() => void> = []
  private locked = false

  async acquire() {
    if (!this.locked) {
      this.locked = true
      return
    }

    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release() {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.locked = false
  }
}

const chatPool = new Map<string, ChatPoolEntry>()
const mutexPool = new Map<string, Mutex>()

function getPoolKey(providerConfig: GenAIProviderConfig, purpose: GenAIChatPurpose, baseURL: string) {
  return `${providerConfig.id}:${purpose}:${baseURL}`
}

function getMutex(key: string): Mutex {
  let mutex = mutexPool.get(key)
  if (!mutex) {
    mutex = new Mutex()
    mutexPool.set(key, mutex)
  }
  return mutex
}

function pruneExpiredEntries(now: number) {
  for (const [key, entry] of chatPool.entries()) {
    if (now - entry.lastUsed > GENAI_CHAT_IDLE_TTL_MS) {
      chatPool.delete(key)
      logger.info('[GenAI] Evicted stale chat from pool', { key })
    }
  }
}

export interface GenAIChatLease {
  chatGuid: string
  parentMessageGuid: string | null
  setParentMessageGuid: (guid: string | null) => void
  release: () => void
  invalidate: () => void
}

export async function acquireGenAIChat(
  providerConfig: GenAIProviderConfig,
  baseURL: string,
  purpose: GenAIChatPurpose,
  createChat: () => Promise<string>,
): Promise<GenAIChatLease> {
  const key = getPoolKey(providerConfig, purpose, baseURL)
  const mutex = getMutex(key)
  await mutex.acquire()

  const now = Date.now()
  pruneExpiredEntries(now)

  let entry = chatPool.get(key)
  if (!entry) {
    try {
      const chatGuid = await createChat()
      entry = { chatGuid, lastUsed: now, lastMessageGuid: null }
      chatPool.set(key, entry)
      logger.info('[GenAI] Created new pooled chat', { key, chatGuid })
    }
    catch (error) {
      mutex.release()
      throw error
    }
  }

  entry.lastUsed = now

  let released = false
  const getEntry = () => entry!
  const setParentMessageGuid = (guid: string | null) => {
    getEntry().lastMessageGuid = guid ?? null
  }
  const parentMessageGuid = getEntry().lastMessageGuid
  const release = () => {
    if (released)
      return
    released = true
    getEntry().lastUsed = Date.now()
    mutex.release()
  }

  const invalidate = () => {
    if (!released) {
      released = true
      mutex.release()
    }
    setParentMessageGuid(null)
    chatPool.delete(key)
    logger.info('[GenAI] Invalidated pooled chat', { key })
  }

  return {
    chatGuid: getEntry().chatGuid,
    parentMessageGuid,
    setParentMessageGuid,
    release,
    invalidate,
  }
}

function clearPoolsForTest() {
  chatPool.clear()
  mutexPool.clear()
}

export const __private__ = {
  clearPoolsForTest,
  getPoolSnapshot: () => new Map(chatPool),
}
