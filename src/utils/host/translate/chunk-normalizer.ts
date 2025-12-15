import { normalizeHtmlForTranslation } from '@/utils/content/utils'

export interface PreparedChunkText {
  rawText: string
  normalizedText: string
  rawChars: number
  cleanChars: number
  strippedMarkup: boolean
}

export function prepareChunkText(rawText: string): PreparedChunkText {
  const { text, stripped } = normalizeHtmlForTranslation(rawText)
  return {
    rawText,
    normalizedText: text,
    rawChars: rawText.length,
    cleanChars: text.length,
    strippedMarkup: stripped,
  }
}
