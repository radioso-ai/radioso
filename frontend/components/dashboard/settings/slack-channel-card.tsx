'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, RefreshCw, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { slackApi, type SlackBinding, type SlackInstallStatusResponse } from '@/lib/api-slack'

type SlackChannelCardProps = {
  workspaceId: string | null | undefined
  agentId: string | null | undefined
  agentName: string
}

const isConnected = (status: SlackInstallStatusResponse | null) => status?.status === 'connected'
const needsReauth = (status: SlackInstallStatusResponse | null) => status?.status === 'needs_reauth'

export function SlackChannelCard({ workspaceId, agentId, agentName }: SlackChannelCardProps) {
  const [status, setStatus] = useState<SlackInstallStatusResponse | null>(null)
  const [binding, setBinding] = useState<SlackBinding | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<'install' | 'binding' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canUseSlack = Boolean(workspaceId && agentId)
  const resolvedAgentName = agentName.trim() || 'This agent'
  const selectedAgentId = binding?.answeringAgentId ?? (isConnected(status) ? agentId ?? '' : '')
  const statusLabel = useMemo(() => {
    if (!status) return 'Checking'
    if (status.status === 'connected') return status.teamName ? `Connected to ${status.teamName}` : 'Connected'
    if (status.status === 'needs_reauth') return 'Reconnect required'
    if (status.status === 'disabled') return 'Disabled'
    return 'Not connected'
  }, [status])

  const loadSlackState = useCallback(async () => {
    if (!workspaceId || !agentId) {
      setStatus(null)
      setBinding(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const nextStatus = await slackApi.getInstallStatus(workspaceId, agentId)
      setStatus(nextStatus)
      if (nextStatus.status === 'connected') {
        const nextBinding = await slackApi.getBinding(workspaceId, agentId)
        setBinding(nextBinding)
        if (nextBinding.answeringAgentId !== agentId) {
          const updated = await slackApi.updateBinding(workspaceId, agentId, {
            answeringAgentId: agentId,
            escalationChannelId: nextBinding.escalationChannelId,
          })
          setBinding(updated)
        }
      } else {
        setBinding(null)
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load Slack channel.'))
    } finally {
      setIsLoading(false)
    }
  }, [agentId, workspaceId])

  useEffect(() => {
    queueMicrotask(() => {
      void loadSlackState()
    })
  }, [loadSlackState])

  const startInstall = async () => {
    if (!workspaceId || !agentId) return
    setBusyAction('install')
    setError(null)
    try {
      const response = await slackApi.startInstall(workspaceId, agentId)
      window.location.assign(response.authorizationUrl)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to start Slack authorization.'))
      setBusyAction(null)
    }
  }

  const updateAnsweringAgent = async (nextAgentId: string) => {
    if (!workspaceId || !agentId || nextAgentId !== agentId) return
    setBusyAction('binding')
    setError(null)
    try {
      const updated = await slackApi.updateBinding(workspaceId, agentId, {
        answeringAgentId: nextAgentId,
        escalationChannelId: binding?.escalationChannelId ?? null,
      })
      setBinding(updated)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to update Slack binding.'))
    } finally {
      setBusyAction(null)
    }
  }

  const disconnect = async () => {
    if (!workspaceId || !agentId) return
    setBusyAction('disconnect')
    setError(null)
    try {
      await slackApi.disconnect(workspaceId, agentId)
      setStatus({ status: 'not_configured' })
      setBinding(null)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to disconnect Slack.'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <SettingsCard
      id="slack-channel"
      icon={<MessageSquare className="h-5 w-5 text-primary" />}
      title="Slack"
      description="Answer Slack DMs with this agent."
      headerEnd={
        <Badge variant={isConnected(status) ? 'outline' : 'secondary'}>
          {statusLabel}
        </Badge>
      }
    >
      <div className="space-y-5">
        {isLoading ? (
          <div className="flex h-16 items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading Slack channel...
          </div>
        ) : null}

        {!isLoading && !isConnected(status) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/50 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {needsReauth(status) ? 'Slack needs to be reconnected.' : 'Connect Slack to this agent.'}
              </p>
              <p className="text-xs text-muted-foreground">No tokens or secrets are entered in Radioso.</p>
            </div>
            <Button type="button" onClick={startInstall} disabled={!canUseSlack || busyAction === 'install'}>
              {busyAction === 'install' ? <Spinner className="mr-2 h-4 w-4" /> : <MessageSquare className="mr-2 h-4 w-4" />}
              {needsReauth(status) ? 'Reconnect Slack' : 'Add to Slack'}
            </Button>
          </div>
        ) : null}

        {!isLoading && isConnected(status) ? (
          <div className="space-y-4 rounded-xl bg-muted/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Connected{status?.teamName ? ` to ${status.teamName}` : ''}</p>
                <p className="text-xs text-muted-foreground">Slack DMs route to the selected answering agent.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={loadSlackState} disabled={Boolean(busyAction)}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={disconnect} disabled={busyAction === 'disconnect'}>
                  {busyAction === 'disconnect' ? <Spinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  Disconnect
                </Button>
              </div>
            </div>

            <div className="max-w-md space-y-2">
              <Label htmlFor="slack-answering-agent" className="text-foreground">Answering agent</Label>
              <Select
                value={selectedAgentId}
                onValueChange={updateAnsweringAgent}
                disabled={!agentId || busyAction === 'binding'}
              >
                <SelectTrigger id="slack-answering-agent" className="w-full">
                  <SelectValue placeholder="Choose agent" />
                </SelectTrigger>
                <SelectContent>
                  {agentId ? <SelectItem value={agentId}>{resolvedAgentName}</SelectItem> : null}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
