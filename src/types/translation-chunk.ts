import type { TranslationMode } from '@/types/config/translate'

export interface TranslationChunkMetadata {
  groupId?: string
  index?: number
  total?: number
  rawChars?: number
  cleanChars?: number
  strippedMarkup?: boolean
}

export interface TranslationChunkMetrics {
  rawChars: number
  cleanChars: number
  strippedMarkup: boolean
  latencyMs: number
  completedAt: string
  providerId?: string
  hostname?: string | null
  mode?: TranslationMode
}

export interface ChunkMetricSampleDTO extends TranslationChunkMetrics {
  key: string
}

export interface ChunkMetricProviderBreakdown {
  providerId: string
  count: number
  avgLatencyMs?: number
}

export interface ChunkMetricSummaryDTO {
  total: number
  avgLatencyMs?: number
  p95LatencyMs?: number
  avgRawChars?: number
  avgCleanChars?: number
  strippedRatio?: number
  providerBreakdown: ChunkMetricProviderBreakdown[]
  recentSamples: ChunkMetricSampleDTO[]
  hostname?: string | null
  mode?: TranslationMode
}
