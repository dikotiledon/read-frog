import type { GenAIProviderConfig } from '@/types/config/provider'
import { i18n, browser } from '#imports'
import { IconExternalLink } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/shadcn/button'
import { ensureGenAISession, getGenAIBaseURL } from '@/utils/genai/session'

function formatTimestamp(timestamp: number) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
  }
  catch {
    return new Date(timestamp).toLocaleString()
  }
}

export function GenAISessionActions({ providerConfig }: { providerConfig: GenAIProviderConfig }) {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  const baseURL = useMemo(() => getGenAIBaseURL(providerConfig), [providerConfig])

  const handleRefreshSession = async () => {
    if (isRefreshing)
      return

    setIsRefreshing(true)
    const ensurePromise = ensureGenAISession(providerConfig)
    toast.promise(ensurePromise, {
      loading: i18n.t('options.apiProviders.genaiSession.refreshing'),
      success: i18n.t('options.apiProviders.genaiSession.ready'),
      error: error => (error instanceof Error ? error.message : i18n.t('options.apiProviders.genaiSession.failed')),
    })

    try {
      await ensurePromise
      setLastCheckedAt(Date.now())
    }
    finally {
      setIsRefreshing(false)
    }
  }

  const handleOpenPortal = async () => {
    try {
      await browser.tabs.create({ url: baseURL, active: true })
    }
    catch (error) {
  toast.error(error instanceof Error ? error.message : i18n.t('options.apiProviders.genaiSession.openFailed'))
    }
  }

  const statusText = lastCheckedAt
  ? i18n.t('options.apiProviders.genaiSession.lastChecked', [formatTimestamp(lastCheckedAt)])
  : i18n.t('options.apiProviders.genaiSession.notChecked')

  return (
    <div className="rounded-lg border border-dashed border-muted-foreground/40 bg-muted/40 p-3">
      <div className="flex flex-col gap-1 text-sm font-medium">
  <span>{i18n.t('options.apiProviders.genaiSession.title')}</span>
        <p className="text-xs text-muted-foreground">
          {i18n.t('options.apiProviders.genaiSession.description')}
        </p>
        <p className="text-xs text-muted-foreground">
          {statusText}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={handleRefreshSession} disabled={isRefreshing}>
          {i18n.t('options.apiProviders.genaiSession.refresh')}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={handleOpenPortal}>
          <IconExternalLink className="size-3.5" />
          <span className="ml-1">{i18n.t('options.apiProviders.genaiSession.openPortal')}</span>
        </Button>
      </div>
    </div>
  )
}
