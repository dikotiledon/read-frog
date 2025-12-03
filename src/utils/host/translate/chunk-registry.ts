import type { TranslationChunkMetadata } from '@/types/translation-chunk'

interface ChunkState {
  totalTargets: number
  emittedCount: number
  seenElements: WeakSet<Element>
}

const chunkRegistry = new Map<string, ChunkState>()

function getChunkState(walkId: string): ChunkState {
  let state = chunkRegistry.get(walkId)
  if (!state) {
    state = {
      totalTargets: 0,
      emittedCount: 0,
      seenElements: new WeakSet<Element>(),
    }
    chunkRegistry.set(walkId, state)
  }
  return state
}

export function recordChunkTargets(walkId: string | null, elements: Iterable<Element>): void {
  if (!walkId)
    return
  const state = getChunkState(walkId)
  for (const element of elements) {
    if (!state.seenElements.has(element)) {
      state.seenElements.add(element)
      state.totalTargets += 1
    }
  }
}

export function nextChunkMetadata(walkId: string | null): TranslationChunkMetadata | undefined {
  if (!walkId)
    return undefined
  const state = getChunkState(walkId)
  state.emittedCount += 1
  const metadata: TranslationChunkMetadata = {
    groupId: walkId,
    index: state.emittedCount,
    total: state.totalTargets > 0 ? Math.max(state.totalTargets, state.emittedCount) : undefined,
  }
  return metadata
}

export function clearChunkRegistry(walkId?: string | null): void {
  if (typeof walkId === 'string') {
    chunkRegistry.delete(walkId)
    return
  }
  chunkRegistry.clear()
}
