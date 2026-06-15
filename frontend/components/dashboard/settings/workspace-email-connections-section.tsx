'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, ExternalLink, Mail, Power, RefreshCw, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import {
  customerEmailApi,
  type CustomerEmailConnection,
  type CustomerEmailOauthProviderId,
  type WorkspaceOauthConnection,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

const PROVIDERS: Array<{
  id: CustomerEmailOauthProviderId
  label: string
  defaultName: string
  defaultScopes: string[]
}> = [
  {
    id: 'google_mail',
    label: 'Google Gmail',
    defaultName: 'Support Gmail',
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  {
    id: 'microsoft_graph_mail',
    label: 'Microsoft 365 Outlook',
    defaultName: 'Support Outlook',
    defaultScopes: ['Mail.ReadWrite', 'Mail.Send'],
  },
]

const statusTone = (status: WorkspaceOauthConnection['status'] | CustomerEmailConnection['status']) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const statusLabel = (status: WorkspaceOauthConnection['status'] | CustomerEmailConnection['status']) => {
  if (status === 'authorized') return 'Authorized'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'pending') return 'Pending'
  if (status === 'disabled') return 'Disabled'
  if (status === 'error') return 'Error'
  return status
}

const providerLabel = (providerId: string) =>
  PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId

export function WorkspaceEmailConnectionsSection({ workspaceId }: { workspaceId: string | null }) {
  const [providerId, setProviderId] = useState<CustomerEmailOauthProviderId>('google_mail')
  const provider = useMemo(
    () => PROVIDERS.find((candidate) => candidate.id === providerId) ?? PROVIDERS[0],
    [providerId],
  )
  const [displayName, setDisplayName] = useState(provider.defaultName)
  const [oauthConnections, setOauthConnections] = useState<WorkspaceOauthConnection[]>([])
  const [emailConnections, setEmailConnections] = useState<CustomerEmailConnection[]>([])
  const [selectedOauthConnectionId, setSelectedOauthConnectionId] = useState('')
  const [connectionName, setConnectionName] = useState('Support outbound')
  const [senderEmail, setSenderEmail] = useState('')
  const [senderName, setSenderName] = useState('')
  const [replyToEmail, setReplyToEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const authorizedOauthConnections = oauthConnections.filter((connection) => connection.status === 'authorized')

  const loadConnections = async () => {
    if (!workspaceId) {
      setOauthConnections([])
      setEmailConnections([])
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const [oauthResult, emailResult] = await Promise.all([
        customerEmailApi.listOauthConnections(workspaceId),
        customerEmailApi.listEmailConnections(workspaceId),
      ])
      setOauthConnections(oauthResult.connections)
      setEmailConnections(emailResult.connections)
      setSelectedOauthConnectionId((current) => {
        if (current && oauthResult.connections.some((connection) => connection.id === current)) {
          return current
        }
        return oauthResult.connections.find((connection) => connection.status === 'authorized')?.id ?? ''
      })
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load email connections.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadConnections()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace changes reload server-owned connection state.
  }, [workspaceId])

  useEffect(() => {
    const onFocus = () => {
      void loadConnections()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus refresh uses the current workspace id.
  }, [workspaceId])

  const runAction = async (key: string, action: () => Promise<void>, fallbackMessage: string) => {
    if (!workspaceId) {
      return
    }
    setBusyAction(key)
    setError(null)
    try {
      await action()
      await loadConnections()
    } catch (actionError) {
      setError(getApiErrorMessage(actionError, fallbackMessage))
    } finally {
      setBusyAction(null)
    }
  }

  const startAuthorization = async () => {
    await runAction(
      'authorize',
      async () => {
        const result = await customerEmailApi.startOauth(workspaceId!, {
          provider: provider.id,
          displayName: displayName.trim() || provider.defaultName,
          requestedScopes: provider.defaultScopes,
        })
        window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
      },
      'Failed to start email authorization.',
    )
  }

  const reauthorize = async (connection: WorkspaceOauthConnection) => {
    await runAction(
      `reauthorize:${connection.id}`,
      async () => {
        const result = await customerEmailApi.reauthorizeOauth(workspaceId!, connection.id)
        window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
      },
      'Failed to start email reauthorization.',
    )
  }

  const createConnection = async () => {
    await runAction(
      'create',
      async () => {
        await customerEmailApi.createEmailConnection(workspaceId!, {
          oauthConnectionId: selectedOauthConnectionId,
          displayName: connectionName.trim(),
          senderEmail: senderEmail.trim(),
          senderName: senderName.trim() || null,
          replyToEmail: replyToEmail.trim() || null,
        })
        setConnectionName('Support outbound')
        setSenderEmail('')
        setSenderName('')
        setReplyToEmail('')
      },
      'Failed to create customer email connection.',
    )
  }

  const updateDisabled = async (connection: CustomerEmailConnection, disabled: boolean) => {
    await runAction(
      `disabled:${connection.id}`,
      () => customerEmailApi.updateEmailConnection(workspaceId!, connection.id, { disabled }),
      disabled ? 'Failed to disable customer email connection.' : 'Failed to re-enable customer email connection.',
    )
  }

  const checkHealth = async (connection: CustomerEmailConnection) => {
    await runAction(
      `health:${connection.id}`,
      () => customerEmailApi.checkEmailConnectionHealth(workspaceId!, connection.id),
      'Failed to check customer email connection health.',
    )
  }

  const deleteConnection = async (connection: CustomerEmailConnection) => {
    await runAction(
      `delete:${connection.id}`,
      () => customerEmailApi.deleteEmailConnection(workspaceId!, connection.id),
      'Failed to delete customer email connection.',
    )
  }

  return (
    <SettingsCard
      id="customer-email"
      icon={<Mail className="h-5 w-5 text-primary" />}
      title="Customer email"
      description="Authorize customer-owned mail and configure outbound connections for constrained email skills."
      headerEnd={
        emailConnections.length > 0 ? (
          <Badge className={statusTone(emailConnections[0]!.status)} variant="secondary">
            {emailConnections.length} configured
          </Badge>
        ) : null
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select
              value={providerId}
              onValueChange={(value) => {
                const nextProviderId = value as CustomerEmailOauthProviderId
                const nextProvider = PROVIDERS.find((candidate) => candidate.id === nextProviderId) ?? PROVIDERS[0]
                setProviderId(nextProviderId)
                setDisplayName(nextProvider.defaultName)
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-email-oauth-display-name">OAuth display name</Label>
            <Input
              id="customer-email-oauth-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={provider.defaultName}
            />
          </div>
          <Button
            type="button"
            onClick={startAuthorization}
            disabled={busyAction === 'authorize' || !workspaceId}
            className="md:self-end"
          >
            {busyAction === 'authorize' ? <Spinner className="mr-2 h-4 w-4" /> : <ExternalLink className="mr-2 h-4 w-4" />}
            Authorize
          </Button>
        </div>

        {oauthConnections.length > 0 ? (
          <div className="space-y-2">
            {oauthConnections.map((connection) => (
              <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
                  <p className="text-xs text-muted-foreground">{providerLabel(connection.provider)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusTone(connection.status)} variant="secondary">
                    {statusLabel(connection.status)}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => reauthorize(connection)}
                    disabled={busyAction === `reauthorize:${connection.id}` || !workspaceId}
                  >
                    {busyAction === `reauthorize:${connection.id}` ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Reauthorize
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Authorized OAuth connection</Label>
            <Select value={selectedOauthConnectionId} onValueChange={setSelectedOauthConnectionId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an authorized connection" />
              </SelectTrigger>
              <SelectContent>
                {authorizedOauthConnections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-email-connection-name">Connection name</Label>
            <Input id="customer-email-connection-name" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-email-sender-email">Sender email</Label>
            <Input id="customer-email-sender-email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-email-sender-name">Sender name</Label>
            <Input id="customer-email-sender-name" value={senderName} onChange={(event) => setSenderName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customer-email-reply-to">Reply-to email</Label>
            <Input id="customer-email-reply-to" value={replyToEmail} onChange={(event) => setReplyToEmail(event.target.value)} />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              onClick={createConnection}
              disabled={busyAction === 'create' || !workspaceId || !selectedOauthConnectionId || !senderEmail.trim() || !connectionName.trim()}
            >
              {busyAction === 'create' ? <Spinner className="mr-2 h-4 w-4" /> : <Mail className="mr-2 h-4 w-4" />}
              Create connection
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {emailConnections.map((connection) => (
            <div key={connection.id} className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {connection.senderName ? `${connection.senderName} <${connection.senderEmail}>` : connection.senderEmail}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {providerLabel(connection.provider)}
                    {connection.lastHealthStatus ? ` · health ${connection.lastHealthStatus}` : ''}
                    {connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={statusTone(connection.status)} variant="secondary">
                    {statusLabel(connection.status)}
                  </Badge>
                  <Button type="button" variant="outline" size="sm" onClick={() => checkHealth(connection)} disabled={busyAction === `health:${connection.id}`}>
                    {busyAction === `health:${connection.id}` ? <Spinner className="mr-2 h-4 w-4" /> : <Activity className="mr-2 h-4 w-4" />}
                    Health
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => updateDisabled(connection, connection.status !== 'disabled')}
                    disabled={busyAction === `disabled:${connection.id}`}
                  >
                    {busyAction === `disabled:${connection.id}` ? <Spinner className="mr-2 h-4 w-4" /> : <Power className="mr-2 h-4 w-4" />}
                    {connection.status === 'disabled' ? 'Enable' : 'Disable'}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => deleteConnection(connection)} disabled={busyAction === `delete:${connection.id}`}>
                    {busyAction === `delete:${connection.id}` ? <Spinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading email connections
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
