import { afterEach, describe, expect, it, vi } from 'vitest'
import { __private__ } from '../client'

const { readEventStream, parseGuidsFromRawSSE, waitForMessageContent } = __private__

function createSSEStream(data: string) {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(data)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
    },
  })
}

describe('readEventStream', () => {
  it('handles CRLF-delimited SSE chunks', async () => {
    const response = createSSEStream('data: {"guid":"abc","event_status":"FINAL_ANSWER"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('treats success status as completion even when event_status is non-terminal', async () => {
    const response = createSSEStream('data: {"guid":"abc","event_status":"CHUNK","status":"SUCCESS"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('joins multiple data lines in a single SSE event', async () => {
    const response = createSSEStream('data: {"guid":"abc",\r\ndata: "status":"SUCCESS"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('falls back to response_code completion when status is missing', async () => {
    const response = createSSEStream('data: {"guid":"abc","response_code":"R20000"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('parses final chunk even without trailing blank line', async () => {
    const response = createSSEStream('data: {"guid":"abc","status":"SUCCESS"}')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('handles Samsung stream sample with repeated guid chunks', async () => {
    const guid = '019acbd7-d9b6-74c0-96ba-85ecc2bf7317'
    const sample = [
      `data: {"guid":"${guid}","event_status":"THINK","status":"SUCCESS"}`,
      '',
      `data: {"guid":"${guid}","event_status":"CHUNK","status":"SUCCESS"}`,
      '',
      `data: {"guid":"${guid}","event_status":"CHUNK","response_code":"R20000"}`,
      '',
    ].join('\r\n')

    const response = createSSEStream(sample)
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: guid })
  })

  it('supports camelCase guid fields', async () => {
    const response = createSSEStream('data: {"messageGuid":"abc","event_status":"SUCCESS"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('treats FINAL_ANSWER in processing_content as completion', async () => {
    const response = createSSEStream('data: {"guid":"abc","processing_content":[{"event_status":"FINAL_ANSWER"}],"event_status":"CHUNK"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('treats camelCase status fields as completion', async () => {
    const response = createSSEStream('data: {"guid":"abc","eventStatus":"SUCCESS"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('falls back to regex heuristics when SSE payload is invalid JSON', async () => {
    const response = createSSEStream('data: {"guid":"abc",,,"event_status":"FINAL_ANSWER"}\r\n\r\n')
    await expect(readEventStream(response)).resolves.toMatchObject({ responseGuid: 'abc' })
  })

  it('collects fallback content from stream chunks', async () => {
    const response = createSSEStream([
      'data: {"guid":"abc","event_status":"CHUNK","content":"hello"}',
      '',
      'data: {"guid":"abc","event_status":"CHUNK","response_code":"R20000","content":""}',
      '',
    ].join('\r\n'))

    await expect(readEventStream(response)).resolves.toEqual({
      responseGuid: 'abc',
      fallbackContent: 'hello',
    })
  })
})

describe('parseGuidsFromRawSSE', () => {
  it('extracts completed guid from multi-event raw stream text', () => {
    const guid = '019ad81a-155b-759d-9c87-b97fc98f5bb3'
    const raw = [
      `data: {"guid":"${guid}","event_status":"THINK"}`,
      '',
      `data: {"guid":"${guid}","processing_content":[{"event_status":"FINAL_ANSWER"}],"event_status":"REQUEST_ANALYSIS"}`,
      '',
      `data: {"guid":"${guid}","response_code":"R20000","status":"SUCCESS"}`,
      '',
    ].join('\n')

    const result = parseGuidsFromRawSSE(raw)
    expect(result.completedGuid).toBe(guid)
  })

  it('returns latest guid when only regex heuristics succeed', () => {
    const raw = 'data: {"guid":"abc",,,"status":"SUCCESS"}\n\n'
    const result = parseGuidsFromRawSSE(raw)
    expect(result.latestGuid).toBe('abc')
    expect(result.completedGuid).toBe('abc')
  })
})

describe('waitForMessageContent', () => {
  const baseURL = 'https://example.com'
  const guid = 'response-guid'

  const createJsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const createNotFoundResponse = () =>
    new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'application/json' },
    })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('polls until content is available', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      createJsonResponse({ content: '', status: 'PROCESS' }),
    ).mockResolvedValueOnce(
      createJsonResponse({ content: 'ready', status: 'SUCCESS' }),
    )

    const content = await waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 100,
    })

    expect(content).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('times out when content never arrives', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({ content: '', status: 'PROCESS' }),
    )

    await expect(waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 0,
    })).rejects.toThrow('[GenAI] Timed out waiting for response content')
  })

  it('throws when a failure status is returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({ content: '', status: 'FAIL' }),
    )

    await expect(waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
    })).rejects.toThrow('[GenAI] Response failed with status FAIL')
  })

  it('returns fallback when status is success but content empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({ content: '', status: 'SUCCESS' }),
    )

    const content = await waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
      fallbackContent: '嗨',
    })

    expect(content).toBe('嗨')
  })

  it('returns fallback after timeout when content never arrives', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      createJsonResponse({ content: '', status: 'PROCESS' }),
    )

    const content = await waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
      pollIntervalMs: 0,
      timeoutMs: 0,
      fallbackContent: 'cached',
    })

    expect(content).toBe('cached')
  })

  it('backs off polling delays to avoid spamming requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(createJsonResponse({ content: '', status: 'PROCESS' }))
    fetchMock.mockResolvedValueOnce(createJsonResponse({ content: '', status: 'PROCESS' }))
    fetchMock.mockResolvedValueOnce(createJsonResponse({ content: '', status: 'PROCESS' }))
    fetchMock.mockResolvedValueOnce(createJsonResponse({ content: 'done', status: 'SUCCESS' }))

    const sleepSpy = vi.fn().mockResolvedValue(undefined)

    const content = await waitForMessageContent(baseURL, guid, {
      sleep: sleepSpy,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    })

    expect(content).toBe('done')
    expect(sleepSpy).toHaveBeenCalledTimes(3)
    expect(sleepSpy.mock.calls.map(call => call[0])).toEqual([10, 20, 30])
  })

  it('returns fallback immediately when the message has been deleted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(createNotFoundResponse())
    const sleepSpy = vi.fn()
    const invalidateSpy = vi.fn()

    const content = await waitForMessageContent(baseURL, guid, {
      sleep: sleepSpy,
      fallbackContent: 'streamed',
      onInvalidateChat: invalidateSpy,
    })

    expect(content).toBe('streamed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepSpy).not.toHaveBeenCalled()
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('throws descriptive error when the message no longer exists and no fallback is available', async () => {
    const invalidateSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(createNotFoundResponse())

    await expect(waitForMessageContent(baseURL, guid, {
      sleep: async () => {},
      onInvalidateChat: invalidateSpy,
    })).rejects.toThrow(`[GenAI] Response ${guid} is no longer available (HTTP 404)`)

    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })
})
