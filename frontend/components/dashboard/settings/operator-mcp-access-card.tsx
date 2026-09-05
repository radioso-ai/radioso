'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, X } from 'lucide-react'

import { getApiErrorMessage } from '@/lib/api-error'
import {
  operatorMcpApi,
  type OperatorMcpClientSetupArtifact,
  type OperatorMcpGrantSummary,
  type OperatorMcpSetupResponse,
} from '@/lib/api-operator-mcp'
import { useRuntimeConfig } from '@/hooks/use-runtime-config'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsCard } from './settings-card'
import { EmptyRows } from './api-access-rows'
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

export const isOperatorMcpResource = (value: string): boolean => {
  try {
    const url = new URL(value)
    const localDevelopment = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return (url.protocol === 'https:' || localDevelopment) && url.pathname === '/operator/mcp' && !url.search && !url.hash
  } catch {
    return false
  }
}

export const selectOperatorMcpArtifactId = (
  artifacts: ReadonlyArray<Pick<OperatorMcpClientSetupArtifact, 'id' | 'status'>>,
  currentId: string | null,
): string | null => {
  const current = artifacts.find((artifact) => artifact.id === currentId)
  if (current && current.status !== 'unavailable') return current.id
  return artifacts.find((artifact) => artifact.status !== 'unavailable')?.id ?? artifacts[0]?.id ?? null
}

const availabilityLabel: Record<OperatorMcpSetupResponse['availability'], string> = {
  available: 'Available',
  disabled: 'Disabled',
  misconfigured: 'Misconfigured',
  unavailable: 'Unavailable',
}

const statusVariant = (status: OperatorMcpGrantSummary['status']) =>
  status === 'active' ? 'secondary' as const : 'outline' as const

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never'

function ArtifactSetup({ artifact, resource }: { artifact: OperatorMcpClientSetupArtifact; resource: string }) {
  const value = artifact.command ?? artifact.configuration ?? resource
  const label = artifact.command ? 'Command' : artifact.configuration ? 'Configuration' : 'MCP URL'

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{artifact.description}</p>
        <Badge variant={artifact.status === 'verified' ? 'secondary' : 'outline'}>{artifact.status === 'verified' ? 'Verified' : 'Not verified'}</Badge>
      </div>
      <CopyValueField label={label} value={value} ariaLabel={`Copy ${artifact.displayName} setup`} className="w-full font-mono text-xs" wrap={Boolean(artifact.configuration)} />
    </div>
  )
}

