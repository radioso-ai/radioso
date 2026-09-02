'use client'

import { useCallback, useState } from 'react'
import { Plus, Server } from 'lucide-react'

import {
  apiAccessApi,
  type OneTimeCredentialResponse,
  type ServiceAccountSummary,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { usePagedList } from '@/hooks/use-paged-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

import { serviceAccountRowMeta, serviceAccountStatusBadge } from './api-access-row-meta'
import { EmptyRows, PaginationControls, QuietRow, RowList } from './api-access-rows'
import { CreateServiceAccountDialog, expiryInputToIso, type ServiceAccountDraft } from './api-access-dialogs'
import { CredentialIssuedDialog } from './credential-dialogs'
import { ServiceAccountSheet } from './service-account-sheet'
import { SettingsCard } from './settings-card'
import { useScopedRowMutations } from './use-scoped-row-mutations'

/** A created service account hands back its identity and its first credential in one response. */
type IssuedServiceCredential = OneTimeCredentialResponse & { serviceAccountId: string }

export function ServiceAccountsCard({
  workspaceId,
  adminSelectable,
  currentUserId,
}: {
  workspaceId: string
  adminSelectable: boolean
  currentUserId: string | undefined
}) {
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedServiceCredential | null>(null)
  const [managed, setManaged] = useState<ServiceAccountSummary | null>(null)
  const mutations = useScopedRowMutations(workspaceId)

  const load = useCallback(
    () => apiAccessApi.listServiceAccounts(workspaceId, { page }),
    [workspaceId, page],
  )
  const accounts = usePagedList<ServiceAccountSummary>(load, 'Failed to load service accounts.')

  const create = async (draft: ServiceAccountDraft) => {
    const credentialExpiresAt = expiryInputToIso(draft.expiry)
    if (!draft.displayName.trim() || !credentialExpiresAt) return
    setFormError(null)
    const outcome = await mutations.run('create', () => apiAccessApi.createServiceAccount(workspaceId, {
      displayName: draft.displayName.trim(),
      role: adminSelectable ? draft.role : 'member',
      credentialExpiresAt,
    }))
    if (outcome.status === 'applied') {
      setCreateOpen(false)
      setIssued({
        credential: outcome.value.credential,
        secret: outcome.value.secret,
        serviceAccountId: outcome.value.serviceAccount.id,
      })
      accounts.refresh()
    }
    if (outcome.status === 'failed') setFormError(getApiErrorMessage(outcome.error, 'Failed to create service account.'))
  }

  const discardIssued = async () => {
    if (!issued) return
    setError(null)
    const outcome = await mutations.run(
      issued.credential.id,
      () => apiAccessApi.revokeServiceCredential(workspaceId, issued.serviceAccountId, issued.credential.id),
    )
    if (outcome.status === 'applied') {
      setIssued(null)
      accounts.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to revoke credential.'))
  }

  return (
    <SettingsCard
      id="service-accounts"
      icon={<Server className="h-5 w-5 text-primary" />}
      title="Service accounts"
      description="One identity per integration, revocable on its own."
      headerEnd={(
        <Button type="button" size="sm" onClick={() => { setFormError(null); setCreateOpen(true) }}>
          <Plus className="mr-2 h-4 w-4" />
          New service account
        </Button>
      )}
    >
      <div className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {accounts.error ? <p role="alert" className="text-sm text-destructive">{accounts.error}</p> : null}

        {accounts.isLoading ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3.5 w-3.5" />Loading
          </span>
        ) : accounts.items.length === 0 ? (
          <EmptyRows>No service accounts yet.</EmptyRows>
        ) : (
          <RowList>
            {accounts.items.map((account) => {
              const statusBadge = serviceAccountStatusBadge(account)
              return (
                <QuietRow
                  key={account.id}
                  name={account.displayName}
                  muted={account.status === 'archived'}
                  badges={statusBadge ? <Badge variant="secondary">{statusBadge}</Badge> : null}
                  meta={serviceAccountRowMeta(account)}
                  actions={(
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Manage ${account.displayName}`}
                      onClick={() => setManaged(account)}
                    >
                      Manage
                    </Button>
                  )}
                />
              )
            })}
          </RowList>
        )}

        <PaginationControls page={page} total={accounts.total} onPage={setPage} />
      </div>

      {createOpen ? (
        <CreateServiceAccountDialog
          adminSelectable={adminSelectable}
          error={formError}
          isSubmitting={mutations.isPending('create')}
          onSubmit={(draft) => void create(draft)}
          onOpenChange={(open) => { if (!open) setCreateOpen(false) }}
        />
      ) : null}

      {managed ? (
        <ServiceAccountSheet
          key={managed.id}
          workspaceId={workspaceId}
          account={managed}
          createdByName={managed.createdByUserId && managed.createdByUserId === currentUserId ? 'you' : null}
          onChanged={accounts.refresh}
          onOpenChange={(open) => { if (!open) setManaged(null) }}
        />
      ) : null}

      {issued ? (
        <CredentialIssuedDialog
          secret={issued.secret}
          copyAriaLabel="Copy service credential secret"
          onDiscard={discardIssued}
          onDone={() => setIssued(null)}
        />
      ) : null}
    </SettingsCard>
  )
}
