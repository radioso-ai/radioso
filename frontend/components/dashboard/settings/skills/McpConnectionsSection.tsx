'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Plus, X } from 'lucide-react'

import { focusQuietListRow, QuietList, QuietListRow } from '@/components/dashboard/settings/quiet-list'
import { useScopedRowMutations } from '@/components/dashboard/settings/use-scoped-row-mutations'
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
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import { externalSkillsApi, type McpConnection } from '@/lib/api-external-skills'
import {
  buildOauthConfigPayload,
  emptyOauthDraft,
  isConnectionDraftComplete,
  MCP_OAUTH_PENDING_KEY,
  type McpAuthMethodChoice,
  type OauthConnectionDraft,
} from '@/lib/external-skills'
import { McpConnectionDetail, type McpConnectionActions } from './McpConnectionDetail'
import {
  connectionActionKey,
  connectionNeedsAttention,
  connectionRowDomId,
  McpStatusBadge,
  type McpConnectionAction,
  type McpConnectionTestResult,
} from './mcp-connection-status'

// The open connection belongs to one agent's panel: switching agents returns to the list instead
// of carrying a detail view over to a list that may not hold it.
type Selection = { agentId: string; connectionId: string }

const TEST_FAILURE_FALLBACK = 'Could not connect to the MCP server. Check the server URL and credentials, then try again.'

const testFailureMessage = (error: unknown): string =>
  getApiErrorStatus(error) === 500 ? TEST_FAILURE_FALLBACK : getApiErrorMessage(error, TEST_FAILURE_FALLBACK)

const withoutTestResult = (results: Record<string, McpConnectionTestResult>, connectionId: string) =>
  Object.fromEntries(Object.entries(results).filter(([id]) => id !== connectionId))

// Where the keyboard goes after the connection it was on leaves: the next row, else the previous.
const neighborConnectionId = (connections: readonly McpConnection[], connectionId: string): string | null => {
  const index = connections.findIndex((connection) => connection.id === connectionId)
  if (index < 0) return null
  return (connections[index + 1] ?? connections[index - 1])?.id ?? null
}