function GrantInventory({ workspaceId, grants, onRefresh }: { workspaceId: string; grants: OperatorMcpGrantSummary[]; onRefresh: () => void }) {
  const [selected, setSelected] = useState<OperatorMcpGrantSummary | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<OperatorMcpGrantSummary | null>(null)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof operatorMcpApi.getGrant>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openDetail = async (grant: OperatorMcpGrantSummary) => {
    setSelected(grant)
    setError(null)
    try {
      setDetail(await operatorMcpApi.getGrant(workspaceId, grant.id))
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Could not load grant details.'))
    }
  }

  const revoke = async () => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      await operatorMcpApi.revokeGrant(workspaceId, selected.id)
      setSelected(null)
      setDetail(null)
      onRefresh()
    } catch (revokeError) {
      setError(getApiErrorMessage(revokeError, 'Could not revoke this grant.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3" id="operator-mcp-grants">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
        <h4 className="font-medium text-foreground">Authorized clients</h4>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {grants.length === 0 ? <p className="text-sm text-muted-foreground">No operator MCP grants yet. A client appears here only after OAuth consent completes.</p> : (
        <div className="divide-y rounded-xl border border-border">
          {grants.map((grant) => (
            <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{grant.clientName}</p>
                <p className="text-xs text-muted-foreground">{grant.userName ?? 'Current user'} · Created {formatDate(grant.createdAt)} · Last used {formatDate(grant.lastUsedAt)}</p>
                <div className="mt-1 flex flex-wrap gap-1">{grant.scopes.map((scope) => <Badge key={scope} variant="outline" className="text-[10px]">{scope}</Badge>)}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={statusVariant(grant.status)}>{grant.status}</Badge>
                <Button type="button" size="sm" variant="ghost" onClick={() => void openDetail(grant)}>Inspect</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {selected ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{selected.clientName}</CardTitle>
              <p className="text-sm text-muted-foreground">Safe grant metadata only — credentials are never shown.</p>
            </div>
            <Button type="button" size="icon" variant="ghost" aria-label="Close grant details" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {detail ? (
              <dl className="grid gap-2 sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Client ID</dt><dd className="break-all font-mono text-xs">{detail.clientId}</dd></div>
                <div><dt className="text-muted-foreground">Redirect host</dt><dd>{detail.redirectHost}</dd></div>
                <div><dt className="text-muted-foreground">Workspace</dt><dd>{detail.workspaceName}</dd></div>
                <div><dt className="text-muted-foreground">Recent invocations</dt><dd>{detail.recentInvocationCount}</dd></div>
              </dl>
            ) : <Spinner className="h-4 w-4" />}
            {selected.canRevoke && selected.status === 'active' ? <Button type="button" variant="destructive" onClick={() => setRevokeTarget(selected)}>Revoke grant</Button> : null}
          </CardContent>
        </Card>
      ) : null}
      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Revoke grant?</AlertDialogTitle><AlertDialogDescription>All credentials for {revokeTarget?.clientName ?? 'this client'} stop working immediately. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { setRevokeTarget(null); void revoke() }} disabled={busy}>Revoke grant</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function OperatorMcpAccessCard({ workspaceId }: { workspaceId: string }) {
  const runtime = useRuntimeConfig()
  const [setup, setSetup] = useState<OperatorMcpSetupResponse | null>(null)
  const [grants, setGrants] = useState<OperatorMcpGrantSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextSetup, nextGrants] = await Promise.all([
        operatorMcpApi.getSetup(workspaceId),
        operatorMcpApi.listGrants(workspaceId),
      ])
      setSetup(nextSetup)
      setGrants(nextGrants.grants)
      setSelectedArtifactId((current) => selectOperatorMcpArtifactId(nextSetup.artifacts, current))
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Could not load operator MCP access.'))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    const task = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(task)
  }, [load])

  const configuredResource = runtime.operatorMcpUrl.trim()
  const resource = setup?.resource ?? configuredResource
  const configured = runtime.isResolved && runtime.status === 'resolved' && isOperatorMcpResource(configuredResource)
  return (
    <SettingsCard
      id="operator-mcp"
      icon={<KeyRound className="h-5 w-5 text-primary" />}
      title="Connect an MCP client"
      description="Choose your client, paste the setup, and sign in."
      headerEnd={<Badge variant={configured && setup?.availability === 'available' ? 'secondary' : 'outline'}>{setup ? availabilityLabel[setup.availability] : 'Checking'}</Badge>}
    >
      {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> Checking deployment and grants…</div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!loading && setup && (!configured || setup.availability !== 'available' || !resource || !isOperatorMcpResource(resource)) ? (
        <EmptyRows>
          {setup.message ?? 'Ask an administrator to configure the canonical HTTPS operator MCP resource. No personal credential is needed as a workaround.'}
        </EmptyRows>
      ) : null}
      {!loading && setup && configured && setup.availability === 'available' && resource && isOperatorMcpResource(resource) ? (
        <div className="space-y-5">
          <Tabs value={selectedArtifactId ?? undefined} onValueChange={setSelectedArtifactId}>
            <TabsList aria-label="MCP client" className="w-full sm:w-fit">
              {setup.artifacts.map((item) => <TabsTrigger key={item.id} value={item.id}>{item.displayName}</TabsTrigger>)}
            </TabsList>
            {setup.artifacts.map((item) => (
              <TabsContent key={item.id} value={item.id}>
                <ArtifactSetup artifact={item} resource={resource} />
              </TabsContent>
            ))}
          </Tabs>
          <GrantInventory workspaceId={workspaceId} grants={grants} onRefresh={() => void load()} />
        </div>
      ) : null}
    </SettingsCard>
  )
}
