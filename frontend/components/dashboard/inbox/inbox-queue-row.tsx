'use client'

import { CheckCircle2, Hand, ShieldCheck, ThumbsDown, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatInboxRowTimestamp } from '@/lib/needs-attention-format'
import {
  formatInboxDuration,
  inboxWaitingPresentation,
  type EscalationType,
  type InboxItem,
  type RecentlyClosedInboxItem,
} from '@/lib/needs-attention'

const TYPE_CHIP_META: Record<EscalationType, { label: string; icon: LucideIcon; className: string }> = {
  handoff: { label: 'Handoff', icon: Hand, className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  approval: { label: 'Approval', icon: ShieldCheck, className: 'bg-primary/10 text-primary' },
  negative_feedback: { label: 'Feedback', icon: ThumbsDown, className: 'bg-destructive/10 text-destructive' },
}

function TypeChip({ type }: { type: EscalationType }) {
  const meta = TYPE_CHIP_META[type]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', meta.className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </span>
  )
}

const lastMessageLabel = (lastMessageAt: string | null | undefined, now: Date): string | null => {
  if (!lastMessageAt) {
    return null
  }
  const elapsedMs = Math.max(0, now.getTime() - new Date(lastMessageAt).getTime())
  return elapsedMs < 60_000 ? 'last message just now' : `last message ${formatInboxDuration(elapsedMs)} ago`
}

export function InboxQueueRow({
  item,
  now,
  selected,
  onSelect,
}: {
  item: InboxItem
  now: Date
  selected: boolean
  onSelect: (item: InboxItem) => void
}) {
  const { label: waitLabel, tone } = inboxWaitingPresentation(item, now)
  const lastMessage = lastMessageLabel(item.lastMessageAt, now)

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground',
      )}
    >
      <div className="flex items-center gap-2">
        <TypeChip type={item.type} />
        <span
          className={cn(
            'ml-auto shrink-0 text-xs',
            tone === 'amber' ? 'font-medium text-amber-700 dark:text-amber-300'
              : tone === 'destructive' ? 'font-medium text-destructive'
                : 'text-muted-foreground',
          )}
        >
          {waitLabel}
        </span>
      </div>
      <span className="truncate text-sm font-medium text-foreground">{item.title}</span>
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {lastMessage ? <span>{lastMessage}</span> : null}
        {item.takenByAccountId ? (
          <>
            {lastMessage ? <span aria-hidden>·</span> : null}
            <span>taken by {item.takenByDisplayName?.trim() || 'a teammate'}</span>
          </>
        ) : null}
      </span>
    </button>
  )
}

export function InboxRecentlyClosedRow({ item }: { item: RecentlyClosedInboxItem }) {
  // No attribution field exists on the triage record yet (see
  // QualityTriageRecord in the backend contract) — this stays resolution +
  // timestamp only rather than guessing who closed it.
  const stateLabel = item.state === 'resolved' ? 'Resolved' : 'Dismissed'
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/10 px-3 py-2 opacity-75">
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
      <div className="min-w-0">
        <span className="block truncate text-sm text-foreground">{item.title}</span>
        <span className="text-xs text-muted-foreground">
          {stateLabel} · {formatInboxRowTimestamp(item.closedAt)}
        </span>
      </div>
    </div>
  )
}
