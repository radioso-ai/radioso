'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Copy, MessageSquare, RefreshCw, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
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
import { slackApi, type SlackBinding, type SlackInstallStatusResponse, type SlackManifestResponse } from '@/lib/api-slack'

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
  const [escalationChannelDraft, setEscalationChannelDraft] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<'install' | 'binding' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selfHostOpen, setSelfHostOpen] = useState(false)
  const [manifestState, setManifestState] = useState<{
    data: SlackManifestResponse | null
    isLoading: boolean
    error: string | null
    copied: boolean
  }>({ data: null, isLoading: false, error: null, copied: false })

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
        setEscalationChannelDraft(nextBinding.escalationChannelId ?? '')
        if (nextBinding.answeringAgentId !== agentId) {
          const updated = await slackApi.updateBinding(workspaceId, agentId, {
            answeringAgentId: agentId,
            escalationChannelId: nextBinding.escalationChannelId,
          })
          setBinding(updated)
          setEscalationChannelDraft(updated.escalationChannelId ?? '')
        }
      } else {
        setBinding(null)
        setEscalationChannelDraft('')
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

  const loadManifest = async () => {
    if (!workspaceId || !agentId || manifestState.data || manifestState.isLoading) return
    setManifestState((current) => ({ ...current, isLoading: true, error: null, copied: false }))
    try {
      const data = await slackApi.getManifest(workspaceId, agentId)
      setManifestState({ data, isLoading: false, error: null, copied: false })
    } catch (err) {
      setManifestState({
        data: null,
        isLoading: false,
        error: getApiErrorMessage(err, 'Failed to load Slack manifest.'),
        copied: false,
      })
    }
  }

  const toggleSelfHost = (open: boolean) => {
    setSelfHostOpen(open)
    if (open) {
      void loadManifest()
    }
  }

  const copyManifest = async () => {
    if (!manifestState.data) return
    await navigator.clipboard.writeText(JSON.stringify(manifestState.data.manifest, null, 2))
    setManifestState((current) => ({ ...current, copied: true }))
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
      setEscalationChannelDraft(updated.escalationChannelId ?? '')
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to update Slack binding.'))
    } finally {
      setBusyAction(null)
    }
  }

  const updateEscalationChannel = async () => {
    if (!workspaceId || !agentId) return
    setBusyAction('binding')
    setError(null)
    try {
      const trimmedChannel = escalationChannelDraft.trim()
      const updated = await slackApi.updateBinding(workspaceId, agentId, {
        answeringAgentId: agentId,
        escalationChannelId: trimmedChannel || null,
      })
      setBinding(updated)
      setEscalationChannelDraft(updated.escalationChannelId ?? '')
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to update Slack escalation channel.'))
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
      setEscalationChannelDraft('')
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
          <div className="space-y-4">
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

            <Collapsible open={selfHostOpen} onOpenChange={toggleSelfHost} className="rounded-xl border border-border bg-background">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="flex w-full justify-between px-4 py-3 text-left">
                  <span className="text-sm font-medium">Self-host setup</span>
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-4 border-t border-border p-4">
                  <p className="text-xs text-muted-foreground">
                    Your Radioso backend must be reachable from Slack at a public HTTPS URL for OAuth callbacks and events.
                  </p>
                  {manifestState.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner className="h-4 w-4" />
                      Loading manifest...
                    </div>
                  ) : null}
                  {manifestState.data ? (
                    <>
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Label className="text-foreground">Slack app manifest</Label>
                          <Button type="button" variant="outline" size="sm" onClick={copyManifest}>
                            <Copy className="mr-2 h-4 w-4" />
                            {manifestState.copied ? 'Copied' : 'Copy manifest'}
                          </Button>
                        </div>
                        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs text-foreground">
                          {JSON.stringify(manifestState.data.manifest, null, 2)}
                        </pre>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-foreground">Required env vars</Label>
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {manifestState.data.requiredEnvVars.map((envVar) => (
                            <li key={envVar}>
                              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">{envVar}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  ) : null}
                  {manifestState.error ? <p className="text-sm text-destructive">{manifestState.error}</p> : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
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

            <div className="max-w-md space-y-2">
              <Label htmlFor="slack-escalation-channel" className="text-foreground">Escalation channel</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="slack-escalation-channel"
                  value={escalationChannelDraft}
                  onChange={(event) => setEscalationChannelDraft(event.target.value)}
                  placeholder="C1234567890 or #support"
                  disabled={busyAction === 'binding'}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={updateEscalationChannel}
                  disabled={busyAction === 'binding'}
                >
                  {busyAction === 'binding' ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The agent posts there when it has no grounded answer.
              </p>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
