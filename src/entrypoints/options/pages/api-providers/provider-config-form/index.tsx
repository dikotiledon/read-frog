import type { GenAIProviderConfig } from '@/types/config/provider'
import { i18n } from '#imports'
import { useStore } from '@tanstack/react-form'
import { useAtom, useAtomValue } from 'jotai'
import { useEffect } from 'react'
import { Input } from '@/components/shadcn/input'
import { Separator } from '@/components/shadcn/separator'
import { Switch } from '@/components/shadcn/switch'
import { isAPIProviderConfig, isGenAIProviderConfig, isReadProvider, isTranslateProvider, providerRequiresAPIKey } from '@/types/config/provider'
import { configFieldsAtomMap } from '@/utils/atoms/config'
import { providerConfigAtom } from '@/utils/atoms/provider'
import { cn } from '@/utils/styles/tailwind'
import { selectedProviderIdAtom } from '../atoms'
import { APIKeyField } from './api-key-field'
import { BaseURLField } from './base-url-field'
import { ConfigHeader } from './config-header'
import { DefaultReadProviderSelector, DefaultTranslateProviderSelector } from './default-provider'
import { formOpts, useAppForm } from './form'
import { GenAISessionActions } from './genai-session-actions'
import { ReadModelSelector } from './read-model-selector'
import { TranslateModelSelector } from './translate-model-selector'

export function ProviderConfigForm() {
  const [selectedProviderId] = useAtom(selectedProviderIdAtom)
  const [providerConfig, setProviderConfig] = useAtom(providerConfigAtom(selectedProviderId ?? ''))
  const providersConfig = useAtomValue(configFieldsAtomMap.providersConfig)

  const specificFormOpts = {
    ...formOpts,
    defaultValues: providerConfig && isAPIProviderConfig(providerConfig) ? providerConfig : undefined,
  }

  const form = useAppForm({
    ...specificFormOpts,
    onSubmit: async ({ value }) => {
      void setProviderConfig(value)
    },
  })

  const providerType = useStore(form.store, state => state.values.provider)
  const cookieBridgeEnabled = useStore(form.store, (state) => {
    if (state.values.provider !== 'genai')
      return false
    const genaiValues = state.values as GenAIProviderConfig
    return Boolean(genaiValues.cookieBridge?.enabled)
  })
  const isReadProviderName = isReadProvider(providerType)
  const isTranslateProviderName = isTranslateProvider(providerType)
  const shouldShowApiKeyField = providerType ? providerRequiresAPIKey(providerType) : false

  // Reset form when selectedProviderId changes
  useEffect(() => {
    if (providerConfig && isAPIProviderConfig(providerConfig)) {
      form.reset(providerConfig)
    }
  }, [providerConfig, form])

  if (!providerConfig || !isAPIProviderConfig(providerConfig)) {
    return null
  }

  return (
    <form.AppForm
      // onSubmit={(e) => {
      //   e.preventDefault()
      //   e.stopPropagation()
      //   void form.handleSubmit()
      // }}
    >
      <div className={cn('flex-1 bg-card rounded-xl p-4 border flex flex-col justify-between', selectedProviderId !== providerConfig.id && 'hidden')}>
        <div className="flex flex-col gap-4">
          <ConfigHeader providerType={providerType} />
          <form.AppField
            name="name"
            validators={{
              onChange: ({ value }) => {
                const duplicateProvider = providersConfig.find(provider =>
                  provider.name === value && provider.id !== providerConfig.id,
                )
                if (duplicateProvider) {
                  return i18n.t('options.apiProviders.form.duplicateProviderName', [value])
                }
                return undefined
              },
            }}
          >
            {field => <field.InputField formForSubmit={form} label={i18n.t('options.apiProviders.form.fields.name')} />}
          </form.AppField>
          <form.AppField name="description">
            {field => <field.InputField formForSubmit={form} label={i18n.t('options.apiProviders.form.fields.description')} />}
          </form.AppField>

          {shouldShowApiKeyField && <APIKeyField form={form} />}
          <BaseURLField form={form} />
          {providerType === 'genai'
            && isGenAIProviderConfig(providerConfig)
            && (
              <div className="space-y-3">
                <div className="rounded-lg border border-dashed border-muted-foreground/40 bg-muted/40 p-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{i18n.t('options.apiProviders.genaiCookieBridge.title')}</p>
                      <p className="text-xs text-muted-foreground">
                        {i18n.t('options.apiProviders.genaiCookieBridge.description')}
                      </p>
                    </div>
                    <form.Field name="cookieBridge.enabled">
                      {field => (
                        <Switch
                          checked={Boolean(field.state.value)}
                          onCheckedChange={(checked) => {
                            field.handleChange(Boolean(checked))
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  <form.AppField
                    name="cookieBridge.port"
                    validators={{
                      onChange: ({ value }) => {
                        if (typeof value !== 'number' || Number.isNaN(value))
                          return i18n.t('options.apiProviders.genaiCookieBridge.port.invalid')
                        if (value < 1 || value > 65535)
                          return i18n.t('options.apiProviders.genaiCookieBridge.port.range')
                        return undefined
                      },
                    }}
                  >
                    {field => (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground" htmlFor="genai-cookie-bridge-port">
                          {i18n.t('options.apiProviders.genaiCookieBridge.port.label')}
                        </label>
                        <Input
                          id="genai-cookie-bridge-port"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={65535}
                          disabled={!cookieBridgeEnabled}
                          value={Number.isFinite(field.state.value) ? field.state.value : ''}
                          onChange={(event) => {
                            const rawValue = event.currentTarget.value
                            const numericValue = rawValue === '' ? Number.NaN : Number(rawValue)
                            field.handleChange(numericValue)
                          }}
                          onBlur={(event) => {
                            const numericValue = Number(event.currentTarget.value)
                            if (Number.isNaN(numericValue))
                              return
                            const clamped = Math.max(1, Math.min(65535, Math.trunc(numericValue)))
                            if (clamped !== field.state.value)
                              field.handleChange(clamped)
                          }}
                        />
                        {field.state.meta.errors[0] && (
                          <p className="text-xs text-destructive">
                            {typeof field.state.meta.errors[0] === 'string'
                              ? field.state.meta.errors[0]
                              : field.state.meta.errors[0]?.message ?? String(field.state.meta.errors[0])}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {i18n.t('options.apiProviders.genaiCookieBridge.port.help')}
                        </p>
                      </div>
                    )}
                  </form.AppField>
                </div>
                <GenAISessionActions providerConfig={providerConfig} />
              </div>
            )}
          {isTranslateProviderName && (
            <>
              <Separator className="my-2" />
              <DefaultTranslateProviderSelector form={form} />
              <TranslateModelSelector form={form} />
            </>
          )}
          {isReadProviderName && (
            <>
              <Separator className="my-2" />
              <DefaultReadProviderSelector form={form} />
              <ReadModelSelector form={form} />
            </>
          )}
        </div>
      </div>
    </form.AppForm>
  )
}
