import { Entity } from 'dexie'

export type GenAIReliabilityEventType = 'batch-retry' | 'batch-fallback' | 'messages-response-cancel'
export type GenAIModelTelemetryType = 'translate' | 'read' | 'general'

export default class GenAIReliabilityLog extends Entity {
  key!: string
  createdAt!: Date
  eventType!: GenAIReliabilityEventType
  providerId!: string
  modelType!: GenAIModelTelemetryType
  model!: string
  responseCode?: string | null
  reason?: string | null
  retryCount?: number | null
  durationMs?: number | null
  metadata?: Record<string, unknown> | null
}
