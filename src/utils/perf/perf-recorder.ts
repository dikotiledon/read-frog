import type { PerfSampleMessage, PerfSamplePayload, PerfSurface } from '@/types/perf'
import { sendMessage } from '@/utils/message'

const PERF_ENABLED = import.meta.env.DEV

function getDefaultSurface(): PerfSurface {
  if (typeof window === 'undefined')
    return 'background'

  if (window.location?.pathname?.includes('popup'))
    return 'popup'

  if (window.location?.pathname?.includes('options'))
    return 'options'

  return 'content'
}

export function recordPerfSample(payload: PerfSamplePayload) {
  if (!PERF_ENABLED)
    return

  const sample: PerfSampleMessage = {
    key: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    surface: payload.surface ?? getDefaultSurface(),
    mode: payload.mode,
    url: payload.url ?? (typeof window !== 'undefined' ? window.location.href : undefined),
    label: payload.label,
    stage: payload.stage,
    deltaMs: payload.deltaMs,
    totalMs: payload.totalMs,
  }

  void sendMessage('recordPerfSample', sample).catch(() => {})
}
