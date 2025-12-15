import type { EntityTable } from 'dexie'
import { upperCamelCase } from 'case-anything'
import Dexie from 'dexie'
import { APP_NAME } from '@/utils/constants/app'
import ArticleSummaryCache from './tables/article-summary-cache'
import BatchRequestRecord from './tables/batch-request-record'
import GenAIReliabilityLog from './tables/genai-reliability-log'
import PerfSample from './tables/perf-sample'
import TranslationCache from './tables/translation-cache'

export default class AppDB extends Dexie {
  translationCache!: EntityTable<
    TranslationCache,
    'key'
  >

  batchRequestRecord!: EntityTable<
    BatchRequestRecord,
    'key'
  >

  articleSummaryCache!: EntityTable<
    ArticleSummaryCache,
    'key'
  >

  genaiReliabilityLog!: EntityTable<
    GenAIReliabilityLog,
    'key'
  >

  perfSamples!: EntityTable<
    PerfSample,
    'key'
  >

  constructor() {
    super(`${upperCamelCase(APP_NAME)}DB`)
    this.version(1).stores({
      translationCache: `
        key,
        translation,
        createdAt`,
    })
    this.version(2).stores({
      translationCache: `
        key,
        translation,
        createdAt`,
      batchRequestRecord: `
        key,
        createdAt,
        originalRequestCount,
        provider,
        model`,
    })
    this.version(3).stores({
      translationCache: `
        key,
        translation,
        createdAt`,
      batchRequestRecord: `
        key,
        createdAt,
        originalRequestCount,
        provider,
        model`,
      articleSummaryCache: `
        key,
        createdAt`,
    })
    this.version(4).stores({
      translationCache: `
        key,
        translation,
        createdAt`,
      batchRequestRecord: `
        key,
        createdAt,
        originalRequestCount,
        provider,
        model`,
      articleSummaryCache: `
        key,
        createdAt`,
      genaiReliabilityLog: `
        key,
        createdAt,
        eventType,
        providerId,
        responseCode`,
    })
    this.version(5).stores({
      translationCache: `
        key,
        translation,
        createdAt`,
      batchRequestRecord: `
        key,
        createdAt,
        originalRequestCount,
        provider,
        model`,
      articleSummaryCache: `
        key,
        createdAt`,
      genaiReliabilityLog: `
        key,
        createdAt,
        eventType,
        providerId,
        responseCode`,
      perfSamples: `
        key,
        createdAt,
        surface,
        mode,
        url`,
    })
    this.version(6).stores({
      translationCache: `
        key,
        translation,
        createdAt,
        chunkMetrics`,
      batchRequestRecord: `
        key,
        createdAt,
        originalRequestCount,
        provider,
        model`,
      articleSummaryCache: `
        key,
        createdAt`,
      genaiReliabilityLog: `
        key,
        createdAt,
        eventType,
        providerId,
        responseCode`,
      perfSamples: `
        key,
        createdAt,
        surface,
        mode,
        url`,
    }).upgrade(async (tx) => {
      const table = tx.table<TranslationCache>('translationCache')
      await table.toCollection().modify((entry) => {
        if (typeof entry.chunkMetrics === 'undefined')
          entry.chunkMetrics = null
      })
    })
    this.translationCache.mapToClass(TranslationCache)
    this.batchRequestRecord.mapToClass(BatchRequestRecord)
    this.articleSummaryCache.mapToClass(ArticleSummaryCache)
    this.genaiReliabilityLog.mapToClass(GenAIReliabilityLog)
    this.perfSamples.mapToClass(PerfSample)
  }
}
