'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The active section's sub-navigation, rendered nested inside the sidebar rail
 * (no longer a separate column). Each row is a label + icon that either links
 * (href) or acts (onClick). A section can supply an optional header and footer,
 * and groups can be made collapsible (e.g. one-time-setup Channels).
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

export type SubNavGroup = {
  label?: string | null
  items: SubNavEntry[]
  /** Render the group label as a collapse toggle. */
  collapsible?: boolean
  /** Initial open state for a collapsible group (ignored when an item is active). */
  defaultOpen?: boolean
}

export function SectionNavBody({
  header,
  groups,
  footer,
}: {
  header?: ReactNode
  groups: SubNavGroup[]
  footer?: ReactNode
}) {
  return (
    <div className="ml-3.5 mt-0.5 space-y-1 border-l border-sidebar-border pl-2">
      {header ? <div className="relative px-1 pb-1">{header}</div> : null}

      {groups.map((group, index) => (
        <SubNavGroupBlock key={group.label ?? `group-${index}`} group={group} isFirst={index === 0} />
      ))}

      {footer ? <div className="pt-2">{footer}</div> : null}
    </div>
  )
}

function SubNavGroupBlock({ group, isFirst }: { group: SubNavGroup; isFirst: boolean }) {
  const hasActiveItem = group.items.some((item) => item.active)
  // A collapsed group still reveals itself when it owns the active route.
  const [open, setOpen] = useState(group.defaultOpen ?? true)
  const expanded = group.collapsible ? open || hasActiveItem : true

  const items = (
    <div className="space-y-0.5">
      {group.items.map((entry) => (
        <SubNavRow key={entry.id} entry={entry} />
      ))}
    </div>
  )

  if (group.collapsible && group.label) {
    return (
      <div className={cn(!isFirst && 'pt-2')}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-sidebar-foreground/45 transition-colors hover:text-sidebar-foreground/70"
        >
          <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !expanded && '-rotate-90')} />
          <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        </button>
        {expanded ? items : null}
      </div>
    )
  }

  return (
    <div className={cn(!isFirst && 'pt-2')}>
      {group.label ? (
        <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-sidebar-foreground/45">
          {group.label}
        </p>
      ) : null}
      {items}
    </div>
  )
}

export function SubNavRow({ entry }: { entry: SubNavEntry }) {
  const className = cn(
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
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
