'use client'

import type { ReactNode } from 'react'
import { ChevronRight, Layers } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import type { BuiltInDefaultEntry, DirectiveRow } from '@/lib/directive-list-view-model'
import { cn } from '@/lib/utils'

const directiveRowDomId = (directiveId: string): string => `directive-${directiveId}`
const builtInRowDomId = (builtInName: string): string => `built-in-directive-${builtInName}`

// Hands the keyboard back to a row's open button. The row also holds a switch, so the button is
// found by what it is rather than by being the first one.
const focusRow = (domId: string): void => {
  document.getElementById(domId)?.querySelector<HTMLElement>('[data-directive-row-button]')?.focus()
}
export const focusDirectiveRow = (directiveId: string): void => focusRow(directiveRowDomId(directiveId))
export const focusBuiltInRow = (builtInName: string): void => focusRow(builtInRowDomId(builtInName))

// One line per directive: what it is called and when it applies. Everything else lives in the
// sheet the row opens, so a long list stays something to scan.
function whenLine(row: DirectiveRow): string {
  if (row.kind === 'customized') {
    if (row.title !== row.defaultTitle) {
      return row.directive.enabled ? `Always · replaces ${row.defaultTitle}` : `Off · ${row.defaultTitle} applies`
    }
    return `Always · using ${row.directive.enabled ? 'your version' : 'the Radioso default'}`
  }
  return row.directive.condition.kind === 'contextual' ? row.directive.condition.description : 'Always'
}

function DirectiveListItem({
  domId,
  title,
  when,
  lead,
  isDimmed = false,
  hasConflict = false,
  onOpen,
}: {
  domId: string
  title: string
  when: string
  lead: ReactNode
  isDimmed?: boolean
  hasConflict?: boolean
  onOpen: () => void
}) {
  const summaryId = `${domId}-summary`
  return (
    // The row is one button stretched over its whole area, with the switch lifted above it, so
    // the switch stays a control of its own instead of a button nested inside a button.
    <li
      id={domId}
      tabIndex={-1}
      className="relative flex items-center gap-3 px-3 py-2.5 outline-none hover:bg-muted/40"
    >
      <span className="relative z-10 flex w-9 shrink-0 items-center justify-center">{lead}</span>
      <button
        type="button"
        data-directive-row-button=""
        aria-label={title}
        aria-describedby={summaryId}
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 text-left outline-none',
          'after:absolute after:inset-0 after:content-[""] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring',
          isDimmed && 'text-muted-foreground',
        )}
      >
        <span className="w-44 shrink-0 truncate text-sm font-medium sm:w-56">{title}</span>
        <span id={summaryId} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={when}>{when}</span>
          {hasConflict ? (
            <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              Conflict
            </Badge>
          ) : null}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  )
}

export function DirectiveList({
  rows,
  onOpen,
  onToggleEnabled,
  isRowPending,
}: {
  rows: DirectiveRow[]
  onOpen: (directiveId: string) => void
  onToggleEnabled: (row: DirectiveRow, enabled: boolean) => void
  isRowPending: (directiveId: string) => boolean
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {rows.map((row) => {
        const isOff = row.kind === 'authored' && !row.directive.enabled
        return (
          <DirectiveListItem
            key={row.id}
            domId={directiveRowDomId(row.id)}
            title={row.title}
            when={whenLine(row)}
            isDimmed={isOff}
            hasConflict={row.conflicts.length > 0}
            onOpen={() => onOpen(row.id)}
            lead={row.kind === 'customized' ? (
              <Layers className="h-4 w-4 text-muted-foreground" aria-hidden />
            ) : (
              <Switch
                checked={row.directive.enabled}
                onCheckedChange={(enabled) => onToggleEnabled(row, enabled)}
                disabled={isRowPending(row.directive.id)}
                aria-label={`${row.directive.enabled ? 'Disable' : 'Enable'} ${row.directive.name}`}
              />
            )}
          />
        )
      })}
    </ul>
  )
}

export function BuiltInDefaultsGroup({
  defaults,
  isOpen,
  onOpenChange,
  onOpen,
}: {
  defaults: BuiltInDefaultEntry[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (builtInName: string) => void
}) {
  if (defaults.length === 0) return null
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange} className="space-y-2">
      <CollapsibleTrigger className="group flex items-center gap-2 rounded-md py-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        Radioso defaults · {defaults.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {defaults.map((entry) => (
            <DirectiveListItem
              key={entry.builtIn.name}
              domId={builtInRowDomId(entry.builtIn.name)}
              title={entry.title}
              // An unconditional replacer retires the default outright; the row says so rather
              // than reading "Always" for behaviour the agent no longer has.
              when={entry.replacedBy && entry.replacedBy.condition.kind === 'always'
                ? `Always · replaced by ${entry.replacedBy.name}`
                : 'Always'}
              lead={null}
              onOpen={() => onOpen(entry.builtIn.name)}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
