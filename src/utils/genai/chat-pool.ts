import type { GenAIProviderConfig } from '@/types/config/provider'
import { logger } from '@/utils/logger'
import { storage } from '#imports'
import { GENAI_CHAT_IDLE_TTL_MS } from './constants'

export type GenAIChatPurpose = 'translate' | 'read'

interface ChatPoolEntry {
  chatGuid: string
  lastUsed: number
  lastMessageGuid: string | null
  pendingMessageGuid: string | null
  pendingSince: number | null
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

type PersistedChatEntry = {
  chatGuid: string
  lastMessageGuid: string | null
  lastUsed: number
  pendingMessageGuid: string | null
  pendingSince: number | null
}

type StorageApi = typeof storage

const CHAT_POOL_STORAGE_KEY = 'genai_chat_pool'

const chatPool = new Map<string, ChatPoolEntry>()
const mutexPool = new Map<string, Mutex>()
let persistedSnapshot: Record<string, PersistedChatEntry> = {}
let hydrationPromise: Promise<void> | null = null
let hydrationCompleted = false
let persistenceQueue: Promise<void> = Promise.resolve()
let storageOverride: StorageApi | null = null

function getStorageApi(): StorageApi {
  return storageOverride ?? storage
}

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

async function loadPersistedSnapshot(): Promise<Record<string, PersistedChatEntry>> {
  if (hydrationCompleted)
    return persistedSnapshot

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        const stored = await getStorageApi().getItem<Record<string, PersistedChatEntry>>(`local:${CHAT_POOL_STORAGE_KEY}`) ?? {}
        persistedSnapshot = { ...stored }
        const now = Date.now()
        const expiredKeys: string[] = []
        for (const [key, entry] of Object.entries(stored)) {
          if (!entry.chatGuid || now - (entry.lastUsed ?? 0) > GENAI_CHAT_IDLE_TTL_MS) {
            expiredKeys.push(key)
            continue
          }
          chatPool.set(key, {
            chatGuid: entry.chatGuid,
            lastUsed: entry.lastUsed ?? now,
            lastMessageGuid: entry.lastMessageGuid ?? null,
            pendingMessageGuid: entry.pendingMessageGuid ?? null,
            pendingSince: entry.pendingSince ?? null,
          })
        }

        if (expiredKeys.length > 0) {
          for (const key of expiredKeys)
            delete persistedSnapshot[key]
          await getStorageApi().setItem(`local:${CHAT_POOL_STORAGE_KEY}`, persistedSnapshot)
        }
      }
      catch (error) {
        persistedSnapshot = {}
        logger.warn('[GenAI] Failed to hydrate GenAI chat pool from storage', error)
      }
      finally {
        hydrationCompleted = true
      }
    })().finally(() => {
      hydrationPromise = null
    })
  }

  await hydrationPromise
  return persistedSnapshot
}

function scheduleSnapshotSave() {
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      await getStorageApi().setItem(`local:${CHAT_POOL_STORAGE_KEY}`, persistedSnapshot)
    }
    catch (error) {
      logger.warn('[GenAI] Failed to persist GenAI chat pool state', error)
    }
  })
}

async function flushPersistenceQueue() {
  await persistenceQueue
}

async function ensureHydrated() {
  if (hydrationCompleted)
    return
  await loadPersistedSnapshot()
}

function schedulePersistEntry(key: string, entry: ChatPoolEntry) {
  void (async () => {
    await ensureHydrated()
    persistedSnapshot[key] = {
      chatGuid: entry.chatGuid,
      lastMessageGuid: entry.lastMessageGuid,
      lastUsed: entry.lastUsed,
      pendingMessageGuid: entry.pendingMessageGuid,
      pendingSince: entry.pendingSince,
    }
    scheduleSnapshotSave()
  })()
}

