'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The second navigation column, shared across every area. Each row is a label +
 * icon that either links (href) or acts (onClick). The header band height is
 * fixed so the column header lines up with the rail logo and the content title.
 */

export type SubNavEntry = {
  id: string
  label: string
  icon: LucideIcon
  active?: boolean
  /** On/off status dot (omit for entries without a toggle). */
  status?: boolean
  danger?: boolean
  href?: string
  onClick?: () => void
}

export type SubNavGroup = { label?: string | null; items: SubNavEntry[] }

export const SUBNAV_HEADER = 'flex h-14 shrink-0 items-center'

export function SubNavHeading({ children }: { children: ReactNode }) {
  return <span className="truncate font-display text-lg font-semibold">{children}</span>
}

export function SubNavColumn({
  header,
  groups,
  footer,
}: {
  header: ReactNode
  groups: SubNavGroup[]
  footer?: ReactNode
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className={cn(SUBNAV_HEADER, 'relative border-b border-sidebar-border px-4')}>{header}</div>

      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className={cn(index > 0 && 'mt-3')}>
            {group.label ? (
              <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/50">
                {group.label}
              </p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((entry) => (
                <SubNavRow key={entry.id} entry={entry} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {footer ? <div className="border-t border-sidebar-border p-2">{footer}</div> : null}
    </aside>
  )
}

export function SubNavRow({ entry }: { entry: SubNavEntry }) {
  const className = cn(
    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
    entry.active
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : entry.danger
        ? 'text-destructive/80 hover:bg-destructive/10 hover:text-destructive'
        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  )
  const inner = (
    <>
      <entry.icon
        className={cn(
          'h-4 w-4 shrink-0',
          entry.active ? 'text-secondary' : entry.danger ? 'text-destructive/70' : 'text-sidebar-foreground/60',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
      {entry.status !== undefined ? (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', entry.status ? 'bg-emerald-500' : 'bg-sidebar-foreground/25')}
          title={entry.status ? 'On' : 'Off'}
        />
      ) : null}
    </>
  )

  if (entry.href) {
    return (
      <Link href={entry.href} className={className}>
        {inner}
      </Link>
    )
  }
  return (
    <button type="button" onClick={entry.onClick} className={className}>
      {inner}
    </button>
  )
}
