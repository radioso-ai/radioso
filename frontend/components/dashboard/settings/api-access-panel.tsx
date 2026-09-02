'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  defaultExpiryDate,
  expiryHint,
  type PersonalTokenDraft,
  type ServiceAccountDraft,
} from './api-access-dialogs'
import { SettingsCard } from './settings-card'

const formatDate = (value: string | null) => value ? new Date(value).toLocaleDateString() : 'Never'

const expiryInputToIso = (value: string) => {
  if (!value) return undefined
  const expiry = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : undefined
}

export function ApiAccessPanel({
  workspaceId,
  view = 'personal',
}: {
  workspaceId: string | null | undefined
  view?: 'personal' | 'service'
}) {
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
  const [additionalCredentialExpiry, setAdditionalCredentialExpiry] = useState(() => defaultExpiryDate(365))
  const [oneTime, setOneTime] = useState<OneTimeCredentialResponse | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const scopeGeneration = useRef(0)
  const loadGeneration = useRef(0)
  const serviceDetailGeneration = useRef(0)

  const canManageServices = summary?.capabilities.manageServiceAccounts === true
  const canManagePersonal = summary?.capabilities.manageOwnPersonalTokens !== false
  const canAudit = summary?.capabilities.auditWorkspacePersonalTokens === true
  const canViewPersonal = canManagePersonal || canAudit
  const canIssueAdminRole = summary?.effectiveRole !== 'member'
  const isOwnPersonalToken = (credential: ApiCredentialMetadata) => credential.ownerUserId === user?.userId

  const load = useCallback(async (expectedScopeGeneration = scopeGeneration.current) => {
    if (!workspaceId) return
    const requestGeneration = loadGeneration.current + 1
    loadGeneration.current = requestGeneration
    const isCurrent = () => scopeGeneration.current === expectedScopeGeneration && loadGeneration.current === requestGeneration
    setIsLoading(true)
    setError(null)
    try {
      const nextSummary = await apiAccessApi.getSummary(workspaceId)
      if (!isCurrent()) return
      setSummary(nextSummary)
      if (view === 'personal') {
        const personal = await apiAccessApi.listPersonalTokens(workspaceId, {
          view: nextSummary.capabilities.auditWorkspacePersonalTokens ? 'workspace' : 'mine',
          page: personalPage,
        })
        if (!isCurrent()) return
        setPersonalTokens(personal.items)
        setPersonalTotal(personal.total)
      }
      if (view === 'service' && nextSummary.capabilities.manageServiceAccounts) {
        const services = await apiAccessApi.listServiceAccounts(workspaceId, { page: servicePage })
        if (!isCurrent()) return
        setServiceAccounts(services.items)
        setServiceTotal(services.total)
      } else {
        if (!isCurrent()) return
        setServiceAccounts([])
        setServiceTotal(0)
      }
    } catch (loadError) {
      if (isCurrent()) setError(getApiErrorMessage(loadError, 'Failed to load API access.'))
    } finally {
      if (isCurrent()) setIsLoading(false)
    }
  }, [personalPage, servicePage, view, workspaceId])

  useEffect(() => {
    const generation = scopeGeneration.current + 1
    scopeGeneration.current = generation
    serviceDetailGeneration.current += 1
    // eslint-disable-next-line react-hooks/set-state-in-effect -- workspace changes clear workspace-bound state and one-time secrets.
    setSummary(null)
    setPersonalTokens([])
    setPersonalPage(1)
    setPersonalTotal(0)
    setServiceAccounts([])
    setServicePage(1)
    setServiceTotal(0)
    setPersonalFormOpen(false)
    setServiceFormOpen(false)
    setSelectedServiceAccount(null)
    setServiceCredentials([])
    setServiceCredentialPage(1)
    setServiceCredentialTotal(0)
    setAdditionalCredentialLabel('')
    setAdditionalCredentialExpiry(defaultExpiryDate(365))
    setOneTime(null)
    setAcknowledged(false)
    setIsLoading(Boolean(workspaceId))
    setIsCreating(false)
    setError(null)
    setFormError(null)
    return () => {
      if (scopeGeneration.current === generation) scopeGeneration.current += 1
    }
  }, [view, workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial and pagination loads synchronize API data.
    void load()
  }, [load])

  const showSecret = (response: OneTimeCredentialResponse) => {
    setOneTime(response)
    setAcknowledged(false)
  }

  const createPersonal = async (draft: PersonalTokenDraft) => {
    if (!workspaceId || !draft.label.trim()) return
    const expiresAt = expiryInputToIso(draft.expiry)
    if (!expiresAt) return
    const generation = scopeGeneration.current
    setIsCreating(true)
    setFormError(null)
    try {
      const response = await apiAccessApi.createPersonalToken(workspaceId, {
        label: draft.label.trim(),
        roleCeiling: canIssueAdminRole ? draft.role : 'member',
        expiresAt,
      })
      if (scopeGeneration.current !== generation) return
      showSecret(response)
      setPersonalFormOpen(false)
      await load(generation)
    } catch (createError) {
      if (scopeGeneration.current === generation) setFormError(getApiErrorMessage(createError, 'Failed to issue personal token.'))
    } finally {
      if (scopeGeneration.current === generation) setIsCreating(false)
    }
  }

  const createService = async (draft: ServiceAccountDraft) => {
    if (!workspaceId || !draft.displayName.trim()) return
    const expiresAt = expiryInputToIso(draft.expiry)
    if (!expiresAt) return
    const generation = scopeGeneration.current
    setIsCreating(true)
    setFormError(null)
    try {
      const response = await apiAccessApi.createServiceAccount(workspaceId, {
        displayName: draft.displayName.trim(), role: canIssueAdminRole ? draft.role : 'member',
        credentialExpiresAt: expiresAt,
      })
      if (scopeGeneration.current !== generation) return
      showSecret({ credential: response.credential, secret: response.secret })
      setServiceFormOpen(false)
      await load(generation)
    } catch (createError) {
      if (scopeGeneration.current === generation) setFormError(getApiErrorMessage(createError, 'Failed to create service account.'))
    } finally {
      if (scopeGeneration.current === generation) setIsCreating(false)
    }
  }

  const revokePersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !window.confirm(`Revoke ${credential.label}?`)) return
    const generation = scopeGeneration.current
    try {
      await apiAccessApi.revokePersonalToken(workspaceId, credential.id)
      if (scopeGeneration.current !== generation) return
      await load(generation)
    } catch (revokeError) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.'))
    }
  }

  const relabelPersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId) return
    const label = window.prompt('New token label', credential.label)?.trim()
    if (!label || label === credential.label) return
    const generation = scopeGeneration.current
    try {
      await apiAccessApi.relabelPersonalToken(workspaceId, credential.id, label, credential.revision)
      if (scopeGeneration.current !== generation) return
      await load(generation)
    } catch (relabelError) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(relabelError, 'Failed to relabel credential.'))
    }
  }

  const rotatePersonal = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !window.confirm(`Rotate ${credential.label}? The current secret stops working immediately.`)) return
    const generation = scopeGeneration.current
    try {
      const response = await apiAccessApi.rotatePersonalToken(workspaceId, credential.id, credential.revision)
      if (scopeGeneration.current !== generation) return
      showSecret(response)
      await load(generation)
    } catch (rotateError) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.'))
    }
  }

  const selectServiceAccount = async (account: ServiceAccountSummary, page = serviceCredentialPage) => {
    if (!workspaceId) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current + 1
    serviceDetailGeneration.current = detailGeneration
    const isCurrent = () => scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration
    try {
      const [current, credentials] = await Promise.all([
        apiAccessApi.getServiceAccount(workspaceId, account.id),
        apiAccessApi.listServiceCredentials(workspaceId, account.id, { page }),
      ])
      if (!isCurrent()) return
      setSelectedServiceAccount(current)
      setServiceCredentials(credentials.items)
      setServiceCredentialPage(page)
      setServiceCredentialTotal(credentials.total)
    } catch (credentialsError) {
      if (isCurrent()) setError(getApiErrorMessage(credentialsError, 'Failed to load service credentials.'))
    }
  }

  const issueAdditionalCredential = async () => {
    if (!workspaceId || !selectedServiceAccount || !additionalCredentialLabel.trim()) return
    const expiresAt = expiryInputToIso(additionalCredentialExpiry)
    if (!expiresAt) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccountId = selectedServiceAccount.id
    try {
      const response = await apiAccessApi.issueServiceCredential(workspaceId, serviceAccountId, {
        label: additionalCredentialLabel.trim(),
        expiresAt,
      })
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      showSecret(response)
      setAdditionalCredentialLabel('')
      await selectServiceAccount(selectedServiceAccount)
    } catch (issueError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) {
        setError(getApiErrorMessage(issueError, 'Failed to issue credential.'))
      }
    }
  }

  const revokeServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount || !window.confirm(`Revoke ${credential.label}?`)) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      await apiAccessApi.revokeServiceCredential(workspaceId, serviceAccount.id, credential.id)
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      await selectServiceAccount(serviceAccount)
    } catch (revokeError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.'))
    }
  }

  const relabelServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount) return
    const label = window.prompt('New credential label', credential.label)?.trim()
    if (!label || label === credential.label) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      await apiAccessApi.relabelServiceCredential(workspaceId, serviceAccount.id, credential.id, label, credential.revision)
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      await selectServiceAccount(serviceAccount)
    } catch (relabelError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(relabelError, 'Failed to relabel credential.'))
    }
  }

  const rotateServiceCredential = async (credential: ApiCredentialMetadata) => {
    if (!workspaceId || !selectedServiceAccount || !window.confirm(`Rotate ${credential.label}? The current secret stops working immediately.`)) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      const response = await apiAccessApi.rotateServiceCredential(workspaceId, serviceAccount.id, credential.id, credential.revision)
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      showSecret(response)
      await selectServiceAccount(serviceAccount)
    } catch (rotateError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.'))
    }
  }

  const changeServiceRole = async (role: 'member' | 'admin') => {
    if (!workspaceId || !selectedServiceAccount || role === selectedServiceAccount.role) return
    if (!window.confirm(`Change ${selectedServiceAccount.displayName} from ${selectedServiceAccount.role} to ${role}? This changes its live API authority immediately.`)) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      const updated = await apiAccessApi.updateServiceAccount(workspaceId, serviceAccount.id, {
        role,
        revision: selectedServiceAccount.revision,
      })
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      setSelectedServiceAccount(updated)
      await load(generation)
    } catch (roleError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(roleError, 'Failed to change service-account role.'))
    }
  }

  const renameServiceAccount = async () => {
    if (!workspaceId || !selectedServiceAccount || selectedServiceAccount.status === 'archived') return
    const displayName = window.prompt('New service-account name', selectedServiceAccount.displayName)?.trim()
    if (!displayName || displayName === selectedServiceAccount.displayName) return
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      const updated = await apiAccessApi.updateServiceAccount(workspaceId, serviceAccount.id, {
        displayName,
        revision: selectedServiceAccount.revision,
      })
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      setSelectedServiceAccount(updated)
      await load(generation)
    } catch (renameError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(renameError, 'Failed to rename service account.'))
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
    const generation = scopeGeneration.current
    const detailGeneration = serviceDetailGeneration.current
    const serviceAccount = selectedServiceAccount
    try {
      const updated = await apiAccessApi.transitionServiceAccount(
        workspaceId,
        serviceAccount.id,
        action,
        serviceAccount.revision,
      )
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      setSelectedServiceAccount(updated)
      await load(generation)
      if (scopeGeneration.current !== generation || serviceDetailGeneration.current !== detailGeneration) return
      await selectServiceAccount(updated)
    } catch (transitionError) {
      if (scopeGeneration.current === generation && serviceDetailGeneration.current === detailGeneration) setError(getApiErrorMessage(transitionError, `Failed to ${action} service account.`))
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
    <div id={view === 'service' ? 'service-accounts' : 'api-access'} className="space-y-6 scroll-mt-24">
      {view === 'personal' ? <SettingsCard
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
                currentUserId={user?.userId}
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
      </SettingsCard> : null}

      {view === 'service' && canManageServices ? (
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
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />
                Loading service accounts…
              </div>
            ) : null}
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
                  >
                    {selectedServiceAccount?.id === account.id ? (
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
                        currentUserId={user?.userId}
                      />
                    ) : null}
                  </ServiceAccountRow>
                ))}
              </div>
            )}
            <PaginationControls page={servicePage} total={serviceTotal} onPage={setServicePage} />
          </div>
        </SettingsCard>
      ) : null}

      {view === 'service' && !isLoading && !canManageServices ? (
        <SettingsCard
          icon={<Server className="h-5 w-5 text-primary" />}
          title="Service accounts"
          description="Named identities for production integrations and automation."
        >
          <p className="text-sm text-muted-foreground">Only workspace owners and admins can manage service accounts.</p>
        </SettingsCard>
      ) : null}

      {view === 'personal' && personalFormOpen ? (
        <CreatePersonalTokenDialog
          adminSelectable={canIssueAdminRole}
          error={formError}
          isSubmitting={isCreating}
          onSubmit={(draft) => void createPersonal(draft)}
          onOpenChange={setPersonalFormOpen}
        />
      ) : null}

      {view === 'service' && serviceFormOpen ? (
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
  children,
}: {
  account: ServiceAccountSummary
  isSelected: boolean
  onManage: () => void
  children?: ReactNode
}) {
  return (
    <div className={cn('p-3 transition-colors', isSelected && 'bg-muted/50')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{account.displayName}</h4>
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
      {children ? <div className="mt-4 border-t border-border pt-4">{children}</div> : null}
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
  currentUserId,
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
  currentUserId?: string
}) {
  const isArchived = account.status === 'archived'

  return (
    <section className="space-y-4">
      <ServiceAccountMetadata account={account} currentUserId={currentUserId} />

      <div role="group" aria-label={`Actions for service account ${account.displayName}`} className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="selected-service-role">Service account role</Label>
          <RoleSelect
            id="selected-service-role"
            value={account.role}
            disabled={isArchived}
            onChange={onChangeRole}
            className="w-36"
          />
          <p className="max-w-xs text-xs text-muted-foreground">This role applies immediately to every active credential for this service account.</p>
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
          <Button onClick={onIssueCredential} disabled={!credentialLabel.trim() || !credentialExpiry || account.status !== 'enabled'}>
            <Plus className="mr-2 h-4 w-4" />
            Issue credential
          </Button>
        </div>
      </div>

      <CredentialList
        items={credentials}
        emptyMessage="No credentials yet."
        currentUserId={currentUserId}
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
  currentUserId,
  onRevoke,
  onRelabel,
  onRotate,
  canRevoke = () => true,
  canRelabel = () => true,
  canRotate = () => true,
}: {
  items: ApiCredentialMetadata[]
  emptyMessage: string
  currentUserId?: string
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
              <CredentialMetadata credential={credential} currentUserId={currentUserId} />
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

const operatorLabel = (userId: string, currentUserId: string | undefined) => userId === currentUserId ? 'You' : 'a workspace member'

function CredentialMetadata({ credential, currentUserId }: { credential: ApiCredentialMetadata; currentUserId?: string }) {
  const status = credential.status[0].toUpperCase() + credential.status.slice(1)

  return (
    <MetadataRow>
      <span>Kind {credential.kind}</span>
      <span>Status {status}</span>
      {credential.ownerUserId ? <span>Owner {operatorLabel(credential.ownerUserId, currentUserId)}</span> : null}
      {credential.createdByUserId ? <span>Created by {operatorLabel(credential.createdByUserId, currentUserId)}</span> : null}
      <span>Created {formatDate(credential.createdAt)}</span>
      {credential.revokedAt ? <span>Revoked {formatDate(credential.revokedAt)}</span> : null}
      {credential.revokedByUserId ? <span>Revoked by {operatorLabel(credential.revokedByUserId, currentUserId)}</span> : null}
      {credential.revocationReason ? <span>Reason {credential.revocationReason}</span> : null}
    </MetadataRow>
  )
}

function ServiceAccountMetadata({ account, currentUserId }: { account: ServiceAccountSummary; currentUserId?: string }) {
  return (
    <MetadataRow>
      <span>Created by {account.createdByUserId ? operatorLabel(account.createdByUserId, currentUserId) : 'a workspace member'}</span>
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
