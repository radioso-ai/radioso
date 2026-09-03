'use client'

import { useState, type ReactNode } from 'react'
import { Info, MoreHorizontal, Pencil, RefreshCw, Trash2, type LucideIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import type { ApiCredentialMetadata } from '@/lib/api'
import { cn } from '@/lib/utils'

import {
  credentialRowMeta,
  credentialStatusBadge,
  expiringSoonLabel,
} from './api-access-row-meta'

const EXPIRY_BADGE_CLASSNAME = 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100'

export function RowList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">{children}</div>
}

export function EmptyRows({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{children}</p>
}

/** A row states its name and one line of meta; badges appear only for exceptional states. */
export function QuietRow({
  name,
  badges,
  meta,
  actions,
  muted = false,
}: {
  name: string
  badges?: ReactNode
  meta: string
  actions: ReactNode
  muted?: boolean
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 p-3', muted && 'opacity-70')}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          {badges}
        </div>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  )
}

export interface RowActionEntry {
  id: string
  label: string
  icon: LucideIcon
  destructive?: boolean
  onSelect: () => void
}

/**
 * One action stays an inline button; several collapse into a `⋯` menu, so a row never grows a
 * toolbar of competing verbs.
 */
export function RowActions({
  subject,
  entries,
  busy = false,
}: {
  subject: string
  entries: RowActionEntry[]
  busy?: boolean
}) {
  if (entries.length === 0) return null

  if (entries.length === 1) {
    const only = entries[0]
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        className={only.destructive ? 'text-muted-foreground hover:text-destructive' : undefined}
        aria-label={`${only.label} ${subject}`}
        onClick={only.onSelect}
      >
        {busy ? <Spinner className="mr-2 h-4 w-4" /> : <only.icon className="mr-2 h-3.5 w-3.5" />}
        {only.label}
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={busy} aria-label={`Actions for ${subject}`}>
          {busy ? <Spinner className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {entries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            variant={entry.destructive ? 'destructive' : 'default'}
            onSelect={entry.onSelect}
          >
            <entry.icon className="mr-2 h-4 w-4" />
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The credential row shared by personal tokens, the members' audit list, and service-account
 * credentials. An action appears only when the caller passes a handler for it, which is how the
 * permission difference between the three lists stays structural.
 */
export function CredentialRow({
  credential,
  ownerName,
  busy = false,
  onDetails,
  onRename,
  onRotate,
  onRevoke,
}: {
  credential: ApiCredentialMetadata
  ownerName?: string | null
  busy?: boolean
  onDetails?: () => void
  onRename?: () => void
  onRotate?: () => void
  onRevoke?: () => void
}) {
  const isActive = credential.status === 'active'
  const statusBadge = credentialStatusBadge(credential)
  const expiryBadge = expiringSoonLabel(credential)

  const entries: RowActionEntry[] = []
  if (onDetails) entries.push({ id: 'details', label: 'Details', icon: Info, onSelect: onDetails })
  if (onRename && isActive) entries.push({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: onRename })
  if (onRotate && isActive) entries.push({ id: 'rotate', label: 'Rotate', icon: RefreshCw, onSelect: onRotate })
  if (onRevoke && isActive) entries.push({ id: 'revoke', label: 'Revoke', icon: Trash2, destructive: true, onSelect: onRevoke })

  return (
    <QuietRow
      name={credential.label}
      muted={!isActive}
      badges={(
        <>
          {statusBadge ? <Badge variant="secondary">{statusBadge}</Badge> : null}
          {expiryBadge ? <Badge variant="outline" className={EXPIRY_BADGE_CLASSNAME}>{expiryBadge}</Badge> : null}
        </>
      )}
      meta={credentialRowMeta(credential, { ownerName })}
      actions={<RowActions subject={credential.label} entries={entries} busy={busy} />}
    />
  )
}

/** Rename keeps the vocabulary of the thing being renamed: service accounts have a Name, credentials a Label. */
export function RenameDialog({
  kind,
  fieldLabel,
  initialValue,
  isSaving = false,
  error,
  onSave,
  onOpenChange,
}: {
  kind: string
  fieldLabel: 'Name' | 'Label'
  initialValue: string
  isSaving?: boolean
  error?: string | null
  onSave: (value: string) => void
  onOpenChange: (open: boolean) => void
}) {
  const [value, setValue] = useState(initialValue)
  const trimmed = value.trim()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename {kind}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!trimmed || isSaving) return
            onSave(trimmed)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rename-value">{fieldLabel}</Label>
            <Input id="rename-value" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!trimmed || isSaving}>
              {isSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PaginationControls({
  page,
  total,
  pageSize = 50,
  onPage,
}: {
  page: number
  total: number
  pageSize?: number
  onPage: (page: number) => void
}) {
  if (total <= pageSize) return null
  const pageCount = Math.ceil(total / pageSize)
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <span className="text-muted-foreground">Page {page} of {pageCount}</span>
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  )
}
