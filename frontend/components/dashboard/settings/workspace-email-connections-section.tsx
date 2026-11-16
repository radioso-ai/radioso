'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Mail, RefreshCw } from 'lucide-react'

import {
  EmailConnectionDetailSheet,
  type EmailConnectionSheetActions,
} from '@/components/dashboard/settings/email-connection-detail-sheet'
import {
  EMAIL_PROVIDERS,
  emailConnectionRowDomId,
  emailConnectionRowSummary,
  hasEmailConnectionProblem,
  providerLabel,
  statusLabel,
  statusTone,
  type EmailConnectionHealth,
} from '@/components/dashboard/settings/email-connection-rows'
import { QuietList, QuietListRow } from '@/components/dashboard/settings/quiet-list'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useScopedRowMutations } from '@/components/dashboard/settings/use-scoped-row-mutations'
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
import { Switch } from '@/components/ui/switch'
import {
  customerEmailApi,
  type CustomerEmailConnection,
  type CustomerEmailOauthProviderId,
  type WorkspaceOauthConnection,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

// The sheet holds which connection it shows, not a copy of it, so a toggle or reload shows the
// current connection and a deleted one closes the sheet. A selection belongs to one workspace.
type SheetSelection = { workspaceId: string; connectionId: string }

export function WorkspaceEmailConnectionsSection({ workspaceId }: { workspaceId: string | null }) {
  const [providerId, setProviderId] = useState<CustomerEmailOauthProviderId>('google_mail')
  const provider = useMemo(
    () => EMAIL_PROVIDERS.find((candidate) => candidate.id === providerId) ?? EMAIL_PROVIDERS[0],
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
  const [sheetSelection, setSheetSelection] = useState<SheetSelection | null>(null)
  const [checkingHealthIds, setCheckingHealthIds] = useState<ReadonlySet<string>>(() => new Set())
  const [healthResult, setHealthResult] = useState<{ connectionId: string; health: EmailConnectionHealth } | null>(null)
  // Only the latest read may land: two rows acted on back to back each reload the list.
  const loadVersion = useRef(0)
  // The newest read, so a read that is superseded can wait for the one that replaced it.
  const latestRead = useRef<Promise<void>>(Promise.resolve())
  // The current workspace, readable from a reload started by a render before a workspace switch.
  const workspaceIdRef = useRef(workspaceId)
  useEffect(() => {
    workspaceIdRef.current = workspaceId
  }, [workspaceId])
  const rowMutations = useScopedRowMutations(workspaceId ?? '')

  // Memoized: the sheet keeps the last connection it showed, compared by identity.
  const sheetConnection = useMemo(
    () => (sheetSelection && sheetSelection.workspaceId === workspaceId
      ? emailConnections.find((connection) => connection.id === sheetSelection.connectionId) ?? null
      : null),
    [sheetSelection, workspaceId, emailConnections],
  )

  const authorizedOauthConnections = oauthConnections.filter((connection) => connection.status === 'authorized')

  const readConnections = async () => {
    const version = ++loadVersion.current
    if (!workspaceId) {
      setOauthConnections([])
      setEmailConnections([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const [oauthResult, emailResult] = await Promise.all([
        customerEmailApi.listOauthConnections(workspaceId),
        customerEmailApi.listEmailConnections(workspaceId),
      ])
      if (workspaceIdRef.current !== workspaceId) return
      if (version !== loadVersion.current) return await latestRead.current
      setOauthConnections(oauthResult.connections)
      setEmailConnections(emailResult.connections)
      setSelectedOauthConnectionId((current) => {
        if (current && oauthResult.connections.some((connection) => connection.id === current)) {
          return current
        }
        return oauthResult.connections.find((connection) => connection.status === 'authorized')?.id ?? ''
      })
    } catch (loadError) {
      if (workspaceIdRef.current !== workspaceId) return
      if (version !== loadVersion.current) return await latestRead.current
      setError(getApiErrorMessage(loadError, 'Failed to load email connections.'))
    } finally {
      if (version === loadVersion.current) setIsLoading(false)
    }
  }

  // Resolves once the list on screen reflects a read started after this call: a read that a newer
  // one superseded waits for it. A call from a render before a workspace switch reads nothing, so
  // it can neither write the old workspace's list nor invalidate the new workspace's read.
  const loadConnections = (): Promise<void> => {
    if (workspaceIdRef.current !== workspaceId) return Promise.resolve()
    const read = readConnections()
    latestRead.current = read
    return read
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

  // A row action holds its own row's controls until its own request and a reload that shows its
  // result settle, so acting on a second connection never releases the first one's.
  const runRowAction = async <T,>(
    connectionId: string,
    mutate: () => Promise<T>,
    fallbackMessage: string,
  ): Promise<{ applied: true; value: T } | { applied: false }> => {
    if (!workspaceId) {
      return { applied: false }
    }
    setError(null)
    setHealthResult(null)
    const outcome = await rowMutations.run(connectionId, async () => {
      const value = await mutate()
      await loadConnections()
      return value
    })
    if (outcome.status === 'failed') {
      setError(getApiErrorMessage(outcome.error, fallbackMessage))
    }
    return outcome.status === 'applied' ? { applied: true, value: outcome.value } : { applied: false }
  }

  const updateDisabled = async (connection: CustomerEmailConnection, disabled: boolean) => {
    await runRowAction(
      connection.id,
      () => customerEmailApi.updateEmailConnection(workspaceId!, connection.id, { disabled }),
      disabled ? 'Failed to disable customer email connection.' : 'Failed to re-enable customer email connection.',
    )
  }

  const checkHealth = async (connection: CustomerEmailConnection) => {
    setCheckingHealthIds((current) => new Set(current).add(connection.id))
    try {
      const result = await runRowAction(
        connection.id,
        () => customerEmailApi.checkEmailConnectionHealth(workspaceId!, connection.id),
        'Failed to check customer email connection health.',
      )
      if (result.applied) {
        setHealthResult({ connectionId: connection.id, health: result.value.connection.lastHealthStatus ?? 'unknown' })
      }
    } finally {
      setCheckingHealthIds((current) => {
        const next = new Set(current)
        next.delete(connection.id)
        return next
      })
    }
  }

  const deleteConnection = async (connection: CustomerEmailConnection) => {
    const result = await runRowAction(
      connection.id,
      () => customerEmailApi.deleteEmailConnection(workspaceId!, connection.id),
      'Failed to delete customer email connection.',
    )
    if (result.applied) {
      // The operator may have opened another connection while this one was being deleted.
      setSheetSelection((current) => (current?.connectionId === connection.id ? null : current))
    }
  }

  const openSheet = (connection: CustomerEmailConnection) => {
    if (!workspaceId) return
    setError(null)
    setHealthResult(null)
    setSheetSelection({ workspaceId, connectionId: connection.id })
  }

  const closeSheet = () => {
    setHealthResult(null)
    setSheetSelection(null)
  }

  const sheetActions: EmailConnectionSheetActions = {
    isRowPending: rowMutations.isPending,
    isCheckingHealth: (connectionId) => checkingHealthIds.has(connectionId),
    onToggleEnabled: (connection, enabled) => void updateDisabled(connection, !enabled),
    onCheckHealth: (connection) => void checkHealth(connection),
    onDelete: (connection) => void deleteConnection(connection),
  }

  return (
    <SettingsCard
      id="customer-email"
      icon={<Mail className="h-5 w-5 text-primary" />}
      title="Customer email"
      description="Authorize customer-owned mail and configure outbound connections for constrained email skills."
      headerEnd={
        emailConnections.length > 0 ? (
          <Badge className={statusTone(emailConnections[0].status)} variant="secondary">
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
                const nextProvider = EMAIL_PROVIDERS.find((candidate) => candidate.id === nextProviderId) ?? EMAIL_PROVIDERS[0]
                setProviderId(nextProviderId)
                setDisplayName(nextProvider.defaultName)
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_PROVIDERS.map((candidate) => (
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
            disabled={!workspaceId}
            loading={busyAction === 'authorize'} icon={<ExternalLink />}
            className="md:self-end"
          >
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
                    disabled={!workspaceId}
                    loading={busyAction === `reauthorize:${connection.id}`} icon={<RefreshCw />}
                  >
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
              disabled={!workspaceId || !selectedOauthConnectionId || !senderEmail.trim() || !connectionName.trim()}
              loading={busyAction === 'create'} icon={<Mail />}
            >
              Create connection
            </Button>
          </div>
        </div>

        {emailConnections.length > 0 ? (
          <QuietList>
            {emailConnections.map((connection) => (
              <QuietListRow
                key={connection.id}
                domId={emailConnectionRowDomId(connection.id)}
                title={connection.displayName}
                summary={emailConnectionRowSummary(connection)}
                isDimmed={connection.status === 'disabled'}
                onOpen={() => openSheet(connection)}
                lead={(
                  <Switch
                    checked={connection.status !== 'disabled'}
                    onCheckedChange={(enabled) => void updateDisabled(connection, !enabled)}
                    disabled={rowMutations.isPending(connection.id)}
                    aria-label={`Enable ${connection.displayName}`}
                  />
                )}
                badge={hasEmailConnectionProblem(connection.status) ? (
                  <Badge className={statusTone(connection.status)} variant="secondary">
                    {statusLabel(connection.status)}
                  </Badge>
                ) : undefined}
              />
            ))}
          </QuietList>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading email connections
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <EmailConnectionDetailSheet
        target={sheetConnection}
        error={error}
        healthResult={healthResult}
        actions={sheetActions}
        onClose={closeSheet}
      />
    </SettingsCard>
  )
}
