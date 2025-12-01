import type { APIProviderConfig } from '@/types/config/provider'

import { i18n } from '#imports'
import { useStore } from '@tanstack/react-form'
import { isNonCustomLLMProvider, providerRequiresAPIKey } from '@/types/config/provider'
import { ConnectionTestButton } from './components/connection-button'
import { withForm } from './form'

export const BaseURLField = withForm({
  ...{ defaultValues: {} as APIProviderConfig },
  render: function Render({ form }) {
    const providerConfig = useStore(form.store, state => state.values)
    const providerType = providerConfig.provider
    const labelText = `${i18n.t('options.apiProviders.form.fields.baseURL')}${isNonCustomLLMProvider(providerType)
      ? ` (${i18n.t('options.apiProviders.form.fields.optional')})`
      : ''}`
    const showConnectionButton = providerType ? !providerRequiresAPIKey(providerType) : false

    return (
      <form.AppField name="baseURL">
        {field => (
          <field.InputField
            formForSubmit={form}
            label={showConnectionButton
              ? (
                  <div className="flex items-end justify-between w-full">
                    <span className="text-sm font-medium">
                      {labelText}
                    </span>
                    <ConnectionTestButton
                      providerConfig={providerConfig}
                    />
                  </div>
                )
              : labelText}
          />
        )}
      </form.AppField>
    )
  },
})
