'use client'

import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw, Trash2 } from 'lucide-react'

import { OneTimeSecretDialog, defaultExpiryDate, expiryHint } from '@/components/dashboard/settings/api-access-dialogs'
import { CodeSnippet } from '@/components/shared/api-snippets'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  agentChannelCredentialsApi,
  type AgentChannelCredential,
  type AgentChannelCredentialAudience,
} from '@/lib/api-agent-channel-credentials'
import { getApiErrorMessage } from '@/lib/api-error'

const formatTimestamp = (value: string | null) => {
  if (!value) return 'Never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString()
}

const expiryInputToIso = (value: string) => {
  const expiry = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null
}

type CredentialAction = {
  type: 'rotate' | 'revoke'
  credential: AgentChannelCredential
}

export function AgentChannelCredentialManager({
  agentId,
  audience,
  secretConfiguration,
}: {
  agentId: string
  audience: AgentChannelCredentialAudience
  secretConfiguration?: {
    label: string
    buildCode: (secret: string) => string
  }
}) {
  const [credentials, setCredentials] = useState<AgentChannelCredential[]>([])
  const [issued, setIssued] = useState<{ credential: AgentChannelCredential; secret: string } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState(() => defaultExpiryDate(90))
  const [isLoading, setIsLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [busyCredentialId, setBusyCredentialId] = useState<string | null>(null)
  const [credentialAction, setCredentialAction] = useState<CredentialAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scopeGeneration = useRef(0)

  useEffect(() => {
    const generation = scopeGeneration.current + 1
    scopeGeneration.current = generation
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- scope changes clear agent-bound state before loading the new scope.
    setCredentials([])
    setIssued(null)
    setAcknowledged(false)
    setLabel('')
    setExpiry(defaultExpiryDate(90))
    setIsLoadingMore(false)
    setIsCreating(false)
    setCredentialAction(null)
    setBusyCredentialId(null)
    setError(null)
    setNextCursor(null)
    setIsLoading(true)
    void agentChannelCredentialsApi.list(agentId, audience)
      .then((response) => {
        if (active && scopeGeneration.current === generation) {
          setCredentials(response.credentials)
          setNextCursor(response.nextCursor)
        }
      })
      .catch((loadError: unknown) => {
        if (active && scopeGeneration.current === generation) {
          setError(getApiErrorMessage(loadError, `Failed to load ${audience === 'mcp' ? 'MCP' : 'Agent API'} credentials.`))
        }
      })
      .finally(() => {
        if (active && scopeGeneration.current === generation) setIsLoading(false)
      })
    return () => {
      active = false
      if (scopeGeneration.current === generation) scopeGeneration.current += 1
    }
  }, [agentId, audience])

  const loadMore = async () => {
    if (!nextCursor || isLoadingMore) return
    const generation = scopeGeneration.current
    setIsLoadingMore(true)
    setError(null)
    try {
      const response = await agentChannelCredentialsApi.list(agentId, audience, { cursor: nextCursor })
      if (scopeGeneration.current !== generation) return
      setCredentials((current) => [...current, ...response.credentials.filter((incoming) => !current.some((existing) => existing.id === incoming.id))])
      setNextCursor(response.nextCursor)
    } catch (loadError: unknown) {
      if (scopeGeneration.current === generation) {
        setError(getApiErrorMessage(loadError, `Failed to load more ${audience === 'mcp' ? 'MCP' : 'Agent API'} credentials.`))
      }
    } finally {
      if (scopeGeneration.current === generation) setIsLoadingMore(false)
    }
  }

  const secretConfigurationCode = issued && secretConfiguration
    ? secretConfiguration.buildCode(issued.secret)
    : ''

  const issue = async () => {
    const expiresAt = expiryInputToIso(expiry)
    if (!label.trim() || !expiresAt) return
    const generation = scopeGeneration.current
    setIsCreating(true)
    setError(null)
    try {
      const next = await agentChannelCredentialsApi.issue(agentId, {
        audience,
        label: label.trim(),
        expiresAt,
      })
      if (scopeGeneration.current !== generation) return
      setIssued(next)
      setCredentials((current) => [next.credential, ...current.filter((credential) => credential.id !== next.credential.id)])
      setLabel('')
    } catch (createError: unknown) {
      if (scopeGeneration.current === generation) {
        setError(getApiErrorMessage(createError, `Failed to create ${audience === 'mcp' ? 'MCP' : 'Agent API'} credential.`))
      }
    } finally {
      if (scopeGeneration.current === generation) setIsCreating(false)
    }
  }

  const rotate = async (credentialId: string) => {
    const generation = scopeGeneration.current
    setBusyCredentialId(credentialId)
    setError(null)
    try {
      const next = await agentChannelCredentialsApi.rotate(agentId, credentialId)
      if (scopeGeneration.current !== generation) return false
      setIssued(next)
      setCredentials((current) => current.map((credential) => credential.id === next.credential.id ? next.credential : credential))
      return true
    } catch (rotateError: unknown) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.'))
      return false
    } finally {
      if (scopeGeneration.current === generation) setBusyCredentialId(null)
    }
  }

  const revoke = async (credentialId: string) => {
    const generation = scopeGeneration.current
    setBusyCredentialId(credentialId)
    setError(null)
    try {
      await agentChannelCredentialsApi.revoke(agentId, credentialId)
      if (scopeGeneration.current !== generation) return false
      setCredentials((current) => current.map((credential) => credential.id === credentialId
        ? { ...credential, status: 'revoked', revokedAt: new Date().toISOString() }
        : credential))
      setIssued((current) => current?.credential.id === credentialId ? null : current)
      return true
    } catch (revokeError: unknown) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.'))
      return false
    } finally {
      if (scopeGeneration.current === generation) setBusyCredentialId(null)
    }
  }

  const audienceName = audience === 'mcp' ? 'MCP' : 'Agent API'

  const confirmCredentialAction = async () => {
    if (!credentialAction) return
    const succeeded = credentialAction.type === 'rotate'
      ? await rotate(credentialAction.credential.id)
      : await revoke(credentialAction.credential.id)
    if (succeeded) setCredentialAction(null)
  }

  return (
    <div className="space-y-5 border-t border-border pt-5">
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">{audienceName} credentials</h4>
        <p className="text-xs text-muted-foreground">
          Bound to this agent and accepted only by the {audience === 'mcp' ? 'MCP chat' : 'Agent API chat'} channel. No workspace role is carried by this credential.
        </p>
      </div>

      <div className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_11rem_auto]">
        <div className="space-y-1.5">
          <Label htmlFor={`${audience}-credential-label`}>Credential label</Label>
          <Input
            id={`${audience}-credential-label`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={audience === 'mcp' ? 'Claude Desktop' : 'Production chat client'}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${audience}-credential-expiry`}>Expires</Label>
          <Input id={`${audience}-credential-expiry`} type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        </div>
        <Button type="button" onClick={() => void issue()} disabled={isCreating || !label.trim() || !expiry}>
          {isCreating ? <Spinner className="mr-2 h-4 w-4" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Create credential
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{expiryHint}</p>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      {issued ? (
        <OneTimeSecretDialog
          response={issued}
          acknowledged={acknowledged}
          onAcknowledged={setAcknowledged}
          onClose={() => {
            setIssued(null)
            setAcknowledged(false)
          }}
          copyAriaLabel={`Copy ${audienceName} credential secret`}
          additionalContent={secretConfigurationCode ? <CodeSnippet label={secretConfiguration?.label ?? 'Client config'} code={secretConfigurationCode} /> : undefined}
        />
      ) : null}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-foreground">Existing credentials</Label>
          {isLoading ? <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="h-3.5 w-3.5" />Loading</span> : null}
        </div>
        {!isLoading && credentials.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">No {audienceName} credentials yet.</p>
        ) : null}
        <div className="space-y-2">
          {credentials.map((credential) => {
            const active = credential.status === 'active'
            return (
              <div key={credential.id} className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{credential.label}</p>
                    <Badge variant={active ? 'outline' : 'secondary'}>{credential.status}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Prefix {credential.prefix} · Created {formatTimestamp(credential.createdAt)} · Expires {formatTimestamp(credential.expiresAt)} · Last used {formatTimestamp(credential.lastUsedAt)} · Revoked {formatTimestamp(credential.revokedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setCredentialAction({ type: 'rotate', credential })} disabled={busyCredentialId === credential.id || !active}>
                    {busyCredentialId === credential.id ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}Rotate
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setCredentialAction({ type: 'revoke', credential })} disabled={busyCredentialId === credential.id || !active}>
                    {busyCredentialId === credential.id ? <Spinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}Revoke
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        {nextCursor ? <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={isLoadingMore}>
          {isLoadingMore ? <Spinner className="mr-2 h-4 w-4" /> : null}Load more
        </Button> : null}
      </div>

      <AlertDialog
        open={credentialAction !== null}
        onOpenChange={(open) => {
          if (!open && !busyCredentialId) setCredentialAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {credentialAction?.type === 'rotate'
                ? `Rotate ${credentialAction.credential.label}?`
                : `Revoke ${credentialAction?.credential.label ?? 'credential'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {credentialAction?.type === 'rotate'
                ? 'The current secret will stop working immediately. The replacement secret is shown only once, so update the client before leaving this page.'
                : 'This credential will stop working immediately and cannot be restored. Create a new credential if this client needs access again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyCredentialId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyCredentialId)}
              className={credentialAction?.type === 'revoke' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
              onClick={(event) => {
                event.preventDefault()
                void confirmCredentialAction()
              }}
            >
              {busyCredentialId ? <Spinner className="mr-2 h-4 w-4" /> : credentialAction?.type === 'rotate' ? <RefreshCw className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {credentialAction?.type === 'rotate' ? 'Rotate credential' : 'Revoke credential'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
