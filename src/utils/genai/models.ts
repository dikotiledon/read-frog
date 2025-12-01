import type { TranslateLLMModels, ReadModels } from '@/types/config/provider'
import { GENAI_DEFAULT_MODEL_GUID, GENAI_DEFAULT_MODEL_TITLE } from './constants'

export const GENAI_MODEL_GUIDS: Record<string, { guid: string }> = {
  [GENAI_DEFAULT_MODEL_TITLE]: {
    guid: GENAI_DEFAULT_MODEL_GUID,
  },
}

export function resolveGenAIModelGuid(modelName: string | null | undefined): string {
  if (!modelName) {
    return GENAI_DEFAULT_MODEL_GUID
  }

  return GENAI_MODEL_GUIDS[modelName]?.guid ?? GENAI_DEFAULT_MODEL_GUID
}

export const GENAI_DEFAULT_READ_MODEL: ReadModels['genai'] = {
  model: GENAI_DEFAULT_MODEL_TITLE,
  isCustomModel: false,
  customModel: null,
}

export const GENAI_DEFAULT_TRANSLATE_MODEL: TranslateLLMModels['genai'] = {
  model: GENAI_DEFAULT_MODEL_TITLE,
  isCustomModel: false,
  customModel: null,
}
