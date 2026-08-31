'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Plus, Server, ShieldCheck, Trash2 } from 'lucide-react'

import { apiAccessApi, type ApiAccessSummary, type ApiCredentialMetadata, type OneTimeCredentialResponse, type ServiceAccountSummary } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/auth-context'
import { SettingsCard } from './settings-card'

const defaultExpiry = (days: number) => {
  const date = new Date()
  // Date inputs are submitted at 23:59 UTC; stay inside the server's exact
  // rolling lifetime rather than crossing it later in the selected day.
  date.setDate(date.getDate() + Math.max(1, days - 1))
  return date.toISOString().slice(0, 10)
}

const formatDate = (value: string | null) => value ? new Date(value).toLocaleDateString() : 'Never'

export function ApiAccessPanel({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { user } = useAuth()
  const [summary, setSummary] = useState<ApiAccessSummary | null>(null)
  const [personalTokens, setPersonalTokens] = useState<ApiCredentialMetadata[]>([])
  const [personalPage, setPersonalPage] = useState(1)
  const [personalTotal, setPersonalTotal] = useState(0)
  const [serviceAccounts, setServiceAccounts] = useState<ServiceAccountSummary[]>([])
  const [servicePage, setServicePage] = useState(1)
  const [serviceTotal, setServiceTotal] = useState(0)
  const [personalLabel, setPersonalLabel] = useState('')
  const [personalRole, setPersonalRole] = useState<'member' | 'admin'>('member')
  const [personalExpiry, setPersonalExpiry] = useState(defaultExpiry(90))
  const [personalFormOpen, setPersonalFormOpen] = useState(false)
  const [serviceName, setServiceName] = useState('')
  const [serviceFormOpen, setServiceFormOpen] = useState(false)
  const [serviceRole, setServiceRole] = useState<'member' | 'admin'>('member')
  const [serviceCredentialLabel, setServiceCredentialLabel] = useState('Initial credential')
  const [serviceExpiry, setServiceExpiry] = useState(defaultExpiry(365))
  const [selectedServiceAccount, setSelectedServiceAccount] = useState<ServiceAccountSummary | null>(null)
  const [serviceCredentials, setServiceCredentials] = useState<ApiCredentialMetadata[]>([])
  const [serviceCredentialPage, setServiceCredentialPage] = useState(1)
  const [serviceCredentialTotal, setServiceCredentialTotal] = useState(0)
  const [additionalCredentialLabel, setAdditionalCredentialLabel] = useState('')
  const [additionalCredentialExpiry, setAdditionalCredentialExpiry] = useState(defaultExpiry(365))
  const [oneTime, setOneTime] = useState<OneTimeCredentialResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canManageServices = summary?.capabilities.manageServiceAccounts === true
  const canManagePersonal = summary?.capabilities.manageOwnPersonalTokens !== false
  const canAudit = summary?.capabilities.auditWorkspacePersonalTokens === true
  const canViewPersonal = canManagePersonal || canAudit
  const selectedPersonalRole = personalRole === 'admin' && summary?.effectiveRole === 'member' ? 'member' : personalRole
  const isOwnPersonalToken = (credential: ApiCredentialMetadata) => credential.ownerUserId === user?.userId

  const load = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    setError(null)
    try {
      const nextSummary = await apiAccessApi.getSummary(workspaceId)
      setSummary(nextSummary)
      const personal = await apiAccessApi.listPersonalTokens(workspaceId, {
        view: nextSummary.capabilities.auditWorkspacePersonalTokens ? 'workspace' : 'mine',
        page: personalPage,
      })
      setPersonalTokens(personal.items)
      setPersonalTotal(personal.total)
      if (nextSummary.capabilities.manageServiceAccounts) {
        const services = await apiAccessApi.listServiceAccounts(workspaceId, { page: servicePage })
        setServiceAccounts(services.items)
        setServiceTotal(services.total)
      } else {
        setServiceAccounts([])
        setServiceTotal(0)
      }
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Failed to load API access.'))
    } finally {
      setIsLoading(false)
    }
  }, [personalPage, servicePage, workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- workspace changes clear the one-time secret.
    setOneTime(null)
    setAcknowledged(false)
    void load()
  }, [load])

  const showSecret = (response: OneTimeCredentialResponse) => {
    setOneTime(response)
    setAcknowledged(false)
  }

  const createPersonal = async () => {
    if (!workspaceId || !personalLabel.trim()) return
    if (!window.confirm(`Issue a ${selectedPersonalRole} personal token that expires on ${personalExpiry}? The secret will be shown once.`)) return
    setIsCreating(true)
    setError(null)
    try {
      const response = await apiAccessApi.createPersonalToken(workspaceId, {
        label: personalLabel.trim(), roleCeiling: selectedPersonalRole, expiresAt: new Date(`${personalExpiry}T23:59:59Z`).toISOString(),
      })
      showSecret(response)
      setPersonalLabel('')
      setPersonalFormOpen(false)
      await load()
    } catch (createError) {
      setError(getApiErrorMessage(createError, 'Failed to issue personal token.'))
    } finally {
      setIsCreating(false)
    }
  }

  const createService = async () => {
    if (!workspaceId || !serviceName.trim() || !serviceCredentialLabel.trim()) return
    if (!window.confirm(`Create the ${serviceRole} service account “${serviceName.trim()}” and issue its first credential?`)) return
    setIsCreating(true)
    setError(null)
    try {
      const response = await apiAccessApi.createServiceAccount(workspaceId, {
        displayName: serviceName.trim(), role: serviceRole,
        initialCredential: { label: serviceCredentialLabel.trim(), expiresAt: new Date(`${serviceExpiry}T23:59:59Z`).toISOString() },
      })
      showSecret({ credential: response.credential, secret: response.secret })
      setServiceName('')
      setServiceFormOpen(false)
      await load()
    } catch (createError) {
      setError(getApiErrorMessage(createError, 'Failed to create service account.'))
    } finally {
      setIsCreating(false)
    }
  }

  const revokePersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !window.confirm(`Revoke ${credential.label}?`)) return
    try {
      await apiAccessApi.revokePersonalToken(workspaceId, credential.id)
      await load()
    } catch (revokeError) {
      setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.'))
    }
  }

  const relabelPersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId) return
    const label = window.prompt('New token label', credential.label)?.trim()
    if (!label || label === credential.label) return
    try { await apiAccessApi.relabelPersonalToken(workspaceId, credential.id, label, credential.revision); await load() } catch (relabelError) { setError(getApiErrorMessage(relabelError, 'Failed to relabel credential.')) }
  }

  const rotatePersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !window.confirm(`Rotate ${credential.label}? The current secret stops working immediately.`)) return
    try { showSecret(await apiAccessApi.rotatePersonalToken(workspaceId, credential.id, credential.revision)); await load() } catch (rotateError) { setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.')) }
  }

  const selectServiceAccount = async (account: ServiceAccountSummary, page = serviceCredentialPage) => {
    if (!workspaceId) return
    try {
      const [current, credentials] = await Promise.all([
        apiAccessApi.getServiceAccount(workspaceId, account.id),
        apiAccessApi.listServiceCredentials(workspaceId, account.id, { page }),
      ])
      setSelectedServiceAccount(current)
      setServiceCredentials(credentials.items)
      setServiceCredentialPage(page)
      setServiceCredentialTotal(credentials.total)
    } catch (credentialsError) {
      setError(getApiErrorMessage(credentialsError, 'Failed to load service credentials.'))
    }
  }

  const issueAdditionalCredential = async () => {
    if (!workspaceId || !selectedServiceAccount || !additionalCredentialLabel.trim()) return
    if (!window.confirm(`Issue another credential for ${selectedServiceAccount.displayName}? The secret will be shown once.`)) return
    try {
      showSecret(await apiAccessApi.issueServiceCredential(workspaceId, selectedServiceAccount.id, { label: additionalCredentialLabel.trim(), expiresAt: new Date(`${additionalCredentialExpiry}T23:59:59Z`).toISOString() }))
      setAdditionalCredentialLabel('')
      await selectServiceAccount(selectedServiceAccount)
    } catch (issueError) { setError(getApiErrorMessage(issueError, 'Failed to issue credential.')) }
  }

  const revokeServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount || !window.confirm(`Revoke ${credential.label}?`)) return
    try { await apiAccessApi.revokeServiceCredential(workspaceId, selectedServiceAccount.id, credential.id); await selectServiceAccount(selectedServiceAccount) } catch (revokeError) { setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.')) }
  }

  const relabelServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount) return
    const label = window.prompt('New credential label', credential.label)?.trim()
    if (!label || label === credential.label) return
    try {
      await apiAccessApi.relabelServiceCredential(workspaceId, selectedServiceAccount.id, credential.id, label, credential.revision)
      await selectServiceAccount(selectedServiceAccount)
    } catch (relabelError) {
      setError(getApiErrorMessage(relabelError, 'Failed to relabel credential.'))
    }
  }

  const rotateServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount || !window.confirm(`Rotate ${credential.label}? The current secret stops working immediately.`)) return
    try {
      showSecret(await apiAccessApi.rotateServiceCredential(workspaceId, selectedServiceAccount.id, credential.id, credential.revision))
      await selectServiceAccount(selectedServiceAccount)
    } catch (rotateError) {
      setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.'))
    }
  }

  const changeServiceRole = async (role: 'member' | 'admin') => {
    if (!workspaceId || !selectedServiceAccount || role === selectedServiceAccount.role) return
    if (!window.confirm(`Change ${selectedServiceAccount.displayName} from ${selectedServiceAccount.role} to ${role}? This changes its live API authority immediately.`)) return
    try {
      const updated = await apiAccessApi.updateServiceAccount(workspaceId, selectedServiceAccount.id, {
        role,
        revision: selectedServiceAccount.revision,
      })
      setSelectedServiceAccount(updated)
      await load()
    } catch (roleError) {
      setError(getApiErrorMessage(roleError, 'Failed to change service-account role.'))
    }
  }

  const transitionServiceAccount = async (action: 'disable' | 'enable' | 'archive') => {
    if (!workspaceId || !selectedServiceAccount) return
    const consequence = action === 'archive'
      ? 'This permanently archives the identity and revokes every active credential.'
      : action === 'disable'
        ? 'Its credentials will stop working until it is enabled again.'
        : 'Its unexpired, unrevoked credentials will work again.'
    if (!window.confirm(`${action[0]?.toUpperCase()}${action.slice(1)} ${selectedServiceAccount.displayName}? ${consequence}`)) return
    try {
      const updated = await apiAccessApi.transitionServiceAccount(
        workspaceId,
        selectedServiceAccount.id,
        action,
        selectedServiceAccount.revision,
      )
      setSelectedServiceAccount(updated)
      await load()
      await selectServiceAccount(updated)
    } catch (transitionError) {
      setError(getApiErrorMessage(transitionError, `Failed to ${action} service account.`))
    }
  }

  const expiryDays = summary?.defaults.personalTokenLifetimeDays ?? 90
  const personalDescription = useMemo(() => canAudit ? 'Personal credentials across this workspace. Secrets are never recoverable.' : 'Credentials belonging to you. Secrets are never recoverable.', [canAudit])

  if (!workspaceId) return null

  return (
    <div id="api-access" className="space-y-6 scroll-mt-24">
      <SettingsCard icon={<KeyRound className="h-5 w-5 text-primary" />} title="API access" description="Issue and manage short-lived personal and service-account credentials for external clients.">
        <div className="space-y-5">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-foreground">
            <p className="font-medium">Breaking change: the legacy shared workspace token is gone.</p>
            <p className="mt-1 text-muted-foreground">Use a personal token for your own scripts or a service-account credential for automation. Every secret is shown once and cannot be recovered.</p>
          </div>
          {summary?.legacyCredentialMigration.status === 'destroyed' ? <p className="text-sm text-muted-foreground">The legacy credential was destroyed during migration.</p> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {isLoading ? <p className="text-sm text-muted-foreground">Loading API access…</p> : null}
          {canViewPersonal ? (
            <div className="space-y-3 rounded-xl bg-muted/40 p-4">
              <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /><h4 className="font-medium">Personal tokens</h4></div>
              <p className="text-sm text-muted-foreground">{personalDescription}</p>
              {!personalFormOpen ? <Button variant="outline" onClick={() => setPersonalFormOpen(true)}><Plus className="mr-2 h-4 w-4" />Create personal token</Button> : null}
              {personalFormOpen ? <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
                <div className="space-y-1"><Label htmlFor="personal-token-label">Token label</Label><Input id="personal-token-label" value={personalLabel} onChange={(event) => setPersonalLabel(event.target.value)} placeholder="Local development" /></div>
                <div className="space-y-1"><Label htmlFor="personal-token-role">Role ceiling</Label><select id="personal-token-role" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={selectedPersonalRole} onChange={(event) => setPersonalRole(event.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin" disabled={summary?.effectiveRole === 'member'}>Admin</option></select></div>
                <div className="space-y-1"><Label htmlFor="personal-token-expiry">Expires</Label><Input id="personal-token-expiry" type="date" max={defaultExpiry(expiryDays)} value={personalExpiry} onChange={(event) => setPersonalExpiry(event.target.value)} /></div>
              </div> : null}
              {personalFormOpen ? <Button onClick={createPersonal} disabled={isCreating || !personalLabel.trim()}><Plus className="mr-2 h-4 w-4" />Issue personal token</Button> : null}
              <CredentialList
                items={personalTokens}
                onRevoke={revokePersonal}
                onRelabel={relabelPersonal}
                onRotate={rotatePersonal}
                canRevoke={(credential) => canAudit || isOwnPersonalToken(credential)}
                canRelabel={isOwnPersonalToken}
                canRotate={isOwnPersonalToken}
              />
              <PaginationControls page={personalPage} total={personalTotal} onPage={setPersonalPage} />
            </div>
          ) : null}
        </div>
      </SettingsCard>

      {canManageServices ? (
        <SettingsCard icon={<Server className="h-5 w-5 text-primary" />} title="Service accounts" description="Use named, independently revocable identities for production integrations and automation.">
          <div className="space-y-4">
            {!serviceFormOpen ? <Button variant="outline" onClick={() => setServiceFormOpen(true)}><Plus className="mr-2 h-4 w-4" />New service account</Button> : null}
            {serviceFormOpen ? <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="service-account-name">Service account name</Label><Input id="service-account-name" value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="Nightly ingestion" /></div>
              <div className="space-y-1"><Label htmlFor="service-account-role">Role</Label><select id="service-account-role" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={serviceRole} onChange={(event) => setServiceRole(event.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin" disabled={summary?.effectiveRole === 'member'}>Admin</option></select></div>
            </div> : null}
            {serviceFormOpen ? <><div className="grid gap-3 md:grid-cols-2"><div className="space-y-1"><Label htmlFor="service-credential-label">Initial credential label</Label><Input id="service-credential-label" value={serviceCredentialLabel} onChange={(event) => setServiceCredentialLabel(event.target.value)} /></div><div className="space-y-1"><Label htmlFor="service-credential-expiry">Expires</Label><Input id="service-credential-expiry" type="date" value={serviceExpiry} onChange={(event) => setServiceExpiry(event.target.value)} /></div></div><Button onClick={createService} disabled={isCreating || !serviceName.trim() || !serviceCredentialLabel.trim()}><Plus className="mr-2 h-4 w-4" />Create service account</Button></> : null}
            <div className="divide-y divide-border rounded-lg border border-border">
              {serviceAccounts.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No service accounts yet.</p> : serviceAccounts.map((account) => <div key={account.id} className="flex items-center justify-between gap-3 p-3"><div><p className="font-medium">{account.displayName}</p><p className="text-xs text-muted-foreground">{account.role} · {account.activeCredentialCount} active credential{account.activeCredentialCount === 1 ? '' : 's'} · last used {formatDate(account.lastUsedAt)}</p></div><div className="flex items-center gap-2"><Badge variant={account.status === 'enabled' ? 'outline' : 'secondary'}>{account.status}</Badge><Button size="sm" variant="ghost" onClick={() => void selectServiceAccount(account)}>Manage credentials</Button></div></div>)}
            </div>
            <PaginationControls page={servicePage} total={serviceTotal} onPage={setServicePage} />
            {selectedServiceAccount ? <div className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-center justify-between"><h4 className="font-medium">{selectedServiceAccount.displayName} credentials</h4><Badge variant="outline">{selectedServiceAccount.status}</Badge></div><div className="flex flex-wrap items-end gap-3"><div className="space-y-1"><Label htmlFor="selected-service-role">Live role</Label><select id="selected-service-role" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={selectedServiceAccount.role} disabled={selectedServiceAccount.status === 'archived'} onChange={(event) => void changeServiceRole(event.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin">Admin</option></select></div>{selectedServiceAccount.status === 'enabled' ? <Button variant="outline" onClick={() => void transitionServiceAccount('disable')}>Disable</Button> : null}{selectedServiceAccount.status === 'disabled' ? <Button variant="outline" onClick={() => void transitionServiceAccount('enable')}>Enable</Button> : null}{selectedServiceAccount.status !== 'archived' ? <Button variant="destructive" onClick={() => void transitionServiceAccount('archive')}>Archive</Button> : null}</div><div className="grid gap-3 md:grid-cols-2"><div className="space-y-1"><Label htmlFor="additional-credential-label">Credential label</Label><Input id="additional-credential-label" value={additionalCredentialLabel} onChange={(event) => setAdditionalCredentialLabel(event.target.value)} placeholder="Canary runner" /></div><div className="space-y-1"><Label htmlFor="additional-credential-expiry">Expires</Label><Input id="additional-credential-expiry" type="date" value={additionalCredentialExpiry} onChange={(event) => setAdditionalCredentialExpiry(event.target.value)} /></div></div><Button onClick={issueAdditionalCredential} disabled={!additionalCredentialLabel.trim() || selectedServiceAccount.status !== 'enabled'}><Plus className="mr-2 h-4 w-4" />Issue credential</Button><CredentialList items={serviceCredentials} onRevoke={revokeServiceCredential} onRelabel={relabelServiceCredential} onRotate={rotateServiceCredential} /><PaginationControls page={serviceCredentialPage} total={serviceCredentialTotal} onPage={(page) => void selectServiceAccount(selectedServiceAccount, page)} /></div> : null}
          </div>
        </SettingsCard>
      ) : null}

      {oneTime ? <OneTimeSecret response={oneTime} acknowledged={acknowledged} onAcknowledged={setAcknowledged} onClose={() => { setOneTime(null); setAcknowledged(false) }} /> : null}
    </div>
  )
}

function CredentialList({
  items,
  onRevoke,
  onRelabel,
  onRotate,
  canRevoke = () => true,
  canRelabel = () => true,
  canRotate = () => true,
}: {
  items: ApiCredentialMetadata[]
  onRevoke: (credential: ApiCredentialMetadata) => void
  onRelabel?: (credential: ApiCredentialMetadata) => void
  onRotate?: (credential: ApiCredentialMetadata) => void
  canRevoke?: (credential: ApiCredentialMetadata) => boolean
  canRelabel?: (credential: ApiCredentialMetadata) => boolean
  canRotate?: (credential: ApiCredentialMetadata) => boolean
}) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No credentials yet.</p> : items.map((credential) => {
        const isRevoked = Boolean(credential.revokedAt)
        const mayRevoke = canRevoke(credential)
        const mayRelabel = onRelabel && canRelabel(credential)
        const mayRotate = onRotate && canRotate(credential)

        return (
          <div key={credential.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{credential.label}</p>
              <p className="text-xs text-muted-foreground">{credential.prefix} · expires {formatDate(credential.expiresAt)}{credential.expiryWarningDays ? ` · expires in ${credential.expiryWarningDays} days` : ''} · last used {formatDate(credential.lastUsedAt)}</p>
              <CredentialMetadata credential={credential} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {mayRelabel ? <Button size="sm" variant="ghost" onClick={() => onRelabel(credential)} disabled={isRevoked}>Rename</Button> : null}
              {mayRotate ? <Button size="sm" variant="ghost" onClick={() => onRotate(credential)} disabled={isRevoked}>Rotate</Button> : null}
              {mayRevoke ? <Button size="sm" variant="ghost" onClick={() => onRevoke(credential)} disabled={isRevoked}><Trash2 className="mr-1 h-3.5 w-3.5" />{isRevoked ? 'Revoked' : 'Revoke'}</Button> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CredentialMetadata({ credential }: { credential: ApiCredentialMetadata }) {
  const status = credential.revokedAt ? 'Revoked' : 'Not revoked'

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>Status {status}</span>
      {credential.ownerUserId ? <span>Owner {credential.ownerUserId}</span> : null}
      {credential.roleCeiling ? <span>Role ceiling {credential.roleCeiling}</span> : null}
      {credential.createdByUserId ? <span>Created by {credential.createdByUserId}</span> : null}
      <span>Created {formatDate(credential.createdAt)}</span>
      {credential.revokedAt ? <span>Revoked {formatDate(credential.revokedAt)}</span> : null}
      {credential.revokedByUserId ? <span>Revoked by {credential.revokedByUserId}</span> : null}
      {credential.revocationReason ? <span>Reason {credential.revocationReason}</span> : null}
      {credential.rotatedFromCredentialId ? <span>Rotated from {credential.rotatedFromCredentialId}</span> : null}
    </div>
  )
}

function OneTimeSecret({ response, acknowledged, onAcknowledged, onClose }: { response: OneTimeCredentialResponse; acknowledged: boolean; onAcknowledged: (value: boolean) => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && acknowledged) onClose()
    }}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Save this secret now</DialogTitle>
          <DialogDescription>This credential secret cannot be recovered after you close this message. Store it in your server-side secret manager.</DialogDescription>
        </DialogHeader>
        <CopyValueField value={response.secret} ariaLabel="Copy one-time credential secret" className="w-full" />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledged(event.target.checked)} className="mt-1" />
          I have saved this secret securely and understand it cannot be recovered.
        </label>
        <DialogFooter>
          <Button onClick={onClose} disabled={!acknowledged}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PaginationControls({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pageSize = 50
  if (total <= pageSize) return null
  const pageCount = Math.ceil(total / pageSize)
  return <div className="flex items-center justify-end gap-2 text-sm"><span className="text-muted-foreground">Page {page} of {pageCount}</span><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</Button></div>
}
