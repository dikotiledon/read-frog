import type { ArticleContent } from '@/types/content'
import type { TranslationChunkMetadata } from '@/types/translation-chunk'
import { getConfigFromStorage } from '@/utils/config/config'
import { DEFAULT_CONFIG } from '../constants/config'
import { DEFAULT_BATCH_TRANSLATE_PROMPT, DEFAULT_TRANSLATE_PROMPT, DEFAULT_TRANSLATE_SYSTEM_PROMPT, getTokenCellText, INPUT, SUMMARY, TARGET_LANG, TITLE } from '../constants/prompt'

export interface TranslatePromptOptions {
  isBatch?: boolean
  content?: ArticleContent
  chunkMetadata?: TranslationChunkMetadata
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

  if (options?.chunkMetadata && (typeof options.chunkMetadata.index === 'number' || typeof options.chunkMetadata.total === 'number' || options.chunkMetadata.groupId)) {
    const indexPart = typeof options.chunkMetadata.index === 'number'
      ? `part ${options.chunkMetadata.index}${typeof options.chunkMetadata.total === 'number' ? ` of ${options.chunkMetadata.total}` : ''}`
      : null
    const totalOnlyPart = !indexPart && typeof options.chunkMetadata.total === 'number'
      ? `one of ${options.chunkMetadata.total} parts`
      : null
    const groupPart = options.chunkMetadata.groupId ? `document id ${options.chunkMetadata.groupId}` : null
    const chunkDescriptor = [indexPart, totalOnlyPart, groupPart].filter(Boolean).join(', ')
    const chunkContext = chunkDescriptor || 'one segment of a larger document'
    const chunkPrompt = `Chunk context: You are translating ${chunkContext}. Maintain consistent tone, terminology, and formatting with the other segments even if you only see this snippet. Do not mention chunk numbers or metadata in the output.`
    systemPrompt = `${systemPrompt}\n\n${chunkPrompt}`.trim()
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
