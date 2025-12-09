export const GENAI_DEFAULT_BASE_URL = 'https://genai.sec.samsung.net'

export const GENAI_ENDPOINTS = {
  session: '/api/account/auth/session',
  chats: '/api/chat/v1/chats',
  messages: '/api/chat/v1/messages',
  messagesResponse: '/api/chat/v1/messages-response',
  messagesResponseCancel: '/api/chat/v1/messages-response/cancel',
  message: (guid: string) => `/api/chat/v1/messages/${guid}`,
} as const

export const GENAI_DEFAULT_MODEL_TITLE = 'GPT-OSS'
export const GENAI_DEFAULT_MODEL_GUID = '0198f11e-ceab-71c3-8fb1-d077d6331843'

export const GENAI_LOGIN_TIMEOUT_MS = 2 * 60 * 1000
export const GENAI_SESSION_RETRY_INTERVAL_MS = 10000
export const GENAI_STREAM_COMPLETE_EVENTS = ['FINAL_ANSWER', 'SUCCESS'] as const
export const GENAI_MESSAGE_POLL_INTERVAL_MS = 13000
export const GENAI_MESSAGE_POLL_TIMEOUT_MS = 60000
export const GENAI_MESSAGE_POLL_MAX_BACKOFF_MULTIPLIER = 6
export const GENAI_CHAT_IDLE_TTL_MS = 120_000
export const GENAI_CHAT_MAX_SLOTS_PER_KEY = 6
