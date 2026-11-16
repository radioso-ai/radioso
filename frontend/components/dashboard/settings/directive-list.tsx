'use client'

import { ChevronRight, Layers } from 'lucide-react'

import { QuietList, QuietListRow, focusQuietListRow } from '@/components/dashboard/settings/quiet-list'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import type { BuiltInDefaultEntry, DirectiveRow } from '@/lib/directive-list-view-model'

const directiveRowDomId = (directiveId: string): string => `directive-${directiveId}`
const builtInRowDomId = (builtInName: string): string => `built-in-directive-${builtInName}`

export const focusDirectiveRow = (directiveId: string): void => focusQuietListRow(directiveRowDomId(directiveId))
export const focusBuiltInRow = (builtInName: string): void => focusQuietListRow(builtInRowDomId(builtInName))

// The summary says when a directive applies; everything else lives in the sheet the row opens.
function whenLine(row: DirectiveRow): string {
  if (row.kind === 'customized') {
    if (row.title !== row.defaultTitle) {
      return row.directive.enabled ? `Always · replaces ${row.defaultTitle}` : `Off · ${row.defaultTitle} applies`
    }
    return `Always · using ${row.directive.enabled ? 'your version' : 'the Radioso default'}`
  }
  return row.directive.condition.kind === 'contextual' ? row.directive.condition.description : 'Always'
}

const conflictBadge = (
  <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
    Conflict
  </Badge>
)

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
    <QuietList>
      {rows.map((row) => {
        const isOff = row.kind === 'authored' && !row.directive.enabled
        return (
          <QuietListRow
            key={row.id}
            domId={directiveRowDomId(row.id)}
            title={row.title}
            summary={whenLine(row)}
            isDimmed={isOff}
            badge={row.conflicts.length > 0 ? conflictBadge : null}
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
    </QuietList>
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
        <QuietList>
          {defaults.map((entry) => (
            <QuietListRow
              key={entry.builtIn.name}
              domId={builtInRowDomId(entry.builtIn.name)}
              title={entry.title}
              // An unconditional replacer retires the default outright; the row says so rather
              // than reading "Always" for behaviour the agent no longer has.
              summary={entry.replacedBy && entry.replacedBy.condition.kind === 'always'
                ? `Always · replaced by ${entry.replacedBy.name}`
                : 'Always'}
              lead={null}
              onOpen={() => onOpen(entry.builtIn.name)}
            />
          ))}
        </QuietList>
      </CollapsibleContent>
    </Collapsible>
  )
}
