import type { GenAIProviderConfig } from '@/types/config/provider'
import { i18n } from '#imports'
import { useStore } from '@tanstack/react-form'
import { Input } from '@/components/shadcn/input'
import { Switch } from '@/components/shadcn/switch'
import { withForm } from './form'

export const GenAICookieBridgeSettings = withForm({
  ...{ defaultValues: {} as GenAIProviderConfig },
  render: function Render({ form }) {
    const isBridgeEnabled = useStore(form.store, state => state.values.cookieBridge?.enabled ?? false)

    return (
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
                disabled={!isBridgeEnabled}
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
              {field.state.meta.errors.length > 0 && (
                <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {i18n.t('options.apiProviders.genaiCookieBridge.port.help')}
              </p>
            </div>
          )}
        </form.AppField>
      </div>
    )
  },
})