function scheduleDeleteEntries(keys: string[]) {
  if (keys.length === 0)
    return

  void (async () => {
    await ensureHydrated()
    let mutated = false
    for (const key of keys) {
      if (key in persistedSnapshot) {
        delete persistedSnapshot[key]
        mutated = true
      }
    }
    if (mutated)
      scheduleSnapshotSave()
  })()
}

function pruneExpiredEntries(now: number) {
  const expiredKeys: string[] = []
  for (const [key, entry] of chatPool.entries()) {
    if (now - entry.lastUsed > GENAI_CHAT_IDLE_TTL_MS) {
      chatPool.delete(key)
      expiredKeys.push(key)
      logger.info('[GenAI] Evicted stale chat from pool', { key })
    }
  }

  if (expiredKeys.length > 0)
    scheduleDeleteEntries(expiredKeys)
}

export interface GenAIChatLease {
  chatGuid: string
  parentMessageGuid: string | null
  pendingMessageGuid: string | null
  setParentMessageGuid: (guid: string | null) => void
  setPendingMessageGuid: (guid: string | null) => void
  release: () => void
  invalidate: () => void
}

export async function acquireGenAIChat(
  providerConfig: GenAIProviderConfig,
  baseURL: string,
  purpose: GenAIChatPurpose,
  createChat: () => Promise<string>,
): Promise<GenAIChatLease> {
  await ensureHydrated()
  const key = getPoolKey(providerConfig, purpose, baseURL)
  const mutex = getMutex(key)
  await mutex.acquire()

  const now = Date.now()
  pruneExpiredEntries(now)

  let entry = chatPool.get(key)
  if (!entry) {
    try {
      const chatGuid = await createChat()
      entry = { chatGuid, lastUsed: now, lastMessageGuid: null, pendingMessageGuid: null, pendingSince: null }
      chatPool.set(key, entry)
      schedulePersistEntry(key, entry)
      logger.info('[GenAI] Created new pooled chat', { key, chatGuid })
    }
    catch (error) {
      mutex.release()
      throw error
    }
  }

  entry.lastUsed = now
  schedulePersistEntry(key, entry)

  let released = false
  const getEntry = () => entry!
  const setParentMessageGuid = (guid: string | null) => {
    getEntry().lastMessageGuid = guid ?? null
    schedulePersistEntry(key, getEntry())
  }
  const setPendingMessageGuid = (guid: string | null) => {
    getEntry().pendingMessageGuid = guid ?? null
    getEntry().pendingSince = guid ? Date.now() : null
    schedulePersistEntry(key, getEntry())
  }
  const parentMessageGuid = getEntry().lastMessageGuid
  const pendingMessageGuid = getEntry().pendingMessageGuid
  const release = () => {
    if (released)
      return
    released = true
    getEntry().lastUsed = Date.now()
    schedulePersistEntry(key, getEntry())
    mutex.release()
  }

  const invalidate = () => {
    if (!released) {
      released = true
      mutex.release()
    }
    setParentMessageGuid(null)
    setPendingMessageGuid(null)
    chatPool.delete(key)
    scheduleDeleteEntries([key])
    logger.info('[GenAI] Invalidated pooled chat', { key })
  }

  return {
    chatGuid: getEntry().chatGuid,
    parentMessageGuid,
    pendingMessageGuid,
    setParentMessageGuid,
    setPendingMessageGuid,
    release,
    invalidate,
  }
}

async function clearPoolsForTest() {
  await flushPersistenceQueue()
  chatPool.clear()
  mutexPool.clear()
  persistedSnapshot = {}
  hydrationCompleted = false
  hydrationPromise = null
  await getStorageApi().setItem(`local:${CHAT_POOL_STORAGE_KEY}`, {})
}

function setStorageOverrideForTest(mock: StorageApi | null) {
  storageOverride = mock
}

export const __private__ = {
  clearPoolsForTest,
  getPoolSnapshot: () => new Map(chatPool),
  flushPersistenceQueue,
  setStorageOverrideForTest,
}
