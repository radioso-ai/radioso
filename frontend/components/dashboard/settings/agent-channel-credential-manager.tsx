'use client'

import { useState } from 'react'
import { Info, KeyRound, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react'

import { defaultExpiryDate, expiryInputToIso } from '@/components/dashboard/settings/api-access-dialogs'
import {
  CredentialDetailsDialog,
  CredentialIssuedDialog,
  RevokeConfirmDialog,
  formatCredentialDate,
} from '@/components/dashboard/settings/credential-dialogs'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  agentChannelAudienceName,
  useAgentChannelCredentials,
} from '@/hooks/use-agent-channel-credentials'
import type { AgentChannelCredential, AgentChannelCredentialAudience } from '@/lib/api-agent-channel-credentials'

export const CREDENTIAL_EXPIRY_HINT = 'Rotate before this date.'

const statusBadgeLabel = (status: AgentChannelCredential['status']) =>
  `${status.charAt(0).toUpperCase()}${status.slice(1)}`

/** Quiet row meta: identity, when it stops working, and whether anything ever used it. */
const credentialMeta = (credential: AgentChannelCredential): string => {
  const facts = [
    credential.prefix,
    `Expires ${formatCredentialDate(credential.expiresAt)}`,
    `Last used ${formatCredentialDate(credential.lastUsedAt)}`,
  ]
  if (credential.revokedAt) facts.push(`Revoked ${formatCredentialDate(credential.revokedAt)}`)
  return facts.join(' · ')
}

type RowAction = { type: 'details' | 'revoke' | 'rotate'; credential: AgentChannelCredential }

export function AgentChannelCredentialList({
  credentials,
  busyCredentialId,
  hasMore,
  heading,
  isLoading,
  isLoadingMore,
  emptyMessage,
  onLoadMore,
  onRevoke,
  onRotate,
}: {
  credentials: AgentChannelCredential[]
  busyCredentialId: string | null
  hasMore: boolean
  heading?: string
  isLoading: boolean
  isLoadingMore: boolean
  emptyMessage: string
  onLoadMore: () => void
  onRevoke: (credentialId: string) => Promise<boolean>
  onRotate: (credentialId: string) => Promise<boolean>
}) {
  const [action, setAction] = useState<RowAction | null>(null)

  const runAction = async () => {
    if (!action || action.type === 'details') return
    const succeeded = action.type === 'rotate'
      ? await onRotate(action.credential.id)
      : await onRevoke(action.credential.id)
    if (succeeded) setAction(null)
  }

  const closeUnlessBusy = (open: boolean) => {
    if (!open && !busyCredentialId) setAction(null)
  }

  return (
    <div className="space-y-3">
      {heading || isLoading ? (
        <div className="flex items-center justify-between gap-3">
          {heading ? <h4 className="text-sm font-medium text-foreground">{heading}</h4> : <span />}
          {isLoading ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" />Loading
            </span>
          ) : null}
        </div>
      ) : null}

      {!isLoading && credentials.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</p>
      ) : null}

      <div className="space-y-2">
        {credentials.map((credential) => {
          const active = credential.status === 'active'
          const busy = busyCredentialId === credential.id
          return (
            <div key={credential.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{credential.label}</p>
                  {active ? null : <Badge variant="secondary">{statusBadgeLabel(credential.status)}</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{credentialMeta(credential)}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    disabled={busy}
                    aria-label={`Actions for ${credential.label}`}
                  >
                    {busy ? <Spinner className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setAction({ type: 'details', credential })}>
                    <Info className="mr-2 h-4 w-4" />
                    Details
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!active} onSelect={() => setAction({ type: 'rotate', credential })}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Rotate
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" disabled={!active} onSelect={() => setAction({ type: 'revoke', credential })}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Revoke
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        })}
      </div>

      {hasMore ? (
        <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
          {isLoadingMore ? <Spinner className="mr-2 h-4 w-4" /> : null}Load more
        </Button>
      ) : null}

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
          onOpenChange={(open) => {
            if (!open) setAction(null)
          }}
        />
      ) : null}

      <AlertDialog open={action?.type === 'rotate'} onOpenChange={closeUnlessBusy}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate {action?.credential.label ?? 'credential'}?</AlertDialogTitle>
            <AlertDialogDescription>
              The current secret stops working immediately. The replacement is shown once, so update the client before leaving this page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyCredentialId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyCredentialId)}
              onClick={(event) => {
                event.preventDefault()
                void runAction()
              }}
            >
              {busyCredentialId ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Rotate credential
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RevokeConfirmDialog
        open={action?.type === 'revoke'}
        label={action?.credential.label ?? 'credential'}
        prefix={action?.credential.prefix ?? ''}
        isRevoking={Boolean(busyCredentialId)}
        onConfirm={() => void runAction()}
        onOpenChange={closeUnlessBusy}
      />
    </div>
  )
}

