import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@/utils/constants/config'
import { executeTranslate } from '@/utils/host/translate/execute-translate'
import { translateText } from '@/utils/host/translate/translate-text'

// Mock dependencies
vi.mock('@/utils/config/config', () => ({
  getConfigFromStorage: vi.fn(),
}))

vi.mock('@/utils/message', () => ({
  sendMessage: vi.fn(),
}))

vi.mock('@/utils/host/translate/core/genai-batch-controller', () => ({
  getGenAIBatchController: vi.fn(),
}))

vi.mock('@/utils/host/translate/api/microsoft', () => ({
  microsoftTranslate: vi.fn(),
}))

vi.mock('@/utils/prompts/translate', () => ({
  getTranslatePrompt: vi.fn(),
}))

let mockSendMessage: any
let mockMicrosoftTranslate: any
let mockGetConfigFromStorage: any
let mockGetTranslatePrompt: any
let mockGetGenAIBatchController: any
let mockCancelChunk: any

describe('translate-text', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockSendMessage = vi.mocked((await import('@/utils/message')).sendMessage)
    mockMicrosoftTranslate = vi.mocked((await import('@/utils/host/translate/api/microsoft')).microsoftTranslate)
    mockGetConfigFromStorage = vi.mocked((await import('@/utils/config/config')).getConfigFromStorage)
    mockGetTranslatePrompt = vi.mocked((await import('@/utils/prompts/translate')).getTranslatePrompt)
    mockGetGenAIBatchController = vi.mocked((await import('@/utils/host/translate/core/genai-batch-controller')).getGenAIBatchController)
    mockCancelChunk = vi.fn()
    mockGetGenAIBatchController.mockReturnValue({
      enqueue: vi.fn().mockResolvedValue('batch translation default'),
      cancelChunk: mockCancelChunk,
    })

    // Mock getConfigFromStorage to return DEFAULT_CONFIG
    mockGetConfigFromStorage.mockResolvedValue(DEFAULT_CONFIG)

    // Mock getTranslatePrompt to return a simple prompt
    mockGetTranslatePrompt.mockResolvedValue('Translate to {{targetLang}}: {{input}}')
  })

  describe('translateText', () => {
    it('should send message with correct parameters', async () => {
      mockGetConfigFromStorage.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        translate: {
          ...DEFAULT_CONFIG.translate,
          providerId: 'microsoft-default',
        },
      })
      mockSendMessage.mockResolvedValue('translated text')

      const result = await translateText('test text')

      expect(result).toBe('translated text')
      expect(mockSendMessage).toHaveBeenCalledWith('enqueueTranslateRequest', expect.objectContaining({
        text: 'test text',
        langConfig: DEFAULT_CONFIG.language,
        providerConfig: expect.any(Object),
        scheduleAt: expect.any(Number),
        hash: expect.any(String),
        clientRequestId: expect.any(String),
      }))
    })

    it('uses GenAI batch controller when flag is enabled', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue('batch translation')
      mockGetGenAIBatchController.mockReturnValue({ enqueue: mockEnqueue, cancelChunk: vi.fn() })

      const result = await translateText('batched text')

      expect(result).toBe('batch translation')
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        text: 'batched text',
        batchQueueConfig: DEFAULT_CONFIG.translate.batchQueueConfig,
      }))
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it('falls back to single request when GenAI batching is disabled', async () => {
      mockGetConfigFromStorage.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        translate: {
          ...DEFAULT_CONFIG.translate,
          useGenAIBatching: false,
        },
      })
      mockSendMessage.mockResolvedValue('legacy translation')

      const result = await translateText('fallback text')

      expect(result).toBe('legacy translation')
      expect(mockGetGenAIBatchController).not.toHaveBeenCalled()
      expect(mockSendMessage).toHaveBeenCalledWith('enqueueTranslateRequest', expect.objectContaining({
        text: 'fallback text',
      }))
    })

    it('uses provided pre-normalized text and metadata', async () => {
      mockGetConfigFromStorage.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        translate: {
          ...DEFAULT_CONFIG.translate,
          providerId: 'microsoft-default',
        },
      })
      mockSendMessage.mockResolvedValue('pre-normalized translation')

      const result = await translateText('<strong>Chunk</strong>', {
        preNormalized: {
          text: '**Chunk**',
          stripped: true,
          rawChars: 18,
          cleanChars: 8,
        },
        chunkMetadata: {
          groupId: 'walk',
          index: 1,
        },
      })

      expect(result).toBe('pre-normalized translation')
      expect(mockSendMessage).toHaveBeenCalledWith('enqueueTranslateRequest', expect.objectContaining({
        text: '**Chunk**',
        chunkMetadata: expect.objectContaining({
          rawChars: 18,
          cleanChars: 8,
          strippedMarkup: true,
        }),
      }))
    })

    it('forwards abort signal to GenAI batch controller', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue('sig translation')
      const mockController = { enqueue: mockEnqueue, cancelChunk: vi.fn() }
      mockGetGenAIBatchController.mockReturnValue(mockController)

      const abortController = new AbortController()
      await translateText('signal text', { signal: abortController.signal })

      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        text: 'signal text',
        signal: abortController.signal,
      }))
    })
  })

  describe('executeTranslate', () => {
    const langConfig = {
      sourceCode: 'eng' as const,
      targetCode: 'cmn' as const,
      detectedCode: 'eng' as const,
      level: 'intermediate' as const,
    }

    const providerConfig = {
      id: 'microsoft-default',
      enabled: true,
      name: 'Microsoft Translator',
      provider: 'microsoft' as const,
    }

    it('should return empty string for empty/whitespace input', async () => {
      expect(await executeTranslate('', langConfig, providerConfig)).toBe('')
      expect(await executeTranslate(' ', langConfig, providerConfig)).toBe('')
      expect(await executeTranslate('\n', langConfig, providerConfig)).toBe('')
      expect(await executeTranslate(' \n ', langConfig, providerConfig)).toBe('')
      expect(await executeTranslate(' \n \t', langConfig, providerConfig)).toBe('')
    })

    it('should handle zero-width spaces correctly', async () => {
      // Only zero-width spaces should return empty
      expect(await executeTranslate('\u200B\u200B', langConfig, providerConfig)).toBe('')

      // Mixed invisible + whitespace should return empty
      expect(await executeTranslate('\u200B \u200B', langConfig, providerConfig)).toBe('')

      // Should translate valid content after removing zero-width spaces
      mockMicrosoftTranslate.mockResolvedValue('你好')
      const result = await executeTranslate('\u200B hello \u200B', langConfig, providerConfig)
      expect(result).toBe('你好')
      // Microsoft translate should receive the original text
      expect(mockMicrosoftTranslate).toHaveBeenCalledWith('\u200B hello \u200B', 'en', 'zh')
    })

    it('should trim translation result', async () => {
      mockMicrosoftTranslate.mockResolvedValue('  测试结果  ')

      const result = await executeTranslate('test input', langConfig, providerConfig)

      expect(result).toBe('测试结果')
    })
  })
})
