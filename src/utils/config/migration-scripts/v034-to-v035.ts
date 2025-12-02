import {
  DEFAULT_REQUEST_BASE_RETRY_DELAY_MS,
  DEFAULT_REQUEST_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '@/utils/constants/translate'

/**
 * Migration script from v034 to v035
 * Adds timeout and retry tuning to request queue config
 */
export function migrate(oldConfig: any): any {
  const existingQueueConfig = oldConfig.translate?.requestQueueConfig ?? {}

  return {
    ...oldConfig,
    translate: {
      ...oldConfig.translate,
      requestQueueConfig: {
        ...existingQueueConfig,
        timeoutMs: existingQueueConfig.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetries: existingQueueConfig.maxRetries ?? DEFAULT_REQUEST_MAX_RETRIES,
        baseRetryDelayMs: existingQueueConfig.baseRetryDelayMs ?? DEFAULT_REQUEST_BASE_RETRY_DELAY_MS,
      },
    },
  }
}
