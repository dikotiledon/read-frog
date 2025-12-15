import { GENAI_COOKIE_BRIDGE_DEFAULT_PORT } from '@/utils/constants/providers'

function normalizePort(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric))
    return GENAI_COOKIE_BRIDGE_DEFAULT_PORT
  const clamped = Math.max(1, Math.min(65535, Math.trunc(numeric)))
  return clamped
}

export function migrate(oldConfig: any): any {
  const providers = Array.isArray(oldConfig?.providersConfig) ? oldConfig.providersConfig : []

  const updatedProviders = providers.map((provider: any) => {
    if (provider?.provider !== 'genai')
      return provider

    const cookieBridge = provider.cookieBridge ?? {}
    return {
      ...provider,
      cookieBridge: {
        enabled: true,
        port: normalizePort(cookieBridge.port),
      },
    }
  })

  return {
    ...oldConfig,
    providersConfig: updatedProviders,
  }
}
