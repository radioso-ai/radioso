'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export type CredentialRole = 'member' | 'admin'

export type PersonalTokenDraft = { label: string; role: CredentialRole; expiry: string }
export type ServiceAccountDraft = { displayName: string; role: CredentialRole; expiry: string }

export const defaultExpiryDate = (days: number, now = new Date()) => {
  const expiry = new Date(now)
  expiry.setUTCDate(expiry.getUTCDate() + days)
  return expiry.toISOString().slice(0, 10)
}

/** Turns a date input's `YYYY-MM-DD` into the instant the API expects. */
export const expiryInputToIso = (value: string): string | null => {
  const expiry = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null
}

/** Matches the Input primitive so selects and text fields line up on the same baseline. */
export const nativeSelectClassName =
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

export function RoleSelect({
  id,
  value,
  onChange,
  adminSelectable = true,
  disabled = false,
  className,
  ariaLabel,
}: {
  id: string
  value: CredentialRole
  onChange: (role: CredentialRole) => void
  adminSelectable?: boolean
  disabled?: boolean
  className?: string
  /** Names the control where the section heading, not a form label, introduces it. */
  ariaLabel?: string
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={cn(nativeSelectClassName, className)}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as CredentialRole)}
    >
      <option value="member">Member</option>
      <option value="admin" disabled={!adminSelectable}>Admin</option>
    </select>
  )
}

/** One expiry instruction for every credential family. */
export const CREDENTIAL_EXPIRY_HINT = 'Rotate before this date.'

function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function CreateDialogShell({
  title,
  description,
  error,
  submitLabel,
  submitDisabled,
  isSubmitting,
  onSubmit,
  onOpenChange,
  children,
}: {
  title: string
  description: string
  error: string | null
  submitLabel: string
  submitDisabled: boolean
  isSubmitting: boolean
  onSubmit: () => void
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  // A successful submit hands focus to the one-time-secret dialog that replaces
  // this one, so skip Radix's focus restoration in that case only.
  const submitted = useRef(false)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (submitted.current) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (submitDisabled || isSubmitting) return
            submitted.current = true
            onSubmit()
          }}
        >
          {children}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitDisabled || isSubmitting}>
              <Plus className="mr-2 h-4 w-4" />
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CreatePersonalTokenDialog({
  adminSelectable,
  error,
  isSubmitting,
  onSubmit,
  onOpenChange,
}: {
  adminSelectable: boolean
  error: string | null
  isSubmitting: boolean
  onSubmit: (draft: PersonalTokenDraft) => void
  onOpenChange: (open: boolean) => void
}) {
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<CredentialRole>('member')
  const [expiry, setExpiry] = useState(() => defaultExpiryDate(90))

  return (
    <CreateDialogShell
      title="Create token"
      description="Acts as you."
      error={error}
      submitLabel="Create token"
      submitDisabled={!label.trim() || !expiry}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit({ label, role, expiry })}
      onOpenChange={onOpenChange}
    >
      <Field htmlFor="personal-token-label" label="Label">
        <Input id="personal-token-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Local development" autoFocus />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor="personal-token-role" label="Role" hint={adminSelectable ? 'Caps what the token may do.' : 'Matches your workspace role.'}>
          <RoleSelect id="personal-token-role" value={role} onChange={setRole} adminSelectable={adminSelectable} />
        </Field>
        <Field htmlFor="personal-token-expiry" label="Expires" hint={CREDENTIAL_EXPIRY_HINT}>
          <Input id="personal-token-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        </Field>
      </div>
    </CreateDialogShell>
  )
}

export function CreateServiceAccountDialog({
  adminSelectable,
  error,
  isSubmitting,
  onSubmit,
  onOpenChange,
}: {
  adminSelectable: boolean
  error: string | null
  isSubmitting: boolean
  onSubmit: (draft: ServiceAccountDraft) => void
  onOpenChange: (open: boolean) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<CredentialRole>('member')
  const [expiry, setExpiry] = useState(() => defaultExpiryDate(365))

  return (
    <CreateDialogShell
      title="New service account"
      description="One identity per integration, revocable on its own."
      error={error}
      submitLabel="Create service account"
      submitDisabled={!displayName.trim() || !expiry}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit({ displayName, role, expiry })}
      onOpenChange={onOpenChange}
    >
      <Field htmlFor="service-account-name" label="Name">
        <Input id="service-account-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nightly ingestion" autoFocus />
      </Field>
      <Field htmlFor="service-account-role" label="Role" hint="Caps what every credential on this account may do.">
        <RoleSelect id="service-account-role" value={role} onChange={setRole} adminSelectable={adminSelectable} />
      </Field>
      <Field htmlFor="new-service-credential-expiry" label="Primary credential expires" hint={CREDENTIAL_EXPIRY_HINT}>
        <Input id="new-service-credential-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
      </Field>
    </CreateDialogShell>
  )
}
