import type { GenAIProviderConfig } from '@/types/config/provider'
import { i18n } from '#imports'
import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { toast } from 'sonner'
import guest from '@/assets/icons/avatars/guest.svg'
import { Button } from '@/components/shadcn/button'
import { isGenAIProviderConfig } from '@/types/config/provider'
import { configFieldsAtomMap } from '@/utils/atoms/config'
import { authClient } from '@/utils/auth/auth-client'
import { ensureGenAISession } from '@/utils/genai/session'
import { cn } from '@/utils/styles/tailwind'

export function UserAccount() {
  const { data, isPending } = authClient.useSession()
  const providersConfig = useAtomValue(configFieldsAtomMap.providersConfig)
  const genaiConfig = useMemo<GenAIProviderConfig | null>(() => {
    const provider = providersConfig.find(isGenAIProviderConfig)
    return provider ?? null
  }, [providersConfig])

  const handleLogin = () => {
    if (!genaiConfig) {
      toast.error(i18n.t('header.login.missingConfig'))
      return
    }

    toast.promise(ensureGenAISession(genaiConfig), {
      loading: i18n.t('header.login.loading'),
      success: i18n.t('header.login.success'),
      error: error => (error instanceof Error ? error.message : i18n.t('header.login.error')),
    })
  }

  return (
    <div className="flex items-center gap-2">
      <img
        src={data?.user.image ?? guest}
        alt="User"
        className={cn('rounded-full border size-6', !data?.user.image && 'p-1', isPending && 'animate-pulse')}
      />
      {isPending ? 'Loading...' : data?.user.name ?? 'Guest'}
      {!isPending && !data && (
        <Button
          size="sm"
          variant="outline"
          className="h-5 rounded-sm"
          onClick={handleLogin}
        >
          {i18n.t('header.login.button')}
        </Button>
      )}
    </div>
  )
}
