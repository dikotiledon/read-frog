import type { TranslationMode } from '@/types/config/translate'
import type { PerfSampleDTO } from '@/types/perf'
import type { ChunkMetricSampleDTO, ChunkMetricSummaryDTO } from '@/types/translation-chunk'
import { i18n } from '#imports'
import { Icon } from '@iconify/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/shadcn/badge'
import { Button } from '@/components/shadcn/button'
import { configFieldsAtomMap } from '@/utils/atoms/config'
import { sendMessage } from '@/utils/message'
import { cn } from '@/utils/styles/tailwind'

const SAMPLE_LIMIT = 250
const CHUNK_SAMPLE_LIMIT = 400
type CsvValue = string | number | boolean | undefined | null

const EMPTY_CHUNK_SUMMARY: ChunkMetricSummaryDTO = {
  total: 0,
  providerBreakdown: [],
  recentSamples: [],
  hostname: null,
}

interface PerfLabCardProps {
  activeUrl?: string
}

export function PerfLabCard({ activeUrl }: PerfLabCardProps) {
  const translateConfig = useAtomValue(configFieldsAtomMap.translate)
  const queryClient = useQueryClient()
  const [chunkHostFilter, setChunkHostFilter] = useState<'active' | 'all'>('active')
  const [chunkModeFilter, setChunkModeFilter] = useState<'current' | 'all'>('current')

  const { data: samples = [], isFetching } = useQuery({
    queryKey: ['perf-samples', SAMPLE_LIMIT],
    queryFn: async () => sendMessage('listPerfSamples', { limit: SAMPLE_LIMIT }),
    refetchInterval: 4000,
    staleTime: 3000,
  })

  const activeHostname = useMemo(() => safeHostname(activeUrl), [activeUrl])

  useEffect(() => {
    if (chunkHostFilter === 'active' && !activeHostname)
      setChunkHostFilter('all')
  }, [chunkHostFilter, activeHostname])

  const chunkFilters = useMemo(() => {
    const hostname = chunkHostFilter === 'active' ? activeHostname ?? undefined : undefined
    const mode = chunkModeFilter === 'current' ? translateConfig.mode : undefined
    return { hostname, mode }
  }, [chunkHostFilter, chunkModeFilter, activeHostname, translateConfig.mode])

  const chunkFilterKey = `${chunkFilters.hostname ?? 'all-hosts'}|${chunkFilters.mode ?? 'all-modes'}`

  const { data: chunkSummaryData, isFetching: isChunkFetching } = useQuery({
    queryKey: ['chunk-metrics', CHUNK_SAMPLE_LIMIT, chunkFilterKey],
    queryFn: async () => sendMessage('getChunkMetricsSummary', {
      limit: CHUNK_SAMPLE_LIMIT,
      hostname: chunkFilters.hostname,
      mode: chunkFilters.mode,
    }),
    refetchInterval: 4500,
    staleTime: 3500,
  })
  const chunkSummary = chunkSummaryData ?? EMPTY_CHUNK_SUMMARY
  const chunkHostLabel = chunkFilters.hostname ?? 'All hosts'
  const chunkModeLabel = chunkFilters.mode ? formatModeLabel(chunkFilters.mode) : 'All modes'

  const filteredSamples = useMemo(
    () => filterSamples(samples, activeHostname, translateConfig.mode),
    [samples, activeHostname, translateConfig.mode],
  )

  const summary = useMemo(() => summarizeSamples(filteredSamples), [filteredSamples])
  const stageSummaries = useMemo(() => summarizeStages(filteredSamples), [filteredSamples])
  const latestEvents = filteredSamples.slice(0, 6)

  const handleExport = useCallback(() => {
    if (!samples.length) {
      toast.info('Perf Lab: nothing to export yet.')
      return
    }

    try {
      const payload = JSON.stringify(samples, null, 2)
      const blob = new Blob([payload], { type: 'application/json' })
      const blobUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = blobUrl
      anchor.download = `perf-samples-${Date.now()}.json`
      anchor.click()
      URL.revokeObjectURL(blobUrl)
      toast.success('Perf samples exported')
    }
    catch (error) {
      toast.error('Failed to export perf samples')
      console.warn('[PerfLab] export failed', error)
    }
  }, [samples])

  const handleReset = useCallback(async () => {
    try {
      await sendMessage('clearPerfSamples')
      await queryClient.invalidateQueries({ queryKey: ['perf-samples', SAMPLE_LIMIT] })
      toast.success('Perf samples cleared')
    }
    catch (error) {
      toast.error('Unable to clear perf samples')
      console.warn('[PerfLab] clear failed', error)
    }
  }, [queryClient])

  const handleChunkExport = useCallback(() => {
    if (!chunkSummary.total) {
      toast.info('Perf Lab: no chunk telemetry yet')
      return
    }

    const summaryRows: Array<[string, string | number | undefined | null]> = [
      ['hostname', chunkSummary.hostname ?? 'all'],
      ['mode', chunkSummary.mode ?? 'all'],
      ['total', chunkSummary.total],
      ['avgLatencyMs', chunkSummary.avgLatencyMs],
      ['p95LatencyMs', chunkSummary.p95LatencyMs],
      ['avgRawChars', chunkSummary.avgRawChars],
      ['avgCleanChars', chunkSummary.avgCleanChars],
      ['strippedRatio', chunkSummary.strippedRatio],
    ]

    const header = ['provider', 'latencyMs', 'rawChars', 'cleanChars', 'stripped', 'completedAt', 'mode', 'hostname']
    const rows: CsvValue[][] = chunkSummary.recentSamples.map((sample: ChunkMetricSampleDTO) => [
      sample.providerId ?? 'unknown',
      sample.latencyMs,
      sample.rawChars,
      sample.cleanChars,
      sample.strippedMarkup,
      sample.completedAt,
      sample.mode ?? '—',
      sample.hostname ?? '—',
    ])

    const csvLines = [
      'Summary',
      ...summaryRows.map(([key, value]) => [csvEscape(key), csvEscape(value)].join(',')),
      '',
      header.map(csvEscape).join(','),
      ...rows.map((row: CsvValue[]) => row.map(csvEscape).join(',')),
    ]

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `chunk-metrics-${Date.now()}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success('Chunk telemetry exported')
  }, [chunkSummary])

  const lastUpdated = latestEvents[0]?.createdAt
  const siteLabel = activeHostname ?? 'All hosts'
  const modeLabel = formatModeLabel(translateConfig.mode)
  const totalSamples = filteredSamples.length

  return (
    <div className="rounded-3xl border border-indigo-500/20 bg-[radial-gradient(circle_at_top,_#040715,_#0f172a)] p-4 text-slate-100 shadow-[0px_25px_70px_rgba(2,6,23,0.55)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.4em] text-indigo-200/80">Perf Lab</p>
          <h3 className="text-xl font-semibold text-white font-[family:'Space_Grotesk',sans-serif]">Translation-only pulse</h3>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <Badge variant="outline" className="border-white/30 bg-white/5 text-white/80">
              <Icon icon="solar:global-outline" className="size-3.5 text-emerald-300" />
              {siteLabel}
            </Badge>
            <Badge variant="outline" className="border-white/30 bg-white/5 text-white/80">
              <Icon icon="solar:settings-2-outline" className="size-3.5 text-sky-300" />
              {modeLabel}
            </Badge>
            <Badge variant="outline" className="border-white/30 bg-white/5 text-white/70">
              <Icon icon="solar:database-linear" className="size-3.5 text-fuchsia-300" />
              {totalSamples ? `${totalSamples} samples` : 'Awaiting samples'}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-[11px] uppercase tracking-[0.35em] text-emerald-300">
            <span className={cn('size-2 rounded-full bg-emerald-300', isFetching && 'animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.9)]')} />
            Live
          </div>
          <Button variant="ghost" size="sm" className="border border-white/20 bg-white/5 text-white/80 hover:bg-white/10" onClick={handleReset}>
            Reset
          </Button>
          <Button
            variant="outline-primary"
            size="sm"
            className="border-white/40 bg-white/5 text-white hover:bg-white/15"
            onClick={handleExport}
          >
            Export JSON
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <MetricStat label="Avg Δ" value={formatMs(summary.avgDeltaMs)} hint="delta" />
        <MetricStat label="P95 Δ" value={formatMs(summary.p95DeltaMs)} hint="tail" />
        <MetricStat label="Avg Σ" value={formatMs(summary.avgTotalMs)} hint={lastUpdated ? `updated ${formatTimeAgo(lastUpdated)}` : 'awaiting'} />
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-3">
        <div className="flex items-center justify-between text-[12px] uppercase tracking-[0.3em] text-white/70">
          <span>Stage focus</span>
          <span>Δ / Count</span>
        </div>
        {stageSummaries.length === 0
          ? (
              <p className="mt-3 text-sm text-white/60">
                Run a translation pass to populate Perf Lab for this site + mode.
              </p>
            )
          : (
              <div className="mt-3 space-y-2">
                {stageSummaries.map(stage => (
                  <div key={stage.stage} className="rounded-xl bg-slate-900/70 px-3 py-2 text-sm text-white/90">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">{stage.stage}</p>
                        <p className="text-[11px] text-white/60">{`${stage.count} samples`}</p>
                      </div>
                      <div className="text-right font-mono text-xs">
                        <p>{formatMs(stage.avgDeltaMs)}</p>
                        <p className="text-white/50">{`p95 ${formatMs(stage.p95DeltaMs)}`}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
      </div>

      <div className="mt-5 rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 via-slate-900/40 to-slate-950/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-emerald-200/80">
            <Icon icon="solar:layers-bold-duotone" className="size-5 text-emerald-300" />
            <div>
              <p className="text-[11px] uppercase tracking-[0.35em] text-emerald-200/70">Chunk telemetry</p>
              <p className="text-base font-semibold text-white">Queue + provider wait profile</p>
            </div>
          </div>
          <div className="text-right text-xs text-white/60">
            <p>{chunkSummary.total ? `${chunkSummary.total} chunks logged` : 'Waiting for chunk telemetry'}</p>
            <p className="text-[10px] uppercase tracking-[0.35em] text-emerald-200/80">
              {isChunkFetching ? 'Refreshing…' : 'Live snapshot'}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-[10px] uppercase tracking-[0.3em] text-white/60">
            <div className="flex items-center gap-2">
              <span>Host</span>
              <div className="flex items-center gap-1">
                <Button
                  variant={chunkHostFilter === 'active' ? 'outline-primary' : 'ghost'}
                  size="sm"
                  className="px-3 py-1 text-[10px]"
                  disabled={!activeHostname}
                  onClick={() => setChunkHostFilter('active')}
                  title={activeHostname ? `Stick to ${activeHostname}` : 'Open a page to enable host filtering'}
                >
                  Active
                </Button>
                <Button
                  variant={chunkHostFilter === 'all' ? 'outline-primary' : 'ghost'}
                  size="sm"
                  className="px-3 py-1 text-[10px]"
                  onClick={() => setChunkHostFilter('all')}
                >
                  All
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span>Mode</span>
              <div className="flex items-center gap-1">
                <Button
                  variant={chunkModeFilter === 'current' ? 'outline-primary' : 'ghost'}
                  size="sm"
                  className="px-3 py-1 text-[10px]"
                  onClick={() => setChunkModeFilter('current')}
                >
                  Current
                </Button>
                <Button
                  variant={chunkModeFilter === 'all' ? 'outline-primary' : 'ghost'}
                  size="sm"
                  className="px-3 py-1 text-[10px]"
                  onClick={() => setChunkModeFilter('all')}
                >
                  All
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/70">
            <span className="text-[10px] uppercase tracking-[0.35em] text-white/60">{chunkHostLabel} · {chunkModeLabel}</span>
            <Button
              variant="outline-primary"
              size="sm"
              className="border-white/40 bg-white/5 text-white hover:bg-white/15"
              onClick={handleChunkExport}
              disabled={!chunkSummary.total}
            >
              Export CSV
            </Button>
          </div>
        </div>

        {chunkSummary.total === 0
          ? (
              <p className="mt-4 text-sm text-white/70">
                Run a translation to capture chunk wait statistics. Recent translations populate provider mix, stripped ratios, and char deltas here.
              </p>
            )
          : (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                  <MetricStat label="Chunk Avg" value={formatMs(chunkSummary.avgLatencyMs)} hint="cleaned wait" />
                  <MetricStat label="Chunk P95" value={formatMs(chunkSummary.p95LatencyMs)} hint="tail latency" />
                  <MetricStat label="Avg Clean" value={formatChars(chunkSummary.avgCleanChars)} hint="post-normalize" />
                  <MetricStat label="Avg Raw" value={formatChars(chunkSummary.avgRawChars)} hint="pre-clean" />
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-3 text-left">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.35em] text-white/70">
                      <span>Provider mix</span>
                      <span className="flex items-center gap-1">
                        <span>{formatPercent(chunkSummary.strippedRatio)}</span>
                        <span>stripped</span>
                      </span>
                    </div>
                    {chunkSummary.providerBreakdown.length === 0
                      ? <p className="mt-3 text-sm text-white/60">Waiting for provider telemetry…</p>
                      : (
                          <div className="mt-3 space-y-2">
                            {chunkSummary.providerBreakdown.map(provider => (
                              <div key={provider.providerId} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm text-white/90">
                                <div>
                                  <p className="font-semibold uppercase tracking-wide">{provider.providerId}</p>
                                  <p className="text-[11px] text-white/60">{`${provider.count} chunks`}</p>
                                </div>
                                <div className="font-mono text-xs text-emerald-200">{formatMs(provider.avgLatencyMs)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-3 text-left">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.35em] text-white/70">
                      <span>Recent chunk pulses</span>
                      <span>Latency</span>
                    </div>
                    {chunkSummary.recentSamples.length === 0
                      ? <p className="mt-3 text-sm text-white/60">Next translation will stream chunk stats here.</p>
                      : (
                          <div className="mt-3 space-y-2">
                            {chunkSummary.recentSamples.map(sample => (
                              <div key={sample.key} className="grid grid-cols-[minmax(0,1.2fr)_0.8fr_0.7fr] items-center gap-3 rounded-xl bg-white/5 px-3 py-2 text-xs">
                                <div>
                                  <p className="font-semibold text-white">{sample.providerId ?? 'unknown'}</p>
                                  <p className="text-[11px] text-white/60">{formatTimeAgo(sample.completedAt)}</p>
                                </div>
                                <div className="font-mono text-[11px] text-emerald-200">{formatMs(sample.latencyMs)}</div>
                                <div className="text-right text-[11px] text-indigo-200">{formatCharPair(sample.rawChars, sample.cleanChars, sample.strippedMarkup)}</div>
                              </div>
                            ))}
                          </div>
                        )}
                  </div>
                </div>
              </>
            )}
      </div>

      <div className="mt-5 rounded-2xl border border-white/5 bg-black/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-white/80">
            <Icon icon="solar:activity-bold-duotone" className="size-4 text-sky-300" />
            <span className="text-[12px] uppercase tracking-[0.3em]">Latest pulses</span>
          </div>
          <span className="text-xs text-white/50">
            {lastUpdated ? `Last sample ${formatTimeAgo(lastUpdated)}` : 'Waiting for first sample'}
          </span>
        </div>
        {latestEvents.length === 0
          ? (
              <p className="mt-4 text-sm text-white/60">
                Still warming up—your next translation will show up here.
              </p>
            )
          : (
              <div className="mt-3 space-y-2">
                {latestEvents.map(sample => (
                  <div key={sample.key} className="grid grid-cols-[minmax(0,1.3fr)_0.8fr_0.8fr_0.5fr] items-center gap-3 rounded-xl bg-white/5 px-3 py-2 text-xs">
                    <div>
                      <p className="font-semibold text-white">{sample.stage}</p>
                      <p className="text-[11px] text-white/60">{formatTimeAgo(sample.createdAt)}</p>
                    </div>
                    <div className="font-mono text-[11px] text-emerald-200">{formatMs(sample.deltaMs)}</div>
                    <div className="font-mono text-[11px] text-indigo-200">{formatMs(sample.totalMs)}</div>
                    <div className="text-right text-[10px] uppercase tracking-wide text-white/60">{sample.surface ?? '—'}</div>
                  </div>
                ))}
              </div>
            )}
      </div>
    </div>
  )
}

function safeHostname(url?: string | null): string | undefined {
  if (!url)
    return undefined
  try {
    return new URL(url).hostname
  }
  catch {
    return undefined
  }
}

function filterSamples(samples: PerfSampleDTO[], hostname?: string, mode?: TranslationMode) {
  if (!samples.length)
    return []
  return samples.filter((sample) => {
    const sampleHost = safeHostname(sample.url)
    const matchesHost = hostname ? sampleHost === hostname : true
    const matchesMode = mode ? (!sample.mode || sample.mode === mode) : true
    return matchesHost && matchesMode
  })
}

function summarizeSamples(samples: PerfSampleDTO[]) {
  if (!samples.length)
    return { avgDeltaMs: undefined, p95DeltaMs: undefined, avgTotalMs: undefined }

  const deltas = samples.map(sample => sample.deltaMs)
  const totals = samples.map(sample => sample.totalMs)

  return {
    avgDeltaMs: average(deltas),
    p95DeltaMs: percentile(deltas, 95),
    avgTotalMs: average(totals),
  }
}

function summarizeStages(samples: PerfSampleDTO[]) {
  const stageMap = new Map<string, PerfSampleDTO[]>()
  samples.forEach((sample) => {
    const stageSamples = stageMap.get(sample.stage) ?? []
    stageSamples.push(sample)
    stageMap.set(sample.stage, stageSamples)
  })

  return Array.from(stageMap.entries())
    .map(([stage, stageSamples]) => {
      const deltas = stageSamples.map(sample => sample.deltaMs)
      return {
        stage,
        count: stageSamples.length,
        avgDeltaMs: average(deltas),
        p95DeltaMs: percentile(deltas, 95),
      }
    })
    .sort((a, b) => (b.p95DeltaMs ?? 0) - (a.p95DeltaMs ?? 0))
    .slice(0, 5)
}

function average(values: number[]) {
  if (!values.length)
    return undefined
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number((total / values.length).toFixed(2))
}

function percentile(values: number[], target: number) {
  if (!values.length)
    return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((target / 100) * (sorted.length - 1))))
  return Number(sorted[index].toFixed(2))
}

function formatMs(value?: number) {
  if (value === undefined)
    return '—'
  if (value >= 1000)
    return `${Math.round(value)} ms`
  if (value >= 100)
    return `${value.toFixed(0)} ms`
  return `${value.toFixed(1)} ms`
}

function formatPercent(value?: number) {
  if (value === undefined)
    return '—'
  return `${value.toFixed(1)}%`
}

function formatChars(value?: number) {
  if (value === undefined)
    return '—'
  if (value >= 1000)
    return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value)} ch`
}

function formatCharPair(raw?: number, clean?: number, stripped?: boolean) {
  if (raw === undefined || clean === undefined)
    return '—'
  const delta = raw - clean
  const indicator = stripped ? 'stripped' : 'raw'
  return `${Math.round(clean)} / ${Math.round(raw)} (${indicator}${delta > 0 ? ` -${Math.round(delta)}` : ''})`
}

function formatTimeAgo(timestamp?: string) {
  if (!timestamp)
    return '—'
  const target = new Date(timestamp)
  if (Number.isNaN(target.getTime()))
    return '—'
  const diffMs = Date.now() - target.getTime()
  if (diffMs < 2000)
    return 'just now'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60)
    return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatModeLabel(mode: TranslationMode): string {
  try {
    return i18n.t(`options.translation.translationMode.mode.${mode}`)
  }
  catch {
    return mode
  }
}

function MetricStat({ label, value, hint }: { label: string, value: string, hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-white">
      <p className="text-[11px] uppercase tracking-[0.4em] text-white/60">{label}</p>
      <p className="mt-1 text-2xl font-mono">{value}</p>
      <p className="text-[11px] text-white/50">{hint}</p>
    </div>
  )
}

function csvEscape(value: CsvValue): string {
  if (value === undefined || value === null)
    return ''
  const text = String(value)
  if (text.includes('"') || text.includes(',') || text.includes('\n'))
    return `"${text.replace(/"/g, '""')}"`
  return text
}
