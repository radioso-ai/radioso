'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { KeyRound, Plus, Server, Trash2 } from 'lucide-react'

import { apiAccessApi, type ApiAccessSummary, type ApiCredentialMetadata, type OneTimeCredentialResponse, type ServiceAccountSummary } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'
import { cn } from '@/lib/utils'
import {
  CreatePersonalTokenDialog,
  CreateServiceAccountDialog,
  OneTimeSecretDialog,
  RoleSelect,
  expiryHint,
  type PersonalTokenDraft,
  type ServiceAccountDraft,
} from './api-access-dialogs'
import { SettingsCard } from './settings-card'

const formatDate = (value: string | null) => value ? new Date(value).toLocaleDateString() : 'Never'

const expiryInputToIso = (value: string) => {
  if (!value) return undefined
  const expiry = new Date(`${value}T23:59:59Z`)
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : undefined
}

export function ApiAccessPanel({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { user } = useAuth()
  const [summary, setSummary] = useState<ApiAccessSummary | null>(null)
  const [personalTokens, setPersonalTokens] = useState<ApiCredentialMetadata[]>([])
  const [personalPage, setPersonalPage] = useState(1)
  const [personalTotal, setPersonalTotal] = useState(0)
  const [serviceAccounts, setServiceAccounts] = useState<ServiceAccountSummary[]>([])
  const [servicePage, setServicePage] = useState(1)
  const [serviceTotal, setServiceTotal] = useState(0)
  const [personalFormOpen, setPersonalFormOpen] = useState(false)
  const [serviceFormOpen, setServiceFormOpen] = useState(false)
  const [selectedServiceAccount, setSelectedServiceAccount] = useState<ServiceAccountSummary | null>(null)
  const [serviceCredentials, setServiceCredentials] = useState<ApiCredentialMetadata[]>([])
  const [serviceCredentialPage, setServiceCredentialPage] = useState(1)
  const [serviceCredentialTotal, setServiceCredentialTotal] = useState(0)
  const [additionalCredentialLabel, setAdditionalCredentialLabel] = useState('')
  const [additionalCredentialExpiry, setAdditionalCredentialExpiry] = useState('')
  const [oneTime, setOneTime] = useState<OneTimeCredentialResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const canManageServices = summary?.capabilities.manageServiceAccounts === true
  const canManagePersonal = summary?.capabilities.manageOwnPersonalTokens !== false
  const canAudit = summary?.capabilities.auditWorkspacePersonalTokens === true
  const canViewPersonal = canManagePersonal || canAudit
  const canIssueAdminRole = summary?.effectiveRole !== 'member'
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

  const createPersonal = async (draft: PersonalTokenDraft) => {
    if (!workspaceId || !draft.label.trim()) return
    const expiresAt = expiryInputToIso(draft.expiry)
    setIsCreating(true)
    setFormError(null)
    try {
      const response = await apiAccessApi.createPersonalToken(workspaceId, {
        label: draft.label.trim(),
        roleCeiling: canIssueAdminRole ? draft.role : 'member',
        ...(expiresAt ? { expiresAt } : {}),
      })
      showSecret(response)
      setPersonalFormOpen(false)
      await load()
    } catch (createError) {
      setFormError(getApiErrorMessage(createError, 'Failed to issue personal token.'))
    } finally {
      setIsCreating(false)
    }
  }

  const createService = async (draft: ServiceAccountDraft) => {
    if (!workspaceId || !draft.displayName.trim() || !draft.credentialLabel.trim()) return
    const expiresAt = expiryInputToIso(draft.expiry)
    setIsCreating(true)
    setFormError(null)
    try {
      const response = await apiAccessApi.createServiceAccount(workspaceId, {
        displayName: draft.displayName.trim(), role: canIssueAdminRole ? draft.role : 'member',
        initialCredential: {
          label: draft.credentialLabel.trim(),
          ...(expiresAt ? { expiresAt } : {}),
        },
      })
      showSecret({ credential: response.credential, secret: response.secret })
      setServiceFormOpen(false)
      await load()
    } catch (createError) {
      setFormError(getApiErrorMessage(createError, 'Failed to create service account.'))
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
    const expiresAt = expiryInputToIso(additionalCredentialExpiry)
    try {
      showSecret(await apiAccessApi.issueServiceCredential(workspaceId, selectedServiceAccount.id, {
        label: additionalCredentialLabel.trim(),
        ...(expiresAt ? { expiresAt } : {}),
      }))
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

  const renameServiceAccount = async () => {
    if (!workspaceId || !selectedServiceAccount || selectedServiceAccount.status === 'archived') return
    const displayName = window.prompt('New service-account name', selectedServiceAccount.displayName)?.trim()
    if (!displayName || displayName === selectedServiceAccount.displayName) return
    try {
      const updated = await apiAccessApi.updateServiceAccount(workspaceId, selectedServiceAccount.id, {
        displayName,
        revision: selectedServiceAccount.revision,
      })
      setSelectedServiceAccount(updated)
      await load()
    } catch (renameError) {
      setError(getApiErrorMessage(renameError, 'Failed to rename service account.'))
    }
  }

  const transitionServiceAccount = async (action: 'disable' | 'enable' | 'archive') => {
    if (!workspaceId || !selectedServiceAccount) return
    const consequence = action === 'archive'
      ? 'This permanently archives the identity and revokes every active credential.'
      : action === 'disable'
        ? 'Its credentials will stop working until it is enabled again.'
        : 'Its unrevoked credentials will work again.'
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

  const personalDescription = useMemo(() => canAudit ? 'Personal credentials across this workspace. Secrets are never recoverable.' : 'Credentials that act as you, for your own scripts and local development. Secrets are never recoverable.', [canAudit])

  const openPersonalForm = () => {
    setFormError(null)
    setPersonalFormOpen(true)
  }

  const openServiceForm = () => {
    setFormError(null)
    setServiceFormOpen(true)
  }

  if (!workspaceId) return null

  return (
    <div id="api-access" className="space-y-6 scroll-mt-24">
      <SettingsCard
        icon={<KeyRound className="h-5 w-5 text-primary" />}
        title="API access"
        description={personalDescription}
        headerEnd={canManagePersonal ? (
          <Button type="button" size="sm" onClick={openPersonalForm}>
            <Plus className="mr-2 h-4 w-4" />
            Create personal token
          </Button>
        ) : null}
      >
        <div className="space-y-4">
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading API access…
            </div>
          ) : null}
          {canViewPersonal ? (
            <>
              <CredentialList
                items={personalTokens}
                emptyMessage="No personal tokens yet."
                onRevoke={revokePersonal}
                onRelabel={relabelPersonal}
                onRotate={rotatePersonal}
                canRevoke={(credential) => canAudit || isOwnPersonalToken(credential)}
                canRelabel={isOwnPersonalToken}
                canRotate={isOwnPersonalToken}
              />
              <PaginationControls page={personalPage} total={personalTotal} onPage={setPersonalPage} />
            </>
          ) : null}
        </div>
      </SettingsCard>

      {canManageServices ? (
        <SettingsCard
          icon={<Server className="h-5 w-5 text-primary" />}
          title="Service accounts"
          description="Named, independently revocable identities for production integrations and automation."
          headerEnd={(
            <Button type="button" size="sm" onClick={openServiceForm}>
              <Plus className="mr-2 h-4 w-4" />
              New service account
            </Button>
          )}
        >
          <div className="space-y-4">
            {serviceAccounts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <p className="text-sm font-medium text-foreground">No service accounts yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Give each integration its own identity so you can rotate or revoke it without touching the others.</p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {serviceAccounts.map((account) => (
                  <ServiceAccountRow
                    key={account.id}
                    account={account}
                    isSelected={selectedServiceAccount?.id === account.id}
                    onManage={() => void selectServiceAccount(account)}
                  />
                ))}
              </div>
            )}
            <PaginationControls page={servicePage} total={serviceTotal} onPage={setServicePage} />
            {selectedServiceAccount ? (
              <ServiceAccountDetail
                account={selectedServiceAccount}
                credentials={serviceCredentials}
                credentialPage={serviceCredentialPage}
                credentialTotal={serviceCredentialTotal}
                credentialLabel={additionalCredentialLabel}
                credentialExpiry={additionalCredentialExpiry}
                onCredentialLabelChange={setAdditionalCredentialLabel}
                onCredentialExpiryChange={setAdditionalCredentialExpiry}
                onIssueCredential={() => void issueAdditionalCredential()}
                onChangeRole={(role) => void changeServiceRole(role)}
                onRename={() => void renameServiceAccount()}
                onTransition={(action) => void transitionServiceAccount(action)}
                onRevokeCredential={revokeServiceCredential}
                onRelabelCredential={relabelServiceCredential}
                onRotateCredential={rotateServiceCredential}
                onCredentialPage={(page) => void selectServiceAccount(selectedServiceAccount, page)}
              />
            ) : null}
          </div>
        </SettingsCard>
      ) : null}

      {personalFormOpen ? (
        <CreatePersonalTokenDialog
          adminSelectable={canIssueAdminRole}
          error={formError}
          isSubmitting={isCreating}
          onSubmit={(draft) => void createPersonal(draft)}
          onOpenChange={setPersonalFormOpen}
        />
      ) : null}

      {serviceFormOpen ? (
        <CreateServiceAccountDialog
          adminSelectable={canIssueAdminRole}
          error={formError}
          isSubmitting={isCreating}
          onSubmit={(draft) => void createService(draft)}
          onOpenChange={setServiceFormOpen}
        />
      ) : null}

      {oneTime ? <OneTimeSecretDialog response={oneTime} acknowledged={acknowledged} onAcknowledged={setAcknowledged} onClose={() => { setOneTime(null); setAcknowledged(false) }} /> : null}
    </div>
  )
}

function ServiceAccountRow({
  account,
  isSelected,
  onManage,
}: {
  account: ServiceAccountSummary
  isSelected: boolean
  onManage: () => void
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 p-3 transition-colors', isSelected && 'bg-muted/50')}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{account.displayName}</p>
          <Badge variant={account.status === 'enabled' ? 'outline' : 'secondary'}>{account.status}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{account.role} · {account.activeCredentialCount} active credential{account.activeCredentialCount === 1 ? '' : 's'} · last used {formatDate(account.lastUsedAt)}</p>
      </div>
      <div role="group" aria-label={`Actions for service account ${account.displayName}`} className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" aria-label={`Manage credentials for ${account.displayName}`} onClick={onManage}>
          Manage credentials
        </Button>
      </div>
    </div>
  )
}

function ServiceAccountDetail({
  account,
  credentials,
  credentialPage,
  credentialTotal,
  credentialLabel,
  credentialExpiry,
  onCredentialLabelChange,
  onCredentialExpiryChange,
  onIssueCredential,
  onChangeRole,
  onRename,
  onTransition,
  onRevokeCredential,
  onRelabelCredential,
  onRotateCredential,
  onCredentialPage,
}: {
  account: ServiceAccountSummary
  credentials: ApiCredentialMetadata[]
  credentialPage: number
  credentialTotal: number
  credentialLabel: string
  credentialExpiry: string
  onCredentialLabelChange: (value: string) => void
  onCredentialExpiryChange: (value: string) => void
  onIssueCredential: () => void
  onChangeRole: (role: 'member' | 'admin') => void
  onRename: () => void
  onTransition: (action: 'disable' | 'enable' | 'archive') => void
  onRevokeCredential: (credential: ApiCredentialMetadata) => void
  onRelabelCredential: (credential: ApiCredentialMetadata) => void
  onRotateCredential: (credential: ApiCredentialMetadata) => void
  onCredentialPage: (page: number) => void
}) {
  const isArchived = account.status === 'archived'

  return (
    <section className="space-y-4 rounded-xl border border-border bg-muted/25 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h4 className="font-medium">{account.displayName} credentials</h4>
          <ServiceAccountMetadata account={account} />
        </div>
        <Badge variant="outline">{account.status}</Badge>
      </header>

      <div role="group" aria-label={`Actions for service account ${account.displayName}`} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
        <div className="space-y-1.5">
          <Label htmlFor="selected-service-role">Live role</Label>
          <RoleSelect
            id="selected-service-role"
            value={account.role}
            disabled={isArchived}
            onChange={onChangeRole}
            className="w-36"
          />
        </div>
        {!isArchived ? (
          <Button size="sm" variant="outline" aria-label={`Rename service account ${account.displayName}`} onClick={onRename}>Rename</Button>
        ) : null}
        {account.status === 'enabled' ? <Button size="sm" variant="outline" onClick={() => onTransition('disable')}>Disable</Button> : null}
        {account.status === 'disabled' ? <Button size="sm" variant="outline" onClick={() => onTransition('enable')}>Enable</Button> : null}
        {!isArchived ? (
          <Button size="sm" variant="destructive" className="ml-auto" onClick={() => onTransition('archive')}>Archive</Button>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Issue another credential</p>
          <p className="text-xs text-muted-foreground">{expiryHint}</p>
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="additional-credential-label">Credential label</Label>
            <Input id="additional-credential-label" value={credentialLabel} onChange={(event) => onCredentialLabelChange(event.target.value)} placeholder="Canary runner" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="additional-credential-expiry">Expires</Label>
            <Input id="additional-credential-expiry" type="date" value={credentialExpiry} onChange={(event) => onCredentialExpiryChange(event.target.value)} />
          </div>
          <Button onClick={onIssueCredential} disabled={!credentialLabel.trim() || account.status !== 'enabled'}>
            <Plus className="mr-2 h-4 w-4" />
            Issue credential
          </Button>
        </div>
      </div>

      <CredentialList
        items={credentials}
        emptyMessage="No credentials yet."
        onRevoke={onRevokeCredential}
        onRelabel={onRelabelCredential}
        onRotate={onRotateCredential}
      />
      <PaginationControls page={credentialPage} total={credentialTotal} onPage={onCredentialPage} />
    </section>
  )
}

function CredentialList({
  items,
  emptyMessage,
  onRevoke,
  onRelabel,
  onRotate,
  canRevoke = () => true,
  canRelabel = () => true,
  canRotate = () => true,
}: {
  items: ApiCredentialMetadata[]
  emptyMessage: string
  onRevoke: (credential: ApiCredentialMetadata) => void
  onRelabel?: (credential: ApiCredentialMetadata) => void
  onRotate?: (credential: ApiCredentialMetadata) => void
  canRevoke?: (credential: ApiCredentialMetadata) => boolean
  canRelabel?: (credential: ApiCredentialMetadata) => boolean
  canRotate?: (credential: ApiCredentialMetadata) => boolean
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>
    )
  }

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
      {items.map((credential) => {
        const isRevoked = credential.status === 'revoked' || Boolean(credential.revokedAt)
        const mayRevoke = canRevoke(credential)
        const mayRelabel = onRelabel && canRelabel(credential)
        const mayRotate = onRotate && canRotate(credential)

        return (
          <div key={credential.id} className={cn('flex flex-wrap items-center justify-between gap-3 p-3', isRevoked && 'opacity-70')}>
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium text-foreground">{credential.label}</p>
              <p className="text-xs text-muted-foreground">{credential.prefix}{credential.roleCeiling ? ` · role ${credential.roleCeiling}` : ''} · expires {formatDate(credential.expiresAt)}{credential.expiryWarningDays ? ` · expires in ${credential.expiryWarningDays} days` : ''} · last used {formatDate(credential.lastUsedAt)}</p>
              <CredentialMetadata credential={credential} />
            </div>
            <div role="group" aria-label={`Actions for credential ${credential.label}`} className="flex shrink-0 items-center gap-1">
              {mayRelabel ? <Button size="sm" variant="ghost" aria-label={`Rename ${credential.label}`} onClick={() => onRelabel(credential)} disabled={isRevoked}>Rename</Button> : null}
              {mayRotate ? <Button size="sm" variant="ghost" aria-label={`Rotate ${credential.label}`} onClick={() => onRotate(credential)} disabled={isRevoked}>Rotate</Button> : null}
              {mayRevoke ? <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`${isRevoked ? 'Revoked' : 'Revoke'} ${credential.label}`} onClick={() => onRevoke(credential)} disabled={isRevoked}><Trash2 className="mr-1 h-3.5 w-3.5" />{isRevoked ? 'Revoked' : 'Revoke'}</Button> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MetadataRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [&>span:not(:last-child)]:after:ml-2 [&>span:not(:last-child)]:after:text-muted-foreground/50 [&>span:not(:last-child)]:after:content-['·']">{children}</div>
  )
}

function CredentialMetadata({ credential }: { credential: ApiCredentialMetadata }) {
  const status = credential.status[0].toUpperCase() + credential.status.slice(1)
  const hasMetadata = credential.status !== 'active' || credential.revokedAt || credential.revocationReason || credential.rotatedFromCredentialId

  if (!hasMetadata) return null

  return (
    <MetadataRow>
      {credential.status !== 'active' ? <span>Status {status}</span> : null}
      {credential.revokedAt ? <span>Revoked {formatDate(credential.revokedAt)}</span> : null}
      {credential.revocationReason ? <span>Reason {credential.revocationReason}</span> : null}
      {credential.rotatedFromCredentialId ? <span>Rotated from {credential.rotatedFromCredentialId}</span> : null}
    </MetadataRow>
  )
}

function ServiceAccountMetadata({ account }: { account: ServiceAccountSummary }) {
  return (
    <MetadataRow>
      <span>Created by {account.createdByUserId ?? 'Unknown'}</span>
      <span>Created {formatDate(account.createdAt)}</span>
      <span>Updated {formatDate(account.updatedAt)}</span>
      <span>Disabled {formatDate(account.disabledAt)}</span>
      <span>Archived {formatDate(account.archivedAt)}</span>
    </MetadataRow>
  )
}

function PaginationControls({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pageSize = 50
  if (total <= pageSize) return null
  const pageCount = Math.ceil(total / pageSize)
  return <div className="flex items-center justify-end gap-2 text-sm"><span className="text-muted-foreground">Page {page} of {pageCount}</span><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</Button></div>
}
