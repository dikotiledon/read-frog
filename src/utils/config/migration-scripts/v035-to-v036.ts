import { DEFAULT_BATCH_CONFIG } from '@/utils/constants/translate'

const PREVIOUS_DEFAULT_MAX_CHARACTERS = 1000

export function migrate(oldConfig: any): any {
  const previousBatchConfig = oldConfig.translate?.batchQueueConfig ?? {}
  const previousMaxCharacters: number | undefined = previousBatchConfig.maxCharactersPerBatch
  const shouldOverride = typeof previousMaxCharacters !== 'number' || previousMaxCharacters === PREVIOUS_DEFAULT_MAX_CHARACTERS

  return {
    ...oldConfig,
    translate: {
      ...oldConfig.translate,
      batchQueueConfig: {
        ...previousBatchConfig,
        maxCharactersPerBatch: shouldOverride
          ? DEFAULT_BATCH_CONFIG.maxCharactersPerBatch
          : previousMaxCharacters,
      },
    },
  }
}
