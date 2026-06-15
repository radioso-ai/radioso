'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Mail, RefreshCw } from 'lucide-react'

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

const storageKey = (workspaceId: string) => `radioso.customerEmailOAuth:${workspaceId}`

const statusTone = (status: WorkspaceOauthConnection['status']) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const statusLabel = (status: WorkspaceOauthConnection['status']) => {
  if (status === 'authorized') return 'Authorized'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'pending') return 'Pending'
  if (status === 'disabled') return 'Disabled'
  if (status === 'error') return 'Error'
  return status
}

export function WorkspaceEmailConnectionsSection({ workspaceId }: { workspaceId: string | null }) {
  const [providerId, setProviderId] = useState<CustomerEmailOauthProviderId>('google_mail')
  const provider = useMemo(
    () => PROVIDERS.find((candidate) => candidate.id === providerId) ?? PROVIDERS[0],
    [providerId],
  )
  const [displayName, setDisplayName] = useState(provider.defaultName)
  const [connection, setConnection] = useState<WorkspaceOauthConnection | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStoredConnection = async () => {
    if (!workspaceId || typeof window === 'undefined') {
      return
    }
    const connectionId = window.localStorage.getItem(storageKey(workspaceId))
    if (!connectionId) {
      setConnection(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const response = await customerEmailApi.getOauthConnection(workspaceId, connectionId)
      setConnection(response.connection)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load email authorization status.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadStoredConnection()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Workspace changes reload the locally tracked OAuth connection.
  }, [workspaceId])

  useEffect(() => {
    const onFocus = () => {
      void loadStoredConnection()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Focus refresh uses the current workspace id.
  }, [workspaceId])

  const startAuthorization = async () => {
    if (!workspaceId) {
      return
    }
    setIsStarting(true)
    setError(null)
    try {
      const result = connection
        ? await customerEmailApi.reauthorizeOauth(workspaceId, connection.id)
        : await customerEmailApi.startOauth(workspaceId, {
            provider: provider.id,
            displayName: displayName.trim() || provider.defaultName,
            requestedScopes: provider.defaultScopes,
          })
      window.localStorage.setItem(storageKey(workspaceId), result.connectionId)
      const status = await customerEmailApi.getOauthConnection(workspaceId, result.connectionId)
      setConnection(status.connection)
      window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer')
    } catch (startError) {
      setError(getApiErrorMessage(startError, 'Failed to start email authorization.'))
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <SettingsCard
      id="customer-email"
      icon={<Mail className="h-5 w-5 text-primary" />}
      title="Customer email"
      description="Authorize a workspace-owned mail provider for constrained email skills."
      headerEnd={
        connection ? (
          <Badge className={statusTone(connection.status)} variant="secondary">
            {statusLabel(connection.status)}
          </Badge>
        ) : null
      }
    >
      <div className="space-y-4">
        {connection ? (
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
                <p className="text-xs text-muted-foreground">{connection.provider}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {connection.grantedScopes.length > 0
                    ? `Scopes: ${connection.grantedScopes.join(', ')}`
                    : 'No scopes recorded yet'}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startAuthorization}
                disabled={isStarting || !workspaceId}
              >
                {isStarting ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Reauthorize
              </Button>
            </div>
          </div>
        ) : (
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
              <Label htmlFor="customer-email-display-name">Display name</Label>
              <Input
                id="customer-email-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={provider.defaultName}
              />
            </div>
            <Button
              type="button"
              onClick={startAuthorization}
              disabled={isStarting || !workspaceId}
              className="md:self-end"
            >
              {isStarting ? <Spinner className="mr-2 h-4 w-4" /> : <ExternalLink className="mr-2 h-4 w-4" />}
              Authorize
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading email authorization status
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </SettingsCard>
  )
}
