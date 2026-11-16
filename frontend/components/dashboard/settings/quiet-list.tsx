'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

// A list of authored things an operator scans: one line each, its name and a short summary.
// Everything else lives behind the row, in a sheet or a page, so a long list stays readable.
export function QuietList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">{children}</ul>
}

// Hands the keyboard back to a row's open button. The row may also hold a switch, so the button
// is found by what it is rather than by being the first one.
export const focusQuietListRow = (domId: string): void => {
  document.getElementById(domId)?.querySelector<HTMLElement>('[data-quiet-list-row-button]')?.focus()
}

export function QuietListRow({
  domId,
  title,
  summary,
  lead,
  badge,
  isDimmed = false,
  onOpen,
}: {
  domId: string
  title: string
  summary: string
  lead: ReactNode
  badge?: ReactNode
  isDimmed?: boolean
  onOpen: () => void
}) {
  const summaryId = `${domId}-summary`
  return (
    // The row is one button stretched over its whole area, with the lead lifted above it, so a
    // switch there stays a control of its own instead of a button nested inside a button.
    <li
      id={domId}
      tabIndex={-1}
      className="relative flex items-center gap-3 px-3 py-2.5 outline-none hover:bg-muted/40"
    >
      <span className="relative z-10 flex w-9 shrink-0 items-center justify-center">{lead}</span>
      <button
        type="button"
        data-quiet-list-row-button=""
        aria-label={title}
        aria-describedby={summaryId}
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 text-left outline-none',
          'after:absolute after:inset-0 after:content-[""] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring',
          isDimmed && 'text-muted-foreground',
        )}
      >
        <span className="w-44 shrink-0 truncate text-sm font-medium sm:w-56" title={title}>{title}</span>
        <span id={summaryId} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={summary}>{summary}</span>
          {badge}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  )
}
