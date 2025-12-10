import { logger } from '@/utils/logger'

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function')
    return performance.now()
  return Date.now()
}

export class PerfTimer {
  private origin = now()
  private last = this.origin

  constructor(private readonly label: string) {}

  step(stage: string, extra?: Record<string, unknown>) {
    const current = now()
    const delta = current - this.last
    const total = current - this.origin
    this.last = current

    logger.info('[Perf]', {
      label: this.label,
      stage,
      deltaMs: Number(delta.toFixed(2)),
      totalMs: Number(total.toFixed(2)),
      ...extra,
    })
  }
}

export function createPerfTimer(label: string): PerfTimer {
  return new PerfTimer(label)
}
