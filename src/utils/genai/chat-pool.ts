import type { GenAIProviderConfig } from '@/types/config/provider'
import { storage } from '#imports'
import { logger } from '@/utils/logger'
import { GENAI_CHAT_IDLE_TTL_MS, GENAI_CHAT_MAX_SLOTS_PER_KEY } from './constants'

export type GenAIChatPurpose = 'translate' | 'read'

interface ChatSlot {
  slotId: string
  chatGuid: string
  lastUsed: number
  parentMessageGuid: string | null
  pendingMessageGuid: string | null
  pendingSince: number | null
  busy: boolean
}

interface ChatPoolEntry {
  slots: ChatSlot[]
  waiters: Array<(slot: ChatSlot) => void>
  pendingProvisionCount: number
  createChatFactory?: () => Promise<string>
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

interface PersistedChatSlot {
  slotId: string
  chatGuid: string
  lastMessageGuid: string | null
  lastUsed: number
  pendingMessageGuid: string | null
  pendingSince: number | null
}

interface PersistedPoolEntry {
  slots: PersistedChatSlot[]
}

type StorageApi = typeof storage

const CHAT_POOL_STORAGE_KEY = 'genai_chat_pool'

const chatPool = new Map<string, ChatPoolEntry>()
const mutexPool = new Map<string, Mutex>()
let persistedSnapshot: Record<string, PersistedPoolEntry> = {}
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

function getOrCreateEntry(key: string): ChatPoolEntry {
  let entry = chatPool.get(key)
  if (!entry) {
    entry = {
      slots: [],
      waiters: [],
      pendingProvisionCount: 0,
    }
    chatPool.set(key, entry)
  }
  return entry
}

async function loadPersistedSnapshot(): Promise<Record<string, PersistedPoolEntry>> {
  if (hydrationCompleted)
    return persistedSnapshot

  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        const stored = await getStorageApi().getItem<Record<string, PersistedPoolEntry>>(`local:${CHAT_POOL_STORAGE_KEY}`) ?? {}
        persistedSnapshot = { ...stored }
        const now = Date.now()
        const expiredKeys: string[] = []
        for (const [key, entry] of Object.entries(stored)) {
          const hydratedSlots: ChatSlot[] = []
          for (const slot of entry.slots ?? []) {
            if (!slot.chatGuid)
              continue
            if (now - (slot.lastUsed ?? 0) > GENAI_CHAT_IDLE_TTL_MS)
              continue
            hydratedSlots.push({
              slotId: slot.slotId ?? crypto.randomUUID(),
              chatGuid: slot.chatGuid,
              lastUsed: slot.lastUsed ?? now,
              parentMessageGuid: slot.lastMessageGuid ?? null,
              pendingMessageGuid: slot.pendingMessageGuid ?? null,
              pendingSince: slot.pendingSince ?? null,
              busy: false,
            })
          }

          if (hydratedSlots.length > 0) {
            chatPool.set(key, {
              slots: hydratedSlots,
              waiters: [],
              pendingProvisionCount: 0,
            })
          }
          else {
            expiredKeys.push(key)
          }
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

function serializeEntry(entry: ChatPoolEntry): PersistedPoolEntry | null {
  const slots = entry.slots
    .filter(slot => !!slot.chatGuid)
    .map<PersistedChatSlot>(slot => ({
      slotId: slot.slotId,
      chatGuid: slot.chatGuid,
      lastMessageGuid: slot.parentMessageGuid,
      lastUsed: slot.lastUsed,
      pendingMessageGuid: slot.pendingMessageGuid,
      pendingSince: slot.pendingSince,
    }))

  if (slots.length === 0)
    return null
  return { slots }
}

function schedulePersistEntry(key: string, entry: ChatPoolEntry) {
  void (async () => {
    await ensureHydrated()
    const snapshot = serializeEntry(entry)
    if (snapshot) {
      persistedSnapshot[key] = snapshot
      scheduleSnapshotSave()
      return
    }

    delete persistedSnapshot[key]
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
  const remainingKeys: Record<string, true> = {}

  for (const [key, entry] of chatPool.entries()) {
    const originalLength = entry.slots.length
    entry.slots = entry.slots.filter(slot => slot.busy || now - slot.lastUsed <= GENAI_CHAT_IDLE_TTL_MS)

    if (entry.slots.length !== originalLength)
      logger.info('[GenAI] Evicted stale chat slots', { key, removed: originalLength - entry.slots.length })

    if (entry.slots.length === 0 && entry.waiters.length === 0 && entry.pendingProvisionCount === 0) {
      chatPool.delete(key)
      expiredKeys.push(key)
    }
    if (entry.slots.length > 0)
      remainingKeys[key] = true
  }

  if (expiredKeys.length > 0)
    scheduleDeleteEntries(expiredKeys)

  void (async () => {
    await ensureHydrated()
    let mutated = false
    for (const key of Object.keys(persistedSnapshot)) {
      if (!(key in remainingKeys)) {
        delete persistedSnapshot[key]
        mutated = true
      }
    }
    if (mutated)
      scheduleSnapshotSave()
  })()
}

function createSlot(chatGuid: string, now: number): ChatSlot {
  return {
    slotId: crypto.randomUUID(),
    chatGuid,
    lastUsed: now,
    parentMessageGuid: null,
    pendingMessageGuid: null,
    pendingSince: null,
    busy: false,
  }
}

async function provisionSlot(
  key: string,
  entry: ChatPoolEntry,
  mutex: Mutex,
  createChat: () => Promise<string>,
  options?: { markBusy?: boolean },
): Promise<ChatSlot> {
  await mutex.acquire()
  entry.pendingProvisionCount += 1
  mutex.release()

  let chatGuid: string
  try {
    chatGuid = await createChat()
  }
  catch (error) {
    await mutex.acquire()
    entry.pendingProvisionCount = Math.max(0, entry.pendingProvisionCount - 1)
    mutex.release()
    throw error
  }

  await mutex.acquire()
  entry.pendingProvisionCount = Math.max(0, entry.pendingProvisionCount - 1)
  const slot = createSlot(chatGuid, Date.now())
  slot.busy = options?.markBusy ?? false
  entry.slots.push(slot)
  schedulePersistEntry(key, entry)
  mutex.release()
  return slot
}

function enqueueWaiter(entry: ChatPoolEntry): Promise<ChatSlot> {
  let resolver!: (slot: ChatSlot) => void
  const promise = new Promise<ChatSlot>((resolve) => {
    resolver = resolve
  })
  entry.waiters.push(resolver)
  return promise
}

async function fulfillWaiterWithNewSlot(
  key: string,
  entry: ChatPoolEntry,
  mutex: Mutex,
  createChat: () => Promise<string>,
  waiter: (slot: ChatSlot) => void,
) {
  let slot: ChatSlot | null = null
  try {
    slot = await provisionSlot(key, entry, mutex, createChat, { markBusy: true })
    logger.info('[GenAI] Provisioned replacement chat slot for waiter', { key, chatGuid: slot.chatGuid })
  }
  catch (error) {
    await mutex.acquire()
    entry.waiters.unshift(waiter)
    mutex.release()
    logger.warn('[GenAI] Failed to provision chat slot for waiter', { key, error })
    return
  }

  waiter(slot)
}

async function reserveSlot(
  key: string,
  entry: ChatPoolEntry,
  mutex: Mutex,
  createChat: () => Promise<string>,
): Promise<ChatSlot> {
  while (true) {
    await mutex.acquire()
    entry.createChatFactory = createChat
    const now = Date.now()
    const available = entry.slots.find(slot => !slot.busy)
    if (available) {
      available.busy = true
      available.lastUsed = now
      mutex.release()
      return available
    }

    const canProvision = (entry.slots.length + entry.pendingProvisionCount) < GENAI_CHAT_MAX_SLOTS_PER_KEY
    if (canProvision) {
      mutex.release()
      try {
        const slot = await provisionSlot(key, entry, mutex, createChat, { markBusy: true })
        logger.info('[GenAI] Created new pooled chat slot', { key, chatGuid: slot.chatGuid, slotCount: entry.slots.length })
        return slot
      }
      catch (error) {
        logger.warn('[GenAI] Failed to provision chat slot', { key, error })
        continue
      }
    }

    const waiterPromise = enqueueWaiter(entry)
    mutex.release()
    const slot = await waiterPromise
    if (slot)
      return slot
  }
}

async function handleRelease(
  key: string,
  entry: ChatPoolEntry,
  mutex: Mutex,
  slot: ChatSlot,
) {
  let waiter: ((slot: ChatSlot) => void) | undefined

  await mutex.acquire()
  try {
    slot.busy = false
    slot.lastUsed = Date.now()
    if (entry.waiters.length > 0) {
      waiter = entry.waiters.shift()
      slot.busy = true
    }
    else {
      schedulePersistEntry(key, entry)
    }
  }
  finally {
    mutex.release()
  }

  if (waiter)
    waiter(slot)
}

async function handleInvalidate(
  key: string,
  entry: ChatPoolEntry,
  mutex: Mutex,
  slot: ChatSlot,
  createChat: () => Promise<string>,
) {
  let waiter: ((slot: ChatSlot) => void) | undefined

  await mutex.acquire()
  try {
    const index = entry.slots.findIndex(candidate => candidate.slotId === slot.slotId)
    if (index !== -1)
      entry.slots.splice(index, 1)

    const shouldDeleteEntry = entry.slots.length === 0 && entry.waiters.length === 0 && entry.pendingProvisionCount === 0

    if (shouldDeleteEntry) {
      chatPool.delete(key)
      scheduleDeleteEntries([key])
    }
    else {
      schedulePersistEntry(key, entry)
    }

    if (entry.waiters.length > 0)
      waiter = entry.waiters.shift()
  }
  finally {
    mutex.release()
  }

  if (waiter)
    await fulfillWaiterWithNewSlot(key, entry, mutex, createChat, waiter)
}

export interface GenAIChatLease {
  chatGuid: string
  parentMessageGuid: string | null
  pendingMessageGuid: string | null
  setParentMessageGuid: (guid: string | null) => void
  setPendingMessageGuid: (guid: string | null) => void
  release: () => Promise<void>
  invalidate: () => Promise<void>
}

export async function acquireGenAIChat(
  providerConfig: GenAIProviderConfig,
  baseURL: string,
  purpose: GenAIChatPurpose,
  createChat: () => Promise<string>,
): Promise<GenAIChatLease> {
  await ensureHydrated()
  const key = getPoolKey(providerConfig, purpose, baseURL)
  pruneExpiredEntries(Date.now())
  const mutex = getMutex(key)
  const entry = getOrCreateEntry(key)

  const slot = await reserveSlot(key, entry, mutex, createChat)
  const parentMessageGuid = slot.parentMessageGuid
  const pendingMessageGuid = slot.pendingMessageGuid

  let released = false
  let slotRemoved = false

  const setParentMessageGuid = (guid: string | null) => {
    if (slotRemoved)
      return
    slot.parentMessageGuid = guid ?? null
    schedulePersistEntry(key, entry)
  }

  const setPendingMessageGuid = (guid: string | null) => {
    if (slotRemoved)
      return
    slot.pendingMessageGuid = guid ?? null
    slot.pendingSince = guid ? Date.now() : null
    schedulePersistEntry(key, entry)
  }

  const release = async () => {
    if (released || slotRemoved)
      return
    released = true
    await handleRelease(key, entry, mutex, slot)
  }

  const invalidate = async () => {
    if (slotRemoved)
      return
    slotRemoved = true
    released = true
    await handleInvalidate(key, entry, mutex, slot, entry.createChatFactory ?? createChat)
  }

  return {
    chatGuid: slot.chatGuid,
    parentMessageGuid,
    pendingMessageGuid,
    setParentMessageGuid,
    setPendingMessageGuid,
    release,
    invalidate,
  }
}

export async function scaleGenAIChatPool(
  providerConfig: GenAIProviderConfig,
  baseURL: string,
  purpose: GenAIChatPurpose,
  desiredSlots: number,
  createChat: () => Promise<string>,
): Promise<void> {
  if (desiredSlots <= 0)
    return

  await ensureHydrated()
  const key = getPoolKey(providerConfig, purpose, baseURL)
  pruneExpiredEntries(Date.now())
  const mutex = getMutex(key)
  const entry = getOrCreateEntry(key)

  await mutex.acquire()
  entry.createChatFactory = createChat
  const normalizedDesired = Math.min(desiredSlots, GENAI_CHAT_MAX_SLOTS_PER_KEY)
  const existingCount = entry.slots.length + entry.pendingProvisionCount
  const needed = Math.max(normalizedDesired - existingCount, 0)
  mutex.release()

  if (needed === 0)
    return

  for (let i = 0; i < needed; i++) {
    try {
      const slot = await provisionSlot(key, entry, mutex, createChat)
      logger.info('[GenAI] Warmed idle chat slot', { key, chatGuid: slot.chatGuid, desiredSlots: normalizedDesired, slotCount: entry.slots.length })
    }
    catch (error) {
      logger.warn('[GenAI] Failed to warm chat slot', { key, error })
      break
    }
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
