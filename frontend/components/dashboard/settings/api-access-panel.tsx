'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, RefreshCw, ShieldCheck } from 'lucide-react'

import {
  accountApi,
  apiAccessApi,
  type ApiAccessSummary,
  type ApiCredentialMetadata,
  type OneTimeCredentialResponse,
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
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'

import { CredentialRow, EmptyRows, PaginationControls, RenameDialog, RowList } from './api-access-rows'
import {
  CreatePersonalTokenDialog,
  expiryInputToIso,
  type PersonalTokenDraft,
} from './api-access-dialogs'
import { CredentialDetailsDialog, CredentialIssuedDialog, RevokeConfirmDialog } from './credential-dialogs'
import { ServiceAccountsCard } from './service-accounts-card'
import { SettingsCard } from './settings-card'
import { useScopedRowMutations } from './use-scoped-row-mutations'

type TokenAction = { type: 'details' | 'rename' | 'rotate' | 'revoke'; credential: ApiCredentialMetadata }

/**
 * Every API identity a workspace can hold, in the order an operator needs them: the token that acts
 * as them, the identities their integrations act as, then — for administrators — everyone else's
 * tokens as an audit surface.
 */
export function ApiAccessPanel({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { user } = useAuth()
  const [summary, setSummary] = useState<ApiAccessSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(workspaceId))

  useEffect(() => {
    let active = true

    const load = async () => {
      if (!workspaceId) {
        setSummary(null)
        setIsLoading(false)
        return
      }
      setIsLoading(true)
      try {
        const nextSummary = await apiAccessApi.getSummary(workspaceId)
        if (!active) return
        setSummary(nextSummary)
        setError(null)
      } catch (loadError) {
        if (!active) return
        setSummary(null)
        setError(getApiErrorMessage(loadError, 'Failed to load API access.'))
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [workspaceId])

  if (!workspaceId) return null

  const canManagePersonal = summary?.capabilities.manageOwnPersonalTokens !== false
  const canManageServices = summary?.capabilities.manageServiceAccounts === true
  const canAudit = summary?.capabilities.auditWorkspacePersonalTokens === true
  const adminSelectable = summary !== null && summary.effectiveRole !== 'member'

  return (
    <div id="api-access" className="space-y-6 scroll-mt-24">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading API access…
        </div>
      ) : null}

      {summary ? (
        <>
          <PersonalTokensCard
            workspaceId={workspaceId}
            canCreate={canManagePersonal}
            adminSelectable={adminSelectable}
            showServiceAccountLink={canManageServices}
          />

          {canManageServices ? (
            <ServiceAccountsCard
              workspaceId={workspaceId}
              adminSelectable={adminSelectable}
              currentUserId={user?.userId}
            />
          ) : null}

          {canAudit ? <MemberPersonalTokensCard workspaceId={workspaceId} currentUserId={user?.userId} /> : null}
        </>
      ) : null}
    </div>
  )
}

function PersonalTokensCard({
  workspaceId,
  canCreate,
  adminSelectable,
  showServiceAccountLink,
}: {
  workspaceId: string
  canCreate: boolean
  adminSelectable: boolean
  showServiceAccountLink: boolean
}) {
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<OneTimeCredentialResponse | null>(null)
  const [action, setAction] = useState<TokenAction | null>(null)
  const mutations = useScopedRowMutations(workspaceId)

  const load = useCallback(
    () => apiAccessApi.listPersonalTokens(workspaceId, { view: 'mine', page }),
    [workspaceId, page],
  )
  const tokens = usePagedList<ApiCredentialMetadata>(load, 'Failed to load personal tokens.')

  const create = async (draft: PersonalTokenDraft) => {
    const expiresAt = expiryInputToIso(draft.expiry)
    if (!draft.label.trim() || !expiresAt) return
    setFormError(null)
    const outcome = await mutations.run('create', () => apiAccessApi.createPersonalToken(workspaceId, {
      label: draft.label.trim(),
      roleCeiling: adminSelectable ? draft.role : 'member',
      expiresAt,
    }))
    if (outcome.status === 'applied') {
      setCreateOpen(false)
      setIssued(outcome.value)
      tokens.refresh()
    }
    if (outcome.status === 'failed') setFormError(getApiErrorMessage(outcome.error, 'Failed to create token.'))
  }

  const revoke = async (credentialId: string): Promise<boolean> => {
    setError(null)
    const outcome = await mutations.run(credentialId, () => apiAccessApi.revokePersonalToken(workspaceId, credentialId))
    if (outcome.status === 'applied') {
      tokens.refresh()
      return true
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to revoke token.'))
    return false
  }

  const rename = async (credential: ApiCredentialMetadata, label: string) => {
    setError(null)
    const outcome = await mutations.run(
      credential.id,
      () => apiAccessApi.relabelPersonalToken(workspaceId, credential.id, label, credential.revision),
    )
    if (outcome.status === 'applied') {
      setAction(null)
      tokens.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to rename token.'))
  }

  const rotate = async (credential: ApiCredentialMetadata) => {
    setError(null)
    const outcome = await mutations.run(
      credential.id,
      () => apiAccessApi.rotatePersonalToken(workspaceId, credential.id, credential.revision),
    )
    if (outcome.status === 'applied') {
      setAction(null)
      setIssued(outcome.value)
      tokens.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to rotate token.'))
  }

  return (
    <SettingsCard
      id="personal-tokens"
      icon={<KeyRound className="h-5 w-5 text-primary" />}
      title="Personal tokens"
      description="Act as you."
      headerEnd={canCreate ? (
        <Button type="button" size="sm" onClick={() => { setFormError(null); setCreateOpen(true) }}>
          <Plus className="mr-2 h-4 w-4" />
          Create token
        </Button>
      ) : null}
    >
      <div className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {tokens.error ? <p role="alert" className="text-sm text-destructive">{tokens.error}</p> : null}

        {tokens.isLoading ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3.5 w-3.5" />Loading
          </span>
        ) : tokens.items.length === 0 ? (
          <EmptyRows>No personal tokens yet.</EmptyRows>
        ) : (
          <RowList>
            {tokens.items.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                busy={mutations.isPending(credential.id)}
                onDetails={() => setAction({ type: 'details', credential })}
                onRename={() => setAction({ type: 'rename', credential })}
                onRotate={() => setAction({ type: 'rotate', credential })}
                onRevoke={() => setAction({ type: 'revoke', credential })}
              />
            ))}
          </RowList>
        )}

        <PaginationControls page={page} total={tokens.total} onPage={setPage} />

        {showServiceAccountLink ? (
          <p className="text-xs text-muted-foreground">
            Production integration? <a className="text-primary hover:underline" href="#service-accounts">Use a service account</a>.
          </p>
        ) : null}
      </div>

      {createOpen ? (
        <CreatePersonalTokenDialog
          adminSelectable={adminSelectable}
          error={formError}
          isSubmitting={mutations.isPending('create')}
          onSubmit={(draft) => void create(draft)}
          onOpenChange={(open) => { if (!open) setCreateOpen(false) }}
        />
      ) : null}

      <TokenActionDialogs
        action={action}
        isBusy={Boolean(action && mutations.isPending(action.credential.id))}
        onClear={() => setAction(null)}
        onRename={rename}
        onRotate={rotate}
        onRevoke={async (credential) => {
          const revoked = await revoke(credential.id)
          if (revoked) setAction(null)
        }}
      />

      {issued ? (
        <CredentialIssuedDialog
          secret={issued.secret}
          copyAriaLabel="Copy personal token secret"
          error={error}
          onDiscard={async () => {
            const revoked = await revoke(issued.credential.id)
            if (revoked) setIssued(null)
          }}
          onDone={() => setIssued(null)}
        />
      ) : null}
    </SettingsCard>
  )
}

/**
 * Administrators can end any member's token but cannot act as one: no rename, no rotate, and the
 * owner is named in the row and in the revoke confirmation.
 */
function MemberPersonalTokensCard({
  workspaceId,
  currentUserId,
}: {
  workspaceId: string
  currentUserId: string | undefined
}) {
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiCredentialMetadata | null>(null)
  const mutations = useScopedRowMutations(workspaceId)
  const ownerNames = useWorkspaceMemberNames()

  const load = useCallback(
    () => apiAccessApi.listPersonalTokens(workspaceId, { view: 'workspace', page }),
    [workspaceId, page],
  )
  const tokens = usePagedList<ApiCredentialMetadata>(load, 'Failed to load member tokens.')
  // Own tokens are managed in full one card above; this list is only about everyone else's.
  const memberTokens = tokens.items.filter((credential) => credential.ownerUserId !== currentUserId)
  const ownerName = (credential: ApiCredentialMetadata) =>
    (credential.ownerUserId ? ownerNames.get(credential.ownerUserId) : null) ?? 'Another member'

  const revoke = async (credential: ApiCredentialMetadata) => {
    setError(null)
    const outcome = await mutations.run(credential.id, () => apiAccessApi.revokePersonalToken(workspaceId, credential.id))
    if (outcome.status === 'applied') {
      setRevokeTarget(null)
      tokens.refresh()
    }
    if (outcome.status === 'failed') setError(getApiErrorMessage(outcome.error, 'Failed to revoke token.'))
  }

  return (
    <SettingsCard
      id="member-personal-tokens"
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      title="Members’ personal tokens"
      description="Revoke any; owners manage their own."
    >
      <div className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {tokens.error ? <p role="alert" className="text-sm text-destructive">{tokens.error}</p> : null}

        {tokens.isLoading ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3.5 w-3.5" />Loading
          </span>
        ) : memberTokens.length === 0 ? (
          <EmptyRows>
            {tokens.items.length === 0 ? 'No other members hold personal tokens.' : 'No member tokens on this page.'}
          </EmptyRows>
        ) : (
          <RowList>
            {memberTokens.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                ownerName={ownerName(credential)}
                busy={mutations.isPending(credential.id)}
                onRevoke={() => setRevokeTarget(credential)}
              />
            ))}
          </RowList>
        )}

        <PaginationControls page={page} total={tokens.total} onPage={setPage} />

        <p className="text-xs text-muted-foreground">
          Agent-scoped credentials (Agent API, MCP) live on each agent’s Channels tab.
        </p>
      </div>

      <RevokeConfirmDialog
        open={revokeTarget !== null}
        label={revokeTarget?.label ?? 'token'}
        prefix={revokeTarget?.prefix ?? ''}
        ownerName={revokeTarget ? ownerName(revokeTarget) : undefined}
        isRevoking={Boolean(revokeTarget && mutations.isPending(revokeTarget.id))}
        onConfirm={() => {
          if (revokeTarget) void revoke(revokeTarget)
        }}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
      />
    </SettingsCard>
  )
}

