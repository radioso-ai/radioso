'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

type SettingsRowStatus = {
  label: string
  tone: 'active' | 'warning'
}

/**
 * A scannable list of settings entries: each row is one configurable thing,
 * surfaced as label + one-line description + optional status, with one action
 * on the right that takes the operator to it. Mirrors the findable "pick the
 * thing, then configure it" pattern used by channel-style settings, in contrast
 * to a stack of always-expanded cards.
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
  action,
  testId,
}: {
  icon: ReactNode
  title: string
  description: string
  status?: SettingsRowStatus
  action: ReactNode
  testId?: string
}) {
  return (
    <div data-testid={testId} className="flex w-full items-center gap-3 px-5 py-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-foreground">{title}</h3>
          {status ? <SettingsRowStatusBadge status={status} /> : null}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

function SettingsRowStatusBadge({ status }: { status: SettingsRowStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        status.tone === 'active'
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', status.tone === 'active' ? 'bg-emerald-500' : 'bg-amber-500')} />
      {status.label}
    </span>
  )
}
