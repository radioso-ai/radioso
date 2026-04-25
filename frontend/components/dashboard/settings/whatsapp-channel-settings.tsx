'use client'

import { useEffect, useState } from 'react'

import { ConnectorSettingsForm } from '@/components/dashboard/connectors/connector-settings-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { MessageSquare } from 'lucide-react'
import { LogoSpinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  connectorsApi,
  type ConnectorDetail,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

const WHATSAPP_CONNECTOR_ID = 'whatsapp'

export function WhatsAppChannelSettings({
  onSaveStateChange,
  onLoadingChange,
  suppressLoadingState = false,
}: {
  onSaveStateChange?: (input: {
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }) => void
  onLoadingChange?: (isLoading: boolean) => void
  suppressLoadingState?: boolean
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

  useEffect(() => {
    onLoadingChange?.(isLoading)
  }, [isLoading, onLoadingChange])

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
    if (suppressLoadingState) {
      return null
    }

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
      <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
              <MessageSquare className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-foreground">WhatsApp</h3>
              <p className="text-sm text-muted-foreground">Configure the WhatsApp channel for this workspace.</p>
            </div>
          </div>
          <Switch
            checked={channel.enabled}
            onCheckedChange={(checked) => void setChannelEnabled(checked)}
            className="sm:mt-3"
          />
        </div>
        <div className="mt-5">
          <ConnectorSettingsForm
            key={`${channel.id}:${channel.enabled}:${JSON.stringify(channel.config)}:${channel.errorStatus ?? ''}`}
            connector={channel}
            onSaveStateChange={onSaveStateChange}
            onSave={saveChannelConfig}
          />
        </div>
      </section>
    )
  )
}
