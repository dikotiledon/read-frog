export type PerfSurface = 'popup' | 'floating-button' | 'content' | 'background' | 'options' | 'unknown'

export interface PerfSamplePayload {
  label: string
  stage: string
  deltaMs: number
  totalMs: number
  surface?: PerfSurface | string
  mode?: string
  url?: string
}

export interface PerfSampleMessage extends PerfSamplePayload {
  key: string
  createdAt: string
}

export interface PerfSampleDTO extends PerfSamplePayload {
  key: string
  createdAt: string
}
