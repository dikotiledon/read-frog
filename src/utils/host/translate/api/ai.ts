import type { LLMTranslateProviderConfig } from '@/types/config/provider'
import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { generateText } from 'ai'
import { isGenAIProviderConfig } from '@/types/config/provider'
import { getProviderOptions } from '@/utils/constants/model'
import { genaiTranslate } from '@/utils/genai/client'
import { getTranslatePrompt } from '@/utils/prompts/translate'
import { getTranslateModelById } from '@/utils/providers/model'

export interface AITranslateOptions {
  isBatch?: boolean
  content?: ArticleContent
  chunkMetadata?: TranslationChunkMetadata
  chunkMetadataList?: Array<TranslationChunkMetadata | undefined>
  clientRequestId?: string
}

export async function aiTranslate(
  text: string,
  targetLangName: string,
  providerConfig: LLMTranslateProviderConfig,
  options?: AITranslateOptions,
) {
  if (isGenAIProviderConfig(providerConfig))
    return await genaiTranslate(text, targetLangName, providerConfig, options)

  const { id: providerId, models: { translate } } = providerConfig
  const translateModel = translate.isCustomModel ? translate.customModel : translate.model
  const model = await getTranslateModelById(providerId)

  const providerOptions = getProviderOptions(translateModel ?? '')
  const { systemPrompt, prompt } = await getTranslatePrompt(targetLangName, text, options)

  const { text: translatedText } = await generateText({
    model,
    system: systemPrompt,
    prompt,
    providerOptions,
  })

  const [, finalTranslation = translatedText] = translatedText.match(/<\/think>([\s\S]*)/) || []

  return finalTranslation
}