function IssueCredentialForm({
  audience,
  isCreating,
  onIssue,
}: {
  audience: AgentChannelCredentialAudience
  isCreating: boolean
  onIssue: (input: { label: string; expiresAt: string }) => void
}) {
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState(() => defaultExpiryDate(90))
  const expiresAt = expiryInputToIso(expiry)

  return (
    <div className="grid gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,1fr)_11rem_auto]">
      <Label htmlFor={`${audience}-credential-label`} className="md:col-start-1 md:row-start-1">Credential label</Label>
      <Input
        id={`${audience}-credential-label`}
        className="md:col-start-1 md:row-start-2"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Production chat client"
      />
      <Label htmlFor={`${audience}-credential-expiry`} className="mt-2 md:col-start-2 md:row-start-1 md:mt-0">Expires</Label>
      <Input
        id={`${audience}-credential-expiry`}
        className="md:col-start-2 md:row-start-2"
        type="date"
        value={expiry}
        onChange={(event) => setExpiry(event.target.value)}
      />
      <p className="text-xs text-muted-foreground md:col-start-2 md:row-start-3">{CREDENTIAL_EXPIRY_HINT}</p>
      <Button
        type="button"
        className="mt-2 justify-self-start md:col-start-3 md:row-start-2 md:mt-0"
        disabled={isCreating || !label.trim() || !expiresAt}
        onClick={() => {
          if (!expiresAt) return
          onIssue({ label: label.trim(), expiresAt })
        }}
      >
        {isCreating ? <Spinner className="mr-2 h-4 w-4" /> : <KeyRound className="mr-2 h-4 w-4" />}
        Create credential
      </Button>
    </div>
  )
}

/**
 * Agent API credentials: a label and an expiry, then the one-time secret. MCP renders
 * its own connect flow over the same engine, because a connection there is a credential
 * plus the client configuration that consumes it.
 */
export function AgentChannelCredentialManager({
  agentId,
  audience,
}: {
  agentId: string
  audience: AgentChannelCredentialAudience
}) {
  const engine = useAgentChannelCredentials(agentId, audience)
  const audienceName = agentChannelAudienceName(audience)

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-foreground">Credentials</h4>

      <IssueCredentialForm
        key={`${agentId}:${audience}`}
        audience={audience}
        isCreating={engine.isCreating}
        onIssue={(input) => void engine.issue(input)}
      />

      {engine.error ? <p role="alert" className="text-sm text-destructive">{engine.error}</p> : null}

      <AgentChannelCredentialList
        emptyMessage={`No ${audienceName} credentials yet.`}
        credentials={engine.credentials}
        busyCredentialId={engine.busyCredentialId}
        hasMore={engine.hasMore}
        isLoading={engine.isLoading}
        isLoadingMore={engine.isLoadingMore}
        onLoadMore={() => void engine.loadMore()}
        onRevoke={engine.revoke}
        onRotate={engine.rotate}
      />

      {engine.issued ? (
        <CredentialIssuedDialog
          secret={engine.issued.secret}
          copyAriaLabel={`Copy ${audienceName} credential secret`}
          error={engine.error}
          onDiscard={async () => {
            if (engine.issued) await engine.revoke(engine.issued.credential.id)
          }}
          onDone={engine.clearIssued}
        />
      ) : null}
    </div>
  )
}
