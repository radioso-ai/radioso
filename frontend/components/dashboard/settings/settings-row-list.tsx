'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

export type SettingsRowStatus = {
  label: string
  tone?: 'active' | 'muted'
}

/**
 * A scannable list of settings entries: each row is one configurable thing,
 * surfaced as label + one-line description + optional status, and drills in on
 * click. Mirrors the findable "pick the thing, then configure it" pattern used
 * by channel-style settings, in contrast to a stack of always-expanded cards.
 */
export function SettingsRowList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/95 shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function SettingsRow({
  icon,
  title,
  description,
  status,
  onClick,
  disabled,
}: {
  icon: ReactNode
  title: string
  description: string
  status?: SettingsRowStatus
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex w-full items-center gap-3 px-5 py-4 text-left transition-colors',
        'hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-foreground">{title}</h3>
          {status ? <SettingsRowStatusBadge status={status} /> : null}
        </div>
        <p className="truncate text-sm text-muted-foreground">{description}</p>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

function SettingsRowStatusBadge({ status }: { status: SettingsRowStatus }) {
  if (status.tone === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {status.label}
      </span>
    )
  }

  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {status.label}
    </span>
  )
}
