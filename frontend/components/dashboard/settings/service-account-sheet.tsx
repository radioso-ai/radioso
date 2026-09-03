'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, Pencil } from 'lucide-react'

import {
  apiAccessApi,
  type ApiCredentialMetadata,
  type OneTimeCredentialResponse,
  type ServiceAccountSummary,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { usePagedList } from '@/hooks/use-paged-list'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'

import {
  activeCredentialConsequence,
  serviceAccountDetailMeta,
  serviceAccountStatusBadge,
} from './api-access-row-meta'
import { CredentialRow, EmptyRows, PaginationControls, RenameDialog, RowList } from './api-access-rows'
import {
  CREDENTIAL_EXPIRY_HINT,
  RoleSelect,
  defaultExpiryDate,
  expiryInputToIso,
  type CredentialRole,
} from './api-access-dialogs'
import { CredentialDetailsDialog, CredentialIssuedDialog, RevokeConfirmDialog } from './credential-dialogs'
import { useScopedRowMutations } from './use-scoped-row-mutations'

const ROLE_CONSEQUENCE: Record<CredentialRole, (name: string) => string> = {
  admin: (name) => `${name} gains admin authority on every active credential, immediately.`,
  member: (name) => `${name} loses admin authority immediately. Clients using admin endpoints start failing.`,
}

type CredentialAction = { type: 'details' | 'rename' | 'rotate' | 'revoke'; credential: ApiCredentialMetadata }

export function ServiceAccountSheet({
  workspaceId,
  account: initialAccount,
  createdByName,
  onOpenChange,
  onChanged,
}: {
  workspaceId: string
  account: ServiceAccountSummary
  createdByName: string | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const accountId = initialAccount.id
  const [account, setAccount] = useState(initialAccount)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [issued, setIssued] = useState<OneTimeCredentialResponse | null>(null)
  const [credentialLabel, setCredentialLabel] = useState('')
  const [credentialExpiry, setCredentialExpiry] = useState(() => defaultExpiryDate(365))
  const [pendingRole, setPendingRole] = useState<CredentialRole | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [credentialAction, setCredentialAction] = useState<CredentialAction | null>(null)
  const accountLoadGeneration = useRef(0)

  const mutations = useScopedRowMutations(`${workspaceId}:${accountId}`)
  const isRotatePending = Boolean(credentialAction?.type === 'rotate' && mutations.isPending(credentialAction.credential.id))

  const loadCredentials = useCallback(
    () => apiAccessApi.listServiceCredentials(workspaceId, accountId, { page }),
    [workspaceId, accountId, page],
  )
  const credentials = usePagedList<ApiCredentialMetadata>(loadCredentials, 'Failed to load credentials.')

  const refreshAccount = useCallback(async () => {
    const generation = accountLoadGeneration.current + 1
    accountLoadGeneration.current = generation
    try {
      const current = await apiAccessApi.getServiceAccount(workspaceId, accountId)
      if (accountLoadGeneration.current === generation) setAccount(current)
    } catch (loadError) {
      if (accountLoadGeneration.current === generation) {
        setError(getApiErrorMessage(loadError, 'Failed to load service account.'))
      }
    }
  }, [workspaceId, accountId])

  // The row summary can be a few seconds old; a mutation needs the current revision to be accepted.
  useEffect(() => {
    void refreshAccount()
    return () => {
      accountLoadGeneration.current += 1
    }
  }, [refreshAccount])

  const adjustActiveCredentialCount = (delta: number) => {
    accountLoadGeneration.current += 1
    setAccount((current) => ({
      ...current,
      activeCredentialCount: Math.max(0, current.activeCredentialCount + delta),
    }))
  }

  const applyAccount = (updated: ServiceAccountSummary) => {
    accountLoadGeneration.current += 1
    setAccount(updated)
    onChanged()
  }

  /**
   * Account edits share one row id: the record carries a single revision, so two of them in flight
   * at once would send the same stale revision and lose whichever landed second.
   */
  const runAccountMutation = async (
    mutate: () => Promise<ServiceAccountSummary>,
    failureMessage: string,
  ): Promise<boolean> => {
    setError(null)
    const outcome = await mutations.run('account', mutate)
    if (outcome.status === 'applied') {
      applyAccount(outcome.value)
      return true
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, failureMessage))
    return false
  }

  const rename = async (displayName: string) => {
    const renamed = await runAccountMutation(
      () => apiAccessApi.updateServiceAccount(workspaceId, accountId, { displayName, revision: account.revision }),
      'Failed to rename service account.',
    )
    if (renamed) setRenameOpen(false)
  }

  const changeRole = async (role: CredentialRole) => {
    const changed = await runAccountMutation(
      () => apiAccessApi.updateServiceAccount(workspaceId, accountId, { role, revision: account.revision }),
      'Failed to change service-account role.',
    )
    setPendingRole(null)
    if (changed) credentials.refresh()
  }

  const transition = async (action: 'disable' | 'enable' | 'archive') => {
    const applied = await runAccountMutation(
      () => apiAccessApi.transitionServiceAccount(workspaceId, accountId, action, account.revision),
      `Failed to ${action} service account.`,
    )
    if (applied) {
      setArchiveOpen(false)
      credentials.refresh()
    }
  }

  const issueCredential = async () => {
    const expiresAt = expiryInputToIso(credentialExpiry)
    if (!credentialLabel.trim() || !expiresAt) return
    setError(null)
    const outcome = await mutations.run('issue', () => apiAccessApi.issueServiceCredential(workspaceId, accountId, {
      label: credentialLabel.trim(),
      expiresAt,
    }))
    if (outcome.status === 'applied') {
      setIssued(outcome.value)
      setCredentialLabel('')
      adjustActiveCredentialCount(1)
      credentials.refresh()
      void refreshAccount()
      onChanged()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to issue credential.'))
  }

  const revokeCredential = async (credential: Pick<ApiCredentialMetadata, 'id' | 'status'>) => {
    setError(null)
    const outcome = await mutations.run(credential.id, () => apiAccessApi.revokeServiceCredential(workspaceId, accountId, credential.id))
    if (outcome.status === 'applied') {
      if (credential.status === 'active') {
        adjustActiveCredentialCount(-1)
      }
      credentials.refresh()
      void refreshAccount()
      onChanged()
      return true
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to revoke credential.'))
    return false
  }

  const renameCredential = async (credential: ApiCredentialMetadata, label: string) => {
    setError(null)
    const outcome = await mutations.run(
      credential.id,
      () => apiAccessApi.relabelServiceCredential(workspaceId, accountId, credential.id, label, credential.revision),
    )
    if (outcome.status === 'applied') {
      setCredentialAction(null)
      credentials.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to rename credential.'))
  }

  const rotateCredential = async (credential: ApiCredentialMetadata) => {
    setError(null)
    const outcome = await mutations.run(
      credential.id,
      () => apiAccessApi.rotateServiceCredential(workspaceId, accountId, credential.id, credential.revision),
    )
    if (outcome.status === 'applied') {
      setCredentialAction(null)
      setIssued(outcome.value)
      credentials.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to rotate credential.'))
  }

  const isEnabled = account.status === 'enabled'
  const isArchived = account.status === 'archived'
  const statusBadge = serviceAccountStatusBadge(account)
  const selectedRole = pendingRole ?? account.role
  const isBusy = mutations.isPending('account')

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="gap-1 border-b border-border">
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle className="truncate text-base">{account.displayName}</SheetTitle>
            {statusBadge ? <Badge variant="secondary">{statusBadge}</Badge> : null}
            {isArchived ? null : (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                disabled={isBusy}
                aria-label="Rename service account"
                onClick={() => setRenameOpen(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <SheetDescription>{serviceAccountDetailMeta(account, createdByName)}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <section className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Role</h4>
            <div className="max-w-[14rem] space-y-1.5">
              <RoleSelect
                id="service-account-detail-role"
                ariaLabel="Service account role"
                value={selectedRole}
                disabled={isArchived || isBusy}
                onChange={(role) => setPendingRole(role === account.role ? null : role)}
              />
              <p className="text-xs text-muted-foreground">Applies to live credentials immediately.</p>
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-medium text-foreground">Credentials</h4>

            {account.status === 'disabled' ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                Credentials are inert while the account is disabled.
              </p>
            ) : null}

            {isArchived ? null : (
              <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                <Label htmlFor="service-credential-label" className="sm:col-start-1 sm:row-start-1">Label</Label>
                <Input
                  id="service-credential-label"
                  className="sm:col-start-1 sm:row-start-2"
                  value={credentialLabel}
                  placeholder="Canary runner"
                  onChange={(event) => setCredentialLabel(event.target.value)}
                />
                <Label htmlFor="service-credential-expiry" className="mt-2 sm:col-start-2 sm:row-start-1 sm:mt-0">Expires</Label>
                <Input
                  id="service-credential-expiry"
                  className="sm:col-start-2 sm:row-start-2"
                  type="date"
                  value={credentialExpiry}
                  onChange={(event) => setCredentialExpiry(event.target.value)}
                />
                <p className="text-xs text-muted-foreground sm:col-start-2 sm:row-start-3">{CREDENTIAL_EXPIRY_HINT}</p>
                <Button
                  type="button"
                  className="mt-2 justify-self-start sm:col-start-3 sm:row-start-2 sm:mt-0"
                  disabled={!isEnabled || mutations.isPending('issue') || !credentialLabel.trim() || !credentialExpiry}
                  onClick={() => void issueCredential()}
                >
                  {mutations.isPending('issue') ? <Spinner className="mr-2 h-4 w-4" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Issue
                </Button>
              </div>
            )}

            {credentials.error ? <p role="alert" className="text-sm text-destructive">{credentials.error}</p> : null}

            {credentials.isLoading ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" />Loading
              </span>
            ) : credentials.items.length === 0 ? (
              <EmptyRows>No credentials yet.</EmptyRows>
            ) : (
              <RowList>
                {credentials.items.map((credential) => (
                  <CredentialRow
                    key={credential.id}
                    credential={credential}
                    busy={mutations.isPending(credential.id)}
                    onDetails={() => setCredentialAction({ type: 'details', credential })}
                    onRename={() => setCredentialAction({ type: 'rename', credential })}
                    onRotate={() => setCredentialAction({ type: 'rotate', credential })}
                    onRevoke={() => setCredentialAction({ type: 'revoke', credential })}
                  />
                ))}
              </RowList>
            )}
            <PaginationControls page={page} total={credentials.total} onPage={setPage} />
          </section>

          {isArchived ? null : (
            <section className="space-y-3">
              <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
              <div className="divide-y divide-destructive/30 overflow-hidden rounded-lg border border-destructive/30">
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{isEnabled ? 'Disable' : 'Enable'}</p>
                    <p className="text-xs text-muted-foreground">
                      {isEnabled ? 'Credentials stop working until re-enabled.' : 'Credentials start working again.'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => void transition(isEnabled ? 'disable' : 'enable')}
                  >
                    {isEnabled ? 'Disable' : 'Enable'}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Archive</p>
                    <p className="text-xs text-muted-foreground">Permanent. Revokes every credential.</p>
                  </div>
                  <Button type="button" size="sm" variant="destructive" disabled={isBusy} onClick={() => setArchiveOpen(true)}>
                    Archive
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </SheetContent>

      {renameOpen ? (
        <RenameDialog
          kind="service account"
          fieldLabel="Name"
          initialValue={account.displayName}
          isSaving={isBusy}
          onSave={(value) => void rename(value)}
          onOpenChange={(open) => {
            if (!open) setRenameOpen(false)
          }}
        />
      ) : null}

      <AlertDialog
        open={pendingRole !== null}
        onOpenChange={(open) => {
          // Cancelling must put the select back where the operator found it.
          if (!open) setPendingRole(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change role to {selectedRole === 'admin' ? 'Admin' : 'Member'}?</AlertDialogTitle>
            <AlertDialogDescription>{ROLE_CONSEQUENCE[selectedRole](account.displayName)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBusy}
              onClick={(event) => {
                event.preventDefault()
                if (pendingRole) void changeRole(pendingRole)
              }}
            >
              {isBusy ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Change role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveOpen} onOpenChange={(open) => { if (!open && !isBusy) setArchiveOpen(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {account.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>{activeCredentialConsequence(account.activeCredentialCount)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void transition('archive')
              }}
            >
              {isBusy ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Archive service account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {credentialAction?.type === 'details' ? (
        <CredentialDetailsDialog
          details={{
            label: credentialAction.credential.label,
            prefix: credentialAction.credential.prefix,
            createdAt: credentialAction.credential.createdAt,
            expiresAt: credentialAction.credential.expiresAt,
            lastUsedAt: credentialAction.credential.lastUsedAt,
            revokedAt: credentialAction.credential.revokedAt,
          }}
          onOpenChange={(open) => {
            if (!open) setCredentialAction(null)
          }}
        />
      ) : null}

      {credentialAction?.type === 'rename' ? (
        <RenameDialog
          kind="credential"
          fieldLabel="Label"
          initialValue={credentialAction.credential.label}
          isSaving={mutations.isPending(credentialAction.credential.id)}
          onSave={(value) => void renameCredential(credentialAction.credential, value)}
          onOpenChange={(open) => {
            if (!open) setCredentialAction(null)
          }}
        />
      ) : null}

      <AlertDialog
        open={credentialAction?.type === 'rotate'}
        onOpenChange={(open) => {
          if (!open && !isRotatePending) setCredentialAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate {credentialAction?.credential.label ?? 'credential'}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current secret stops working immediately. The replacement is shown once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRotatePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRotatePending}
              onClick={(event) => {
                event.preventDefault()
                if (credentialAction && !isRotatePending) void rotateCredential(credentialAction.credential)
              }}
            >
              Rotate credential
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RevokeConfirmDialog
        open={credentialAction?.type === 'revoke'}
        label={credentialAction?.credential.label ?? 'credential'}
        prefix={credentialAction?.credential.prefix ?? ''}
        isRevoking={Boolean(credentialAction && mutations.isPending(credentialAction.credential.id))}
        onConfirm={() => {
          if (!credentialAction) return
          void revokeCredential(credentialAction.credential).then((succeeded) => {
            if (succeeded) setCredentialAction(null)
          })
        }}
        onOpenChange={(open) => {
          if (!open) setCredentialAction(null)
        }}
      />

      {issued ? (
        <CredentialIssuedDialog
          secret={issued.secret}
          copyAriaLabel="Copy service credential secret"
          error={error}
          onDiscard={async () => {
            const revoked = await revokeCredential(issued.credential)
            if (revoked) setIssued(null)
          }}
          onDone={() => setIssued(null)}
        />
      ) : null}
    </Sheet>
  )
}
