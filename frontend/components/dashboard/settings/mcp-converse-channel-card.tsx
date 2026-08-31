'use client'

import { useEffect, useMemo, useState } from 'react'
import { KeyRound, RefreshCw, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useMcpChannelSetup } from '@/components/dashboard/settings/mcp-channel-card'
import { CodeSnippet } from '@/components/shared/api-snippets'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  mcpConverseGrantsApi,
  type McpConverseGrant,
  type McpConverseGrantWithToken,
} from '@/lib/api-mcp-converse-grants'
import { buildConverseClientConfig } from '@/lib/mcp-converse-client-config'

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown'
  }
  return date.toLocaleString()
}

const normalizeIssuedGrant = ({ grant, token }: McpConverseGrantWithToken): {
  grant: McpConverseGrant
  token: string
} => ({
  token,
  grant: {
    ...grant,
    enabled: grant.enabled ?? true,
    lastUsedAt: grant.lastUsedAt ?? null,
    revokedAt: grant.revokedAt ?? null,
  },
})

export function McpConverseChannelCard({ agentId }: { agentId: string }) {
  const setup = useMcpChannelSetup()
  const [grants, setGrants] = useState<McpConverseGrant[]>([])
  const [issuedCredential, setIssuedCredential] = useState<{ grant: McpConverseGrant; token: string } | null>(null)
  const [label, setLabel] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await mcpConverseGrantsApi.list(agentId)
        if (active) {
          setGrants(response.grants)
        }
      } catch (loadError: unknown) {
        if (active) {
          setError(getApiErrorMessage(loadError, 'Failed to load MCP converse credentials.'))
        }
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [agentId])

  const clientConfig = useMemo(() => {
    if (!issuedCredential || setup.mode !== 'remote' || !setup.mcpUrl) {
      return ''
    }
    return buildConverseClientConfig(setup.mcpUrl, issuedCredential.token)
  }, [issuedCredential, setup.mcpUrl, setup.mode])

  const handleCreate = async () => {
    setIsCreating(true)
    setError(null)
    try {
      const issued = normalizeIssuedGrant(await mcpConverseGrantsApi.create(agentId, { label: label.trim() || undefined }))
      setIssuedCredential(issued)
      setGrants((current) => [issued.grant, ...current.filter((grant) => grant.id !== issued.grant.id)])
      setLabel('')
    } catch (createError: unknown) {
      setError(getApiErrorMessage(createError, 'Failed to create MCP converse credential.'))
    } finally {
      setIsCreating(false)
    }
  }

  const handleRotate = async (grantId: string) => {
    setBusyGrantId(grantId)
    setError(null)
    try {
      const issued = normalizeIssuedGrant(await mcpConverseGrantsApi.rotate(agentId, grantId))
      setIssuedCredential(issued)
      setGrants((current) => current.map((grant) => (grant.id === issued.grant.id ? issued.grant : grant)))
    } catch (rotateError: unknown) {
      setError(getApiErrorMessage(rotateError, 'Failed to rotate MCP converse credential.'))
    } finally {
      setBusyGrantId(null)
    }
  }

  const handleRevoke = async (grantId: string) => {
    setBusyGrantId(grantId)
    setError(null)
    try {
      await mcpConverseGrantsApi.revoke(agentId, grantId)
      setGrants((current) => current.filter((grant) => grant.id !== grantId))
      setIssuedCredential((current) => (current?.grant.id === grantId ? null : current))
    } catch (revokeError: unknown) {
      setError(getApiErrorMessage(revokeError, 'Failed to revoke MCP converse credential.'))
    } finally {
      setBusyGrantId(null)
    }
  }

  return (
    <SettingsCard
      icon={<KeyRound className="h-5 w-5 text-primary" />}
      title="MCP converse credential"
      description="Mint a per-agent bearer token for customers who need an MCP client that can converse with this agent."
    >
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-2">
            <Label htmlFor="mcpConverseGrantLabel">Credential label</Label>
            <Input
              id="mcpConverseGrantLabel"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Customer name or client"
            />
          </div>
          <div className="flex items-end">
            <Button type="button" onClick={() => void handleCreate()} disabled={isCreating}>
              {isCreating ? <Spinner className="mr-2 h-4 w-4" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Create credential
            </Button>
          </div>
        </div>

        {setup.mode === 'disabled' ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {setup.error ?? 'MCP is not available for this deployment.'}
          </p>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {issuedCredential ? (
          <div className="space-y-3 rounded-xl bg-muted/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Shown once</Badge>
              <p className="text-sm text-muted-foreground">
                Copy this token now. Radioso will not show the plaintext token again after you leave this page.
              </p>
            </div>
            <CopyValueField
              label="Converse grant token"
              value={issuedCredential.token}
              ariaLabel="Copy MCP converse grant token"
              className="w-full"
              truncate
            />
            {clientConfig ? <CodeSnippet label="MCP converse client config" code={clientConfig} /> : null}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-foreground">Existing credentials</Label>
            {isLoading ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" />
                Loading
              </span>
            ) : null}
          </div>
          {!isLoading && grants.length === 0 ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              No MCP converse credentials have been created for this agent.
            </p>
          ) : null}
          <div className="space-y-2">
            {grants.map((grant) => (
              <div key={grant.id} className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{grant.label || 'Unlabeled credential'}</p>
                    <Badge variant={grant.revokedAt || !grant.enabled ? 'secondary' : 'outline'}>
                      {grant.revokedAt || !grant.enabled ? 'Revoked' : 'Active'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Prefix {grant.tokenPrefix} | Created {formatTimestamp(grant.createdAt)} | Last used {formatTimestamp(grant.lastUsedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRotate(grant.id)}
                    disabled={busyGrantId === grant.id || Boolean(grant.revokedAt) || !grant.enabled}
                  >
                    {busyGrantId === grant.id ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Rotate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRevoke(grant.id)}
                    disabled={busyGrantId === grant.id || Boolean(grant.revokedAt)}
                  >
                    {busyGrantId === grant.id ? <Spinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
