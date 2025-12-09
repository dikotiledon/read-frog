import { logger } from '@/utils/logger'

export type GenAICancelHandler = (reason?: unknown) => Promise<void> | void

const activeGenAIRequests = new Map<string, GenAICancelHandler>()

export function registerActiveGenAIRequest(clientRequestId: string, handler: GenAICancelHandler): () => void {
  if (!clientRequestId)
    return () => {}

  activeGenAIRequests.set(clientRequestId, handler)

  return () => {
    const current = activeGenAIRequests.get(clientRequestId)
    if (current === handler)
      activeGenAIRequests.delete(clientRequestId)
  }
}

export async function cancelActiveGenAIRequest(clientRequestId: string, reason?: string): Promise<boolean> {
  const handler = activeGenAIRequests.get(clientRequestId)
  if (!handler)
    return false

  activeGenAIRequests.delete(clientRequestId)

  try {
    await handler(reason)
    return true
  }
  catch (error) {
    logger.warn('[GenAI] Failed to cancel active request', {
      clientRequestId,
      reason,
      error,
    })
    throw error
  }
}

export function clearActiveGenAIRequestsForTest() {
  activeGenAIRequests.clear()
}