function TokenActionDialogs({
  action,
  isBusy,
  onClear,
  onRename,
  onRotate,
  onRevoke,
}: {
  action: TokenAction | null
  isBusy: boolean
  onClear: () => void
  onRename: (credential: ApiCredentialMetadata, label: string) => void
  onRotate: (credential: ApiCredentialMetadata) => void
  onRevoke: (credential: ApiCredentialMetadata) => void
}) {
  return (
    <>
      {action?.type === 'details' ? (
        <CredentialDetailsDialog
          details={{
            label: action.credential.label,
            prefix: action.credential.prefix,
            createdAt: action.credential.createdAt,
            expiresAt: action.credential.expiresAt,
            lastUsedAt: action.credential.lastUsedAt,
            revokedAt: action.credential.revokedAt,
          }}
          onOpenChange={(open) => { if (!open) onClear() }}
        />
      ) : null}

      {action?.type === 'rename' ? (
        <RenameDialog
          kind="token"
          fieldLabel="Label"
          initialValue={action.credential.label}
          isSaving={isBusy}
          onSave={(value) => onRename(action.credential, value)}
          onOpenChange={(open) => { if (!open) onClear() }}
        />
      ) : null}

      {action?.type === 'rotate' ? (
        <RotateConfirmDialog
          label={action.credential.label}
          isRotating={isBusy}
          onConfirm={() => onRotate(action.credential)}
          onOpenChange={(open) => { if (!open) onClear() }}
        />
      ) : null}

      <RevokeConfirmDialog
        open={action?.type === 'revoke'}
        label={action?.credential.label ?? 'token'}
        prefix={action?.credential.prefix ?? ''}
        isRevoking={isBusy}
        onConfirm={() => {
          if (action) onRevoke(action.credential)
        }}
        onOpenChange={(open) => { if (!open) onClear() }}
      />
    </>
  )
}

/** Rotation ends a live secret, so it confirms first and then hands over the replacement once. */
function RotateConfirmDialog({
  label,
  isRotating,
  onConfirm,
  onOpenChange,
}: {
  label: string
  isRotating: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rotate {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The current secret stops working immediately. The replacement is shown once.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRotating}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isRotating}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {isRotating ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Rotate token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Owner names for the audit list. The credential inventory carries user ids only, so names come
 * from the account directory; when that call is unavailable the list still works, unnamed.
 */
function useWorkspaceMemberNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const response = await accountApi.listUsers()
        if (!active) return
        setNames(new Map(response.users.map((member) => [member.userId, member.email])))
      } catch {
        // An unnamed owner is a smaller failure than an audit list that refuses to render.
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  return names
}
