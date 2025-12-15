import { logger } from '@/utils/logger'
import { recordPerfSample } from '@/utils/perf/perf-recorder'

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function')
    return performance.now()
  return Date.now()
}

export class PerfTimer {
  private origin = now()
  private last = this.origin
  private readonly markBase: string
  private lastMarkId?: string
  private measureCount = 0
  private readonly baseMetadata: Record<string, unknown>

  constructor(private readonly label: string, metadata?: Record<string, unknown>) {
    this.markBase = `rf-perf:${label}`
    this.lastMarkId = this.recordMark('start')
    this.baseMetadata = metadata ?? {}
  }

  step(stage: string, extra?: Record<string, unknown>) {
    const current = now()
    const delta = current - this.last
    const total = current - this.origin
    this.last = current

    this.measure(stage)

    const payload = {
      ...this.baseMetadata,
      ...(extra ?? {}),
      label: this.label,
      stage,
      deltaMs: Number(delta.toFixed(2)),
      totalMs: Number(total.toFixed(2)),
    }

    logger.info('[Perf]', payload)
    recordPerfSample(payload)
  }

  private recordMark(stage: string): string | undefined {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function')
      return undefined
    const id = `${this.markBase}:${stage}:${this.measureCount}`
    performance.mark(id)
    return id
  }

  private measure(stage: string) {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function')
      return

    const startMark = this.lastMarkId
    const endMark = this.recordMark(stage)
    if (!startMark || !endMark)
      return

    const measureName = `${this.markBase}:measure:${stage}:${this.measureCount++}`
    try {
      performance.measure(measureName, startMark, endMark)
    }
    catch {
      // Ignore browsers that disallow duplicate marks
    }
    finally {
      if (typeof performance.clearMarks === 'function') {
        performance.clearMarks(startMark)
      }
      if (typeof performance.clearMeasures === 'function') {
        performance.clearMeasures(measureName)
      }
      this.lastMarkId = endMark
    }
  }
}

export function createPerfTimer(label: string, metadata?: Record<string, unknown>): PerfTimer {
  return new PerfTimer(label, metadata)
}
