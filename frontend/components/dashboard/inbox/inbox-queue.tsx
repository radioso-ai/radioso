'use client'

import type { ReactNode } from 'react'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { InboxQueueRow, InboxRecentlyClosedRow } from './inbox-queue-row'
import {
  TAKEN_BY_ANYONE,
  TAKEN_BY_ME,
  TAKEN_BY_UNCLAIMED,
  type EscalationType,
  type InboxAgentOption,
  type InboxFilters,
  type InboxItem,
  type InboxOperatorOption,
  type RecentlyClosedInboxItem,
} from '@/lib/needs-attention'

const TYPE_OPTION_LABEL: Record<EscalationType, string> = {
  handoff: 'Handoffs',
  approval: 'Approvals',
  negative_feedback: 'Feedback',
}

export interface InboxQueueProps {
  /** The Needs-you / All lens toggle, rendered above the search row (spec 1116). It must always render, even with zero open items, so the All lens stays reachable. */
  lensToggle: ReactNode
  items: InboxItem[]
  /**
   * True only when the queue has no open items at all (before any filter is
   * applied) — distinct from filters narrowing a non-empty queue to zero rows.
   * There is nothing to search or filter in that state, so the search input
   * and the filter selects hide entirely rather than sitting there inert; the
   * confidence/empty-queue message that used to render in their place now
   * lives in the reading pane instead (see `InboxResponseView`'s
   * `emptyPlaceholder`), so the row area here is just empty (or, when
   * present, the recently-closed strip below it).
   */
  isQueueEmpty: boolean
  recentlyClosed: RecentlyClosedInboxItem[]
  typeCounts: Record<EscalationType | 'all', number>
  filters: InboxFilters
  onFiltersChange: (next: InboxFilters) => void
  agentOptions: InboxAgentOption[]
  operatorOptions: InboxOperatorOption[]
  now: Date
  selectedKey: string | null
  onSelect: (item: InboxItem) => void
}

export function InboxQueue({
  lensToggle,
  items,
  isQueueEmpty,
  recentlyClosed,
  typeCounts,
  filters,
  onFiltersChange,
  agentOptions,
  operatorOptions,
  now,
  selectedKey,
  onSelect,
}: InboxQueueProps) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-border md:w-[360px] md:border-r" aria-label="Inbox queue">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        {lensToggle}
        {isQueueEmpty ? null : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                value={filters.search}
                onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
                placeholder="Search inbox"
                aria-label="Search inbox"
                className="h-8 pl-8 text-sm"
              />
            </div>
            {/* min-w-0 on each trigger lets it actually shrink to its 1/3 share
                instead of overflowing the pane at its content width (flex
                items default to min-width:auto); the trigger's own line-clamp
                on the selected value then elides long labels within that
                shrunk width. */}
            <div className="flex gap-1.5">
              <Select
                value={filters.type}
                onValueChange={(value) => onFiltersChange({ ...filters, type: value as EscalationType | 'all' })}
              >
                <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Type: all ({typeCounts.all})</SelectItem>
                  <SelectItem value="handoff">{TYPE_OPTION_LABEL.handoff} ({typeCounts.handoff})</SelectItem>
                  <SelectItem value="approval">{TYPE_OPTION_LABEL.approval} ({typeCounts.approval})</SelectItem>
                  <SelectItem value="negative_feedback">{TYPE_OPTION_LABEL.negative_feedback} ({typeCounts.negative_feedback})</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={filters.agentId}
                onValueChange={(value) => onFiltersChange({ ...filters, agentId: value })}
              >
                <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Agent: all</SelectItem>
                  {agentOptions.map((agent) => (
                    <SelectItem key={agent.agentId} value={agent.agentId}>
                      {agent.agentInternalName?.trim() || agent.agentName?.trim() || 'Unnamed agent'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filters.takenBy}
                onValueChange={(value) => onFiltersChange({ ...filters, takenBy: value })}
              >
                <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by taken by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TAKEN_BY_ANYONE}>Taken by: anyone</SelectItem>
                  <SelectItem value={TAKEN_BY_UNCLAIMED}>Unclaimed</SelectItem>
                  <SelectItem value={TAKEN_BY_ME}>Me</SelectItem>
                  {operatorOptions.map((operator) => (
                    <SelectItem key={operator.accountId} value={operator.accountId}>
                      {operator.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isQueueEmpty ? null : (
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <InboxQueueRow
                key={item.key}
                item={item}
                now={now}
                selected={item.key === selectedKey}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}

        {recentlyClosed.length > 0 ? (
          <div className={isQueueEmpty ? undefined : 'mt-4'}>
            <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recently closed
            </p>
            <div className="flex flex-col gap-2">
              {recentlyClosed.map((item) => (
                <InboxRecentlyClosedRow key={item.key} item={item} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