export function McpConnectionsSection({ agentId }: { agentId: string }) {
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // Only the add form is single-flight; each connection's own actions lock through `rowMutations`.
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAddingConnection, setIsAddingConnection] = useState(false)
  const [connectionName, setConnectionName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [authMethod, setAuthMethod] = useState<McpAuthMethodChoice>('access_token')
  const [accessToken, setAccessToken] = useState('')
  const [oauthDraft, setOauthDraft] = useState<OauthConnectionDraft>(emptyOauthDraft)
  const loadVersion = useRef(0)
  const [testResults, setTestResults] = useState<Record<string, McpConnectionTestResult>>({})
  const [selection, setSelection] = useState<Selection | null>(null)
  // The row to hand the keyboard back to once the list is on screen again.
  const restoreFocusRowId = useRef<string | null>(null)
  const rowMutations = useScopedRowMutations(agentId)

  // The detail view holds which connection it shows, not a copy of it, so a reload shows the
  // current one and a deleted or vanished connection falls back to the list.
  const selectedConnection = useMemo(
    () => (selection?.agentId === agentId
      ? connections.find((connection) => connection.id === selection.connectionId) ?? null
      : null),
    [selection, agentId, connections],
  )

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setIsLoading(true)
    setError(null)
    try {
      const response = await externalSkillsApi.listConnections(agentId)
      if (version !== loadVersion.current) return
      setConnections(response.connections)
    } catch (loadError) {
      if (version !== loadVersion.current) return
      setError(getApiErrorMessage(loadError, 'Failed to load MCP connections.'))
    } finally {
      if (version === loadVersion.current) {
        setIsLoading(false)
      }
    }
  }, [agentId])

  useEffect(() => {
    queueMicrotask(() => {
      setTestResults({})
      void load()
    })
  }, [load])

  useEffect(() => {
    const onFocus = () => {
      if (typeof window !== 'undefined' && window.localStorage.getItem(MCP_OAUTH_PENDING_KEY)) {
        window.localStorage.removeItem(MCP_OAUTH_PENDING_KEY)
        void load()
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // Runs when the list takes the detail view's place, after the row it points at has rendered.
  useEffect(() => {
    if (selectedConnection) return
    const rowId = restoreFocusRowId.current
    if (!rowId) return
    restoreFocusRowId.current = null
    focusQuietListRow(rowId)
  }, [selectedConnection])

  const createConnection = async () => {
    setIsCreating(true)
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
      setIsCreating(false)
    }
  }

  const runConnectionAction = <T,>(action: McpConnectionAction, connectionId: string, mutate: () => Promise<T>) =>
    rowMutations.run(connectionActionKey(action, connectionId), mutate)

  const authorizeConnection = async (connectionId: string) => {
    setError(null)
    const outcome = await runConnectionAction('authorize', connectionId, async () => {
      const { authorizationUrl } = await externalSkillsApi.startOauth(agentId, connectionId)
      return authorizationUrl
    })
    if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, 'Failed to start OAuth authorization.'))
    } else if (outcome.status === 'applied' && typeof window !== 'undefined') {
      window.localStorage.setItem(MCP_OAUTH_PENDING_KEY, JSON.stringify({ agentId, connectionId }))
      window.open(outcome.value, '_blank', 'noopener,noreferrer')
    }
  }

  const testConnection = async (connectionId: string) => {
    setTestResults((current) => withoutTestResult(current, connectionId))
    const outcome = await runConnectionAction('test', connectionId, () => externalSkillsApi.discoverTools(agentId, connectionId))
    if (outcome.status === 'stale') return
    const result: McpConnectionTestResult = outcome.status === 'applied'
      ? { status: 'success', toolCount: outcome.value.tools.length }
      : { status: 'error', message: testFailureMessage(outcome.error) }
    setTestResults((current) => ({ ...current, [connectionId]: result }))
    // OAuth discovery can refresh credentials or mark them as needing authorization.
    await load()
  }

  const replaceAccessToken = async (connectionId: string, token: string): Promise<boolean> => {
    setError(null)
    const outcome = await runConnectionAction('replace-token', connectionId, () =>
      externalSkillsApi.updateConnection(agentId, connectionId, { accessToken: token }))
    if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, 'Failed to replace the access token.'))
    }
    if (outcome.status !== 'applied') return false
    // A test result from the old token no longer describes this connection.
    setTestResults((current) => withoutTestResult(current, connectionId))
    void load()
    return true
  }

  const deleteConnection = async (connectionId: string) => {
    setError(null)
    const outcome = await runConnectionAction('delete', connectionId, () => externalSkillsApi.deleteConnection(agentId, connectionId))
    if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, 'Failed to delete MCP connection.'))
    } else if (outcome.status === 'applied') {
      const nextId = neighborConnectionId(connections, connectionId)
      restoreFocusRowId.current = nextId ? connectionRowDomId(nextId) : null
      setSelection(null)
      setConnections((current) => current.filter((connection) => connection.id !== connectionId))
    }
  }

  const closeDetail = () => {
    if (selectedConnection) restoreFocusRowId.current = connectionRowDomId(selectedConnection.id)
    setSelection(null)
  }

  const detailActions: McpConnectionActions = {
    isPending: (action, connectionId) => rowMutations.isPending(connectionActionKey(action, connectionId)),
    onBack: closeDetail,
    onTest: (connectionId) => void testConnection(connectionId),
    onAuthorize: (connectionId) => void authorizeConnection(connectionId),
    onReplaceToken: replaceAccessToken,
    onDelete: (connectionId) => void deleteConnection(connectionId),
  }

  const showConnectionForm = selectedConnection === null && (isAddingConnection || connections.length === 0)
  const canSaveConnection = isConnectionDraftComplete({
    displayName: connectionName,
    serverUrl,
    authMethod,
    accessToken,
    oauth: oauthDraft,
  })

  return (
    <section id="mcp-skill-connections" className="space-y-4">
      <div className="space-y-5">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {isLoading && !selectedConnection ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading connections...
          </div>
        ) : null}

        {selectedConnection ? (
          <McpConnectionDetail
            key={selectedConnection.id}
            connection={selectedConnection}
            testResult={testResults[selectedConnection.id]}
            isReloading={isLoading}
            actions={detailActions}
          />
        ) : connections.length > 0 ? (
          <QuietList>
            {connections.map((connection) => (
              <QuietListRow
                key={connection.id}
                domId={connectionRowDomId(connection.id)}
                title={connection.displayName}
                summary={connection.serverUrl}
                badge={connectionNeedsAttention(connection.status) ? <McpStatusBadge status={connection.status} /> : undefined}
                onOpen={() => setSelection({ agentId, connectionId: connection.id })}
              />
            ))}
          </QuietList>
        ) : null}

        {showConnectionForm ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-foreground">Add connection</h4>
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

            <Button type="button" onClick={() => void createConnection()} disabled={!canSaveConnection} loading={isCreating} icon={<CheckCircle2 />}>
              Save connection
            </Button>
          </div>
        ) : selectedConnection ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setIsAddingConnection(true)}>
            <Plus className="h-4 w-4" />
            Add connection
          </Button>
        )}
      </div>
    </section>
  )
}
