import type { TranslationChunkMetrics } from '@/types/translation-chunk'
import { Entity } from 'dexie'

export default class TranslationCache extends Entity {
  key!: string
  translation!: string
  createdAt!: Date
  chunkMetrics?: TranslationChunkMetrics | null
}
