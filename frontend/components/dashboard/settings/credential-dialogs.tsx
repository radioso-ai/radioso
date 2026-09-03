'use client'

import { useState, type ReactNode } from 'react'

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
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'

/** One date style for every credential surface: "Sep 11, 2026". */
export const formatCredentialDate = (value: string | null | undefined): string => {
  if (!value) return 'never'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'unknown'
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const CREDENTIAL_SAVED_ACKNOWLEDGEMENT = 'Secret saved — it won’t be shown again.'

/**
 * Shown after every issue, create, and rotate. The secret exists only here, so the
 * dialog refuses Escape and outside clicks: the two ways out are an acknowledged
 * Done or an explicit discard that revokes the credential just handed out.
 */
export function CredentialIssuedDialog({
  secret,
  title = 'Credential issued',
  description,
  acknowledgeLabel = CREDENTIAL_SAVED_ACKNOWLEDGEMENT,
  copyAriaLabel = 'Copy credential secret',
  discardLabel = 'Discard — revokes credential',
  additionalContent,
  error,
  onDiscard,
  onDone,
}: {
  secret: string
  title?: string
  description?: string
  acknowledgeLabel?: string
  copyAriaLabel?: string
  discardLabel?: string
  additionalContent?: ReactNode
  error?: string | null
  onDiscard?: () => void | Promise<void>
  onDone: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [isDiscarding, setIsDiscarding] = useState(false)

  const discard = async () => {
    if (!onDiscard) return
    setIsDiscarding(true)
    try {
      await onDiscard()
    } finally {
      setIsDiscarding(false)
    }
  }

  // Radix associates its own description; without one, opt out instead of pointing at a missing node.
  const describedBy = description ? {} : { 'aria-describedby': undefined }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        {...describedBy}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <CopyValueField value={secret} ariaLabel={copyAriaLabel} className="w-full" />
        {additionalContent}
        <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5"
          />
          {acknowledgeLabel}
        </label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          {onDiscard ? (
            <Button type="button" variant="ghost" disabled={isDiscarding} onClick={() => void discard()}>
              {isDiscarding ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {discardLabel}
            </Button>
          ) : null}
          <Button type="button" onClick={onDone} disabled={!acknowledged || isDiscarding}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const revokeConsequence = (prefix: string, ownerName?: string) =>
  ownerName
    ? `${prefix}, owned by ${ownerName}, stops working immediately. Cannot be undone.`
    : `${prefix} stops working immediately. Cannot be undone.`

export function RevokeConfirmDialog({
  open,
  label,
  prefix,
  ownerName,
  isRevoking = false,
  onConfirm,
  onOpenChange,
}: {
  open: boolean
  label: string
  prefix: string
  ownerName?: string
  isRevoking?: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {label}?</AlertDialogTitle>
          <AlertDialogDescription>{revokeConsequence(prefix, ownerName)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isRevoking}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {isRevoking ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface CredentialDetails {
  label: string
  prefix: string
  createdAt: string
  createdByName?: string
  expiresAt?: string | null
  lastUsedAt: string | null
  revokedAt?: string | null
}

/** Only the facts a record actually carries: an absent date is omitted, never rendered as "Never". */
export const credentialDetailFacts = (details: CredentialDetails): string[] => {
  const facts = [details.prefix]
  facts.push(details.createdByName
    ? `Created by ${details.createdByName} · ${formatCredentialDate(details.createdAt)}`
    : `Created ${formatCredentialDate(details.createdAt)}`)
  if (details.expiresAt) facts.push(`Expires ${formatCredentialDate(details.expiresAt)}`)
  facts.push(`Last used ${formatCredentialDate(details.lastUsedAt)}`)
  if (details.revokedAt) facts.push(`Revoked ${formatCredentialDate(details.revokedAt)}`)
  return facts
}

export function CredentialDetailsDialog({
  details,
  onOpenChange,
}: {
  details: CredentialDetails
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{details.label}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5 text-sm text-muted-foreground">
          {credentialDetailFacts(details).map((fact) => <span key={fact}>{fact}</span>)}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
