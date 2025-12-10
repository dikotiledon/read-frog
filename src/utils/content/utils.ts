import { getConfigFromStorage } from '../config/config'
import { DEFAULT_CONFIG } from '../constants/config'
import { isDontWalkIntoAndDontTranslateAsChildElement, isHTMLElement } from '../host/dom/filter'

export const MAX_TEXT_LENGTH = 3000

export async function removeDummyNodes(root: Document) {
  const elements = root.querySelectorAll('*')
  const config = await getConfigFromStorage() ?? DEFAULT_CONFIG
  elements.forEach((element) => {
    const isDontTranslate = isHTMLElement(element) && isDontWalkIntoAndDontTranslateAsChildElement(element, config)
    if (isDontTranslate) {
      element.remove()
    }
  })
}

/**
 * Clean and truncate article text for post processing
 */
export function cleanText(textContent: string, maxLength: number = MAX_TEXT_LENGTH): string {
  const cleaned = textContent
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零宽字符
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength)
}

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
}

function stripTagsFallback(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, ' ')
  return decodeBasicEntities(withoutTags)
}

const CSS_RULE_REGEX = /(?:^|\s)(?:[#.]?[\w-]+|@media|@supports|@font-face|@keyframes)[^{]+\{[^}]*\}/g

function stripLikelyCss(raw: string): { text: string, stripped: boolean } {
  const withoutRules = raw.replace(CSS_RULE_REGEX, ' ')
  return {
    text: withoutRules,
    stripped: withoutRules !== raw,
  }
}

function textFromHtml(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(html, 'text/html')
      doc.querySelectorAll('script,style,noscript').forEach(node => node.remove())
      return doc.body?.textContent ?? ''
    }
    catch {
      return stripTagsFallback(html)
    }
  }

  return stripTagsFallback(html)
}

/**
 * Normalize raw HTML-ish strings into compact plain text better suited for translation APIs.
 */
export function normalizeHtmlForTranslation(raw: string): { text: string, stripped: boolean } {
  if (!raw)
    return { text: '', stripped: false }

  const looksLikeHtml = /<[^>]+>/.test(raw)
  let stripped = false
  let base = raw

  if (looksLikeHtml) {
    base = textFromHtml(raw)
    stripped = true
  }
  else {
    const cssResult = stripLikelyCss(raw)
    base = cssResult.text
    stripped = cssResult.stripped
  }

  const collapsed = cleanText(base)
  return {
    text: collapsed,
    stripped,
  }
}
