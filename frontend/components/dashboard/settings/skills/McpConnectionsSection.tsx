'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
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
import { getApiErrorMessage } from '@/lib/api-error'
import { externalSkillsApi, type McpConnection } from '@/lib/api-external-skills'
import {
  buildOauthConfigPayload,
  emptyOauthDraft,
  isConnectionDraftComplete,
  MCP_OAUTH_PENDING_KEY,
  type McpAuthMethodChoice,
  type OauthConnectionDraft,
} from '@/lib/external-skills'
import { cn } from '@/lib/utils'

const statusTone = (status: string) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const statusLabel = (status: string) => {
  if (status === 'authorized') return 'Connected'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'error') return 'Error'
  if (status === 'unconfigured') return 'Not verified'
  return status
}

export function McpConnectionsSection({ agentId }: { agentId: string }) {
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isAddingConnection, setIsAddingConnection] = useState(false)
  const [connectionName, setConnectionName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [authMethod, setAuthMethod] = useState<McpAuthMethodChoice>('access_token')
  const [accessToken, setAccessToken] = useState('')
  const [oauthDraft, setOauthDraft] = useState<OauthConnectionDraft>(emptyOauthDraft)

  const load = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await externalSkillsApi.listConnections(agentId)
      setConnections(response.connections)
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load MCP connections.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload when the owning agent changes.
  }, [agentId])

  useEffect(() => {
    const onFocus = () => {
      if (typeof window !== 'undefined' && window.localStorage.getItem(MCP_OAUTH_PENDING_KEY)) {
        window.localStorage.removeItem(MCP_OAUTH_PENDING_KEY)
        void load()
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Focus refresh uses the current agent id.
  }, [agentId])

  const createConnection = async () => {
    setBusyAction('create')
    setError(null)
    try {
      await externalSkillsApi.createConnection(agentId, {
        displayName: connectionName,
        serverUrl,
        authMethod,
        ...(authMethod === 'access_token'
          ? { accessToken }
          : { oauth: buildOauthConfigPayload(oauthDraft) }),
      })
      setConnectionName('')
      setServerUrl('')
      setAccessToken('')
      setOauthDraft(emptyOauthDraft())
      setAuthMethod('access_token')
      setIsAddingConnection(false)
      await load()
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Failed to create MCP connection.'))
    } finally {
      setBusyAction(null)
    }
  }

  const authorizeConnection = async (connectionId: string) => {
    setBusyAction(`authorize:${connectionId}`)
    setError(null)
    try {
      const { authorizationUrl } = await externalSkillsApi.startOauth(agentId, connectionId)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MCP_OAUTH_PENDING_KEY, JSON.stringify({ agentId, connectionId }))
        window.open(authorizationUrl, '_blank', 'noopener,noreferrer')
      }
    } catch (authorizeError) {
      setError(getApiErrorMessage(authorizeError, 'Failed to start OAuth authorization.'))
    } finally {
      setBusyAction(null)
    }
  }

  const deleteConnection = async (connectionId: string) => {
    setBusyAction(`delete:${connectionId}`)
    setError(null)
    try {
      await externalSkillsApi.deleteConnection(agentId, connectionId)
      setConnections((current) => current.filter((connection) => connection.id !== connectionId))
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete MCP connection.'))
    } finally {
      setBusyAction(null)
    }
  }

  const showConnectionForm = isAddingConnection || connections.length === 0
  const canSaveConnection = isConnectionDraftComplete({
    displayName: connectionName,
    serverUrl,
    authMethod,
    accessToken,
    oauth: oauthDraft,
  })

  return (
    <SettingsCard
      id="mcp-skill-connections"
      icon={<Server className="h-5 w-5 text-primary" />}
      title="Connections"
      description="Manage integration targets separately from skill authoring. Skills bind to connected targets but never edit credentials."
      headerEnd={(
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      )}
    >
      <div className="space-y-5">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading connections...
          </div>
        ) : null}

        {connections.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {connections.map((connection) => (
              <div key={connection.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{connection.displayName}</p>
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusTone(connection.status))}>
                      {statusLabel(connection.status)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{connection.serverUrl}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {connection.authMethod === 'oauth' && connection.status !== 'authorized' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void authorizeConnection(connection.id)}
                      disabled={busyAction === `authorize:${connection.id}`}
                    >
                      {busyAction === `authorize:${connection.id}` ? <Spinner className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                      {connection.status === 'needs_reauth' ? 'Re-authorize' : 'Authorize'}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${connection.displayName}`}
                    onClick={() => void deleteConnection(connection.id)}
                    disabled={busyAction === `delete:${connection.id}`}
                  >
                    {busyAction === `delete:${connection.id}` ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {showConnectionForm ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-foreground">MCP server</h4>
              {connections.length > 0 ? (
                <Button type="button" variant="ghost" size="icon" aria-label="Cancel" onClick={() => setIsAddingConnection(false)}>
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mcpConnectionName">Display name</Label>
                <Input id="mcpConnectionName" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="Support MCP" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcpServerUrl">Server URL</Label>
                <Input id="mcpServerUrl" type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
              </div>
              <div className="space-y-2">
                <Label>Authentication</Label>
                <Select value={authMethod} onValueChange={(value) => setAuthMethod(value as McpAuthMethodChoice)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="access_token">Access token</SelectItem>
                    <SelectItem value="oauth">OAuth</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {authMethod === 'access_token' ? (
                <div className="space-y-2">
                  <Label htmlFor="mcpAccessToken">Access token</Label>
                  <Input id="mcpAccessToken" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} />
                </div>
              ) : null}
            </div>

            {authMethod === 'oauth' ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mcpOauthAuthorizationEndpoint">Authorization endpoint</Label>
                  <Input id="mcpOauthAuthorizationEndpoint" type="url" value={oauthDraft.authorizationEndpoint} onChange={(event) => setOauthDraft((current) => ({ ...current, authorizationEndpoint: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcpOauthTokenEndpoint">Token endpoint</Label>
                  <Input id="mcpOauthTokenEndpoint" type="url" value={oauthDraft.tokenEndpoint} onChange={(event) => setOauthDraft((current) => ({ ...current, tokenEndpoint: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcpOauthClientId">Client ID</Label>
                  <Input id="mcpOauthClientId" value={oauthDraft.clientId} onChange={(event) => setOauthDraft((current) => ({ ...current, clientId: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcpOauthClientSecret">Client secret</Label>
                  <Input id="mcpOauthClientSecret" type="password" value={oauthDraft.clientSecret} onChange={(event) => setOauthDraft((current) => ({ ...current, clientSecret: event.target.value }))} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="mcpOauthScopes">Scopes</Label>
                  <Input id="mcpOauthScopes" value={oauthDraft.scopes} onChange={(event) => setOauthDraft((current) => ({ ...current, scopes: event.target.value }))} />
                </div>
              </div>
            ) : null}

            <Button type="button" onClick={() => void createConnection()} disabled={busyAction === 'create' || !canSaveConnection}>
              {busyAction === 'create' ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              Save connection
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setIsAddingConnection(true)}>
            <Plus className="h-4 w-4" />
            Add MCP server
          </Button>
        )}
      </div>
    </SettingsCard>
  )
}
