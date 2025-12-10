import type { GenAIProviderConfig } from '@/types/config/provider'
import type { GenAIModelTelemetryType } from '@/utils/db/dexie/tables/genai-reliability-log'
import { db } from '@/utils/db/dexie/db'
import { logger } from '@/utils/logger'

export type GenAIReliabilityEvent
  = | ({ type: 'batch-retry', retryCount: number } & BaseReliabilityEventFields)
    | ({ type: 'batch-fallback', durationMs: number } & BaseReliabilityEventFields)
    | ({ type: 'messages-response-cancel', success: boolean } & BaseReliabilityEventFields)

interface BaseReliabilityEventFields {
  providerId: string
  modelType: GenAIModelTelemetryType
  model?: string | null
  responseCode?: string | null
  reason?: string | null
  metadata?: Record<string, unknown> | null
}

export function resolveGenAIModelName(providerConfig: GenAIProviderConfig, modelType: GenAIModelTelemetryType): string | null {
  const modelConfig = providerConfig.models[modelType]
  if (!modelConfig)
    return null
  const value = modelConfig.isCustomModel ? modelConfig.customModel : modelConfig.model
  return value ?? null
}

export async function logGenAIReliabilityEvent(event: GenAIReliabilityEvent): Promise<void> {
  try {
    await db.genaiReliabilityLog.put({
      key: crypto.randomUUID(),
      createdAt: new Date(),
      eventType: event.type,
      providerId: event.providerId,
      modelType: event.modelType,
      model: event.model ?? '',
      responseCode: event.responseCode ?? null,
      reason: event.reason ?? null,
      retryCount: event.type === 'batch-retry' ? event.retryCount : null,
      durationMs: event.type === 'batch-fallback' ? event.durationMs : null,
      metadata: event.metadata ?? null,
    })
  }
  catch (error) {
    logger.warn('[GenAI] Failed to log reliability event', error)
  }
}
