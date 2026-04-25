'use client'

import { useEffect, useState } from 'react'

import { ConnectorSettingsForm } from '@/components/dashboard/connectors/connector-settings-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  connectorsApi,
  type ConnectorDetail,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

const WHATSAPP_CONNECTOR_ID = 'whatsapp'

export function WhatsAppChannelSettings({
  onSaveStateChange,
}: {
  onSaveStateChange?: (input: {
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }) => void
}) {
  const [channelId, setChannelId] = useState<string | null>(null)
  const [channel, setChannel] = useState<ConnectorDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const list = await connectorsApi.listConnectors()
        const resolvedChannelId =
          list.find((connector) => connector.id === WHATSAPP_CONNECTOR_ID)?.id ?? null
        setChannelId(resolvedChannelId)

        if (resolvedChannelId) {
          const detail = await connectorsApi.getConnector(resolvedChannelId)
          setChannel(detail)
        }
      } catch (error) {
        setFormError(getApiErrorMessage(error, 'Failed to load WhatsApp settings.'))
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [])

  const refreshChannel = async (nextChannelId: string) => {
    const detail = await connectorsApi.getConnector(nextChannelId)
    setChannel(detail)
    return detail
  }

  const saveChannelConfig = async (config: Record<string, string | boolean>) => {
    if (!channelId) {
      throw new Error('WhatsApp channel unavailable')
    }
    setFormError(null)
    const detail = await connectorsApi.saveConnectorConfig(channelId, config)
    setChannel(detail)
    return detail
  }

  const setChannelEnabled = async (enabled: boolean) => {
    if (!channelId) {
      throw new Error('WhatsApp channel unavailable')
    }
    setFormError(null)
    const detail = enabled
      ? await connectorsApi.enableConnector(channelId)
      : await connectorsApi.disableConnector(channelId)
    return refreshChannel(detail.id)
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!channelId) {
    return (
      <Alert>
        <AlertTitle>WhatsApp unavailable</AlertTitle>
        <AlertDescription>
          The backend has not registered a WhatsApp channel yet.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    !channel ? (
      <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-border bg-muted/20">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    ) : (
      <ConnectorSettingsForm
        key={`${channel.id}:${channel.enabled}:${JSON.stringify(channel.config)}:${channel.errorStatus ?? ''}`}
        connector={channel}
        onSaveStateChange={onSaveStateChange}
        onSave={saveChannelConfig}
        onSetEnabled={setChannelEnabled}
      />
    )
  )
}
