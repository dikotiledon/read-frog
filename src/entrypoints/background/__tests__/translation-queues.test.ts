import { describe, expect, it } from 'vitest'
import { __private__ } from '../translation-queues'

const { classifyGenAIBatchError } = __private__

describe('classifyGenAIBatchError', () => {
  it('marks response code R50004 as recoverable', () => {
    const error = new Error('[GenAI] Response failed with response code R50004')
    const result = classifyGenAIBatchError(error)
    expect(result.recoverable).toBe(true)
    expect(result.reason).toBe('response-code')
    expect(result.code).toBe('R50004')
  })

  it('detects mismatch errors as recoverable', () => {
    const error = new Error('GenAI batch result mismatch: expected 3, got 2')
    const result = classifyGenAIBatchError(error)
    expect(result.recoverable).toBe(true)
    expect(result.reason).toBe('result-mismatch')
  })

  it('matches unexpected token pattern', () => {
    const error = new Error('Unexpected token 200007 in JSON at position 42')
    const result = classifyGenAIBatchError(error)
    expect(result.recoverable).toBe(true)
    expect(result.reason).toBe('message-pattern')
  })

  it('treats unrelated errors as non-recoverable', () => {
    const error = new Error('Network unavailable')
    const result = classifyGenAIBatchError(error)
    expect(result.recoverable).toBe(false)
    expect(result.reason).toBe('unknown')
  })
})
