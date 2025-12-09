import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { getConfigFromStorage } from '@/utils/config/config'
import { DEFAULT_CONFIG } from '../constants/config'
import { DEFAULT_BATCH_TRANSLATE_PROMPT, DEFAULT_TRANSLATE_PROMPT, DEFAULT_TRANSLATE_SYSTEM_PROMPT, getTokenCellText, INPUT, SUMMARY, TARGET_LANG, TITLE } from '../constants/prompt'

export interface TranslatePromptOptions {
  isBatch?: boolean
  content?: ArticleContent
  chunkMetadata?: TranslationChunkMetadata
  chunkMetadataList?: Array<TranslationChunkMetadata | undefined>
}

export interface TranslatePromptResult {
  systemPrompt: string
  prompt: string
}

export async function getTranslatePrompt(
  targetLang: string,
  input: string,
  options?: TranslatePromptOptions,
): Promise<TranslatePromptResult> {
  const config = await getConfigFromStorage() ?? DEFAULT_CONFIG
  const customPromptsConfig = config.translate.customPromptsConfig
  const { patterns = [], promptId } = customPromptsConfig

  // Resolve system prompt and user prompt
  let systemPrompt: string
  let prompt: string

  if (!promptId) {
    // Use default prompts from constants
    systemPrompt = DEFAULT_TRANSLATE_SYSTEM_PROMPT
    prompt = DEFAULT_TRANSLATE_PROMPT
  }
  else {
    // Find custom prompt, fallback to default
    const customPrompt = patterns.find(pattern => pattern.id === promptId)
    systemPrompt = customPrompt?.systemPrompt ?? DEFAULT_TRANSLATE_SYSTEM_PROMPT
    prompt = customPrompt?.prompt ?? DEFAULT_TRANSLATE_PROMPT
  }

  // For batch mode, append batch rules to system prompt
  if (options?.isBatch) {
    systemPrompt = `${systemPrompt}

${DEFAULT_BATCH_TRANSLATE_PROMPT}`
  }

  // Build title and summary replacement values
  const title = options?.content?.title || 'No title available'
  const summary = options?.content?.summary || 'No summary available'

  const buildChunkDescriptor = (metadata?: TranslationChunkMetadata | null): string | null => {
    if (!metadata)
      return null

    const indexPart = typeof metadata.index === 'number'
      ? `part ${metadata.index}${typeof metadata.total === 'number' ? ` of ${metadata.total}` : ''}`
      : null
    const totalOnlyPart = !indexPart && typeof metadata.total === 'number'
      ? `one of ${metadata.total} parts`
      : null
    const groupPart = metadata.groupId ? `document id ${metadata.groupId}` : null
    const chunkDescriptor = [indexPart, totalOnlyPart, groupPart].filter(Boolean).join(', ')
    return chunkDescriptor || null
  }

  const singleChunkDescriptor = buildChunkDescriptor(options?.chunkMetadata)
  if (singleChunkDescriptor) {
    const chunkContext = `Chunk context: You are translating ${singleChunkDescriptor}. Maintain consistent tone, terminology, and formatting with the other segments even if you only see this snippet. Do not mention chunk numbers or metadata in the output.`
    systemPrompt = `${systemPrompt}\n\n${chunkContext}`.trim()
  }

  if (options?.chunkMetadataList?.length) {
    const descriptors = options.chunkMetadataList.map((metadata, index) => {
      const descriptor = buildChunkDescriptor(metadata)
      if (descriptor)
        return `${index + 1}. ${descriptor}`
      return `${index + 1}. general segment (no additional metadata provided)`
    })
    const chunkListPrompt = `Chunk contexts for batched translation (same order as the input segments):\n${descriptors.join('\n')}\nApply these contexts silently. Maintain consistent tone, terminology, and formatting, and do not mention chunk numbers or metadata in the output.`
    systemPrompt = `${systemPrompt}\n\n${chunkListPrompt}`.trim()
  }

  // Replace tokens in both prompts
  const replaceTokens = (text: string) =>
    text
      .replaceAll(getTokenCellText(TARGET_LANG), targetLang)
      .replaceAll(getTokenCellText(INPUT), input)
      .replaceAll(getTokenCellText(TITLE), title)
      .replaceAll(getTokenCellText(SUMMARY), summary)

  return {
    systemPrompt: replaceTokens(systemPrompt),
    prompt: replaceTokens(prompt),
  }
}
