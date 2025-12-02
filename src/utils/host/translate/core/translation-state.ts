import { MARK_ATTRIBUTES } from '../../../constants/dom-labels'

// State management for translation operations
export const translatingNodes = new WeakSet<ChildNode>()
export const originalContentMap = new Map<Element, string>()
const translationAbortControllers = new WeakMap<HTMLElement, AbortController>()

// Pre-compiled regex for better performance - removes all mark attributes
export const MARK_ATTRIBUTES_REGEX = new RegExp(`\\s*(?:${Array.from(MARK_ATTRIBUTES).join('|')})(?:=['"'][^'"']*['"']|=[^\\s>]*)?`, 'g')

export function registerTranslationAbortController(wrapper: HTMLElement, controller: AbortController): void {
  translationAbortControllers.set(wrapper, controller)
}

export function abortTranslationForWrapper(wrapper: HTMLElement, reason: string = 'Translation aborted'): void {
  const controller = translationAbortControllers.get(wrapper)
  if (controller) {
    controller.abort(new DOMException(reason, 'AbortError'))
    translationAbortControllers.delete(wrapper)
  }
}

export function clearTranslationAbortController(wrapper: HTMLElement): void {
  translationAbortControllers.delete(wrapper)
}
