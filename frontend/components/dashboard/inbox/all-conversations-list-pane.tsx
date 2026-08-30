'use client'

import type { ReactNode } from 'react'
import { CheckCircle2, Hand, Search } from 'lucide-react'

import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { ChatConversationSummary, ContactHistorySummary, DocumentSearchHistoryEntry } from '@/lib/api'
import { useCopilotEntity } from '@/lib/copilot-context'
import { resolveConversationDisplayTitle } from '@/lib/conversation-title'
import { deriveConversationOutcome, type ConversationOutcome } from '@/lib/conversation-outcome'
import { matchesConversationSearchText, type ConversationFilterState, type OutcomeFilter } from '@/lib/conversation-filters'
import { formatConversationLocation } from '@/lib/history-source'
import { stripTrackingParams } from '@/lib/inbox-response'
import { cn } from '@/lib/utils'
import type { HistoryListItem, SelectedHistoryItem } from '@/components/dashboard/history/history-list'

const rowTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// Radix Select can't hold an empty-string value for an "all" option.
const ALL_AGENTS = '__all_agents__'
const ALL_SITES = '__all_sites__'

const OUTCOME_OPTIONS: Array<{ value: OutcomeFilter; label: string }> = [
  { value: 'all', label: 'Outcome: all' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'handed_off', label: 'Handed off' },
]

const siteLabel = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function OutcomeChip({ outcome }: { outcome: ConversationOutcome }) {
  if (outcome.kind === 'handed_off') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
        <Hand className="h-3 w-3" aria-hidden />
        Handed off
      </span>
    )
  }
  if (outcome.kind === 'in_progress') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs font-medium text-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        In progress
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 className="h-3 w-3" aria-hidden />
      Completed
    </span>
  )
}

function RowShell({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground',
      )}
    >
      {children}
    </button>
  )
}

function ConversationRow({
  conversation,
  now,
  selected,
  onSelect,
}: {
  conversation: ChatConversationSummary
  now: Date
  selected: boolean
  onSelect: () => void
}) {
  const outcome = deriveConversationOutcome(conversation, now)
  const title = resolveConversationDisplayTitle(conversation)
  // Ambient page context for Ray (spec 087): the same registration the old
  // history table's ConversationRow made, so asking Ray about the page still
  // resolves this row's conversation and agent. Uses the same title the row
  // displays, so Ray's ambient label never disagrees with what's on screen.
  useCopilotEntity('conversation', conversation.id, title)
  useCopilotEntity(
    'agent',
    conversation.agentId,
    getAgentOperatorLabel({ internalName: conversation.agentInternalName, name: conversation.agentName }, 'Unknown agent'),
  )
  const visitorLabel = conversation.anonymousSessionId === null ? 'Verified' : 'Anonymous'
  const location = formatConversationLocation(conversation)
  const isSlack = conversation.channelContext?.provider === 'slack'
  const trimmedEntryPageUrl = conversation.entryPageUrl?.trim() || null
  // Mirrors ConversationMetaLine's text (history-list.tsx): the stripped
  // entry URL replaces the plain source description whenever one is
  // available. Unlike that table cell, this row is itself one big button
  // (the row-select control), so the entry URL renders as plain text here
  // rather than a nested <a> — an anchor inside a button is invalid HTML and
  // breaks keyboard/screen-reader activation. The response view's header
  // renders the same URL as a real, independently clickable link once the
  // row is selected.
  const locationText = !isSlack && trimmedEntryPageUrl
    ? stripTrackingParams(trimmedEntryPageUrl).replace(/^https?:\/\//, '')
    : location.text

  return (
    <RowShell selected={selected} onSelect={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{rowTimestampFormatter.format(new Date(conversation.updatedAt))}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground">
          <span className="shrink-0">{visitorLabel}</span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate" title={trimmedEntryPageUrl ?? location.title ?? undefined}>{locationText}</span>
        </span>
        <OutcomeChip outcome={outcome} />
      </div>
    </RowShell>
  )
}

function SearchEntryRow({
  search,
  selected,
  onSelect,
}: {
  search: DocumentSearchHistoryEntry
  selected: boolean
  onSelect: () => void
}) {
  const resultLabel = search.resultCount === 1 ? '1 result' : `${search.resultCount} results`
  return (
    <RowShell selected={selected} onSelect={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{search.query}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{rowTimestampFormatter.format(new Date(search.createdAt))}</span>
      </div>
      <span className="truncate text-xs text-muted-foreground">
        Document search · {resultLabel}
        {search.previewTopTitles.length > 0 ? ` · ${search.previewTopTitles[0]}` : ''}
      </span>
    </RowShell>
  )
}

function ContactEntryRow({
  contact,
  selected,
  onSelect,
}: {
  contact: ContactHistorySummary
  selected: boolean
  onSelect: () => void
}) {
  const location = formatConversationLocation(contact)
  return (
    <RowShell selected={selected} onSelect={onSelect}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {contact.messagePreview || 'Contact request'}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{rowTimestampFormatter.format(new Date(contact.sortAt))}</span>
      </div>
      <span className="truncate text-xs text-muted-foreground">
        {location.text} · {contact.userEmail} · {contact.status}
      </span>
    </RowShell>
  )
}

/**
 * Distinct agents among the currently loaded chat entries, in first-seen
 * order. Exported so the caller can build options from the unfiltered page
 * (see `AllConversationsListPaneProps.agentOptions`) — computing them from a
 * filtered view would drop agents/sites the operator isn't currently
 * looking at, including the one behind an active filter selection.
 */
export const buildAgentOptions = (conversations: ChatConversationSummary[]) => {
  const seen = new Map<string, string>()
  for (const conversation of conversations) {
    if (conversation.agentId && !seen.has(conversation.agentId)) {
      seen.set(
        conversation.agentId,
        getAgentOperatorLabel(
          { internalName: conversation.agentInternalName, name: conversation.agentName },
          'Unknown agent',
        ),
      )
    }
  }
  return [...seen.entries()].map(([agentId, label]) => ({ agentId, label }))
}

/** Distinct non-null site origins among the currently loaded chat entries, in first-seen order. See `buildAgentOptions` for why this is exported. */
export const buildSiteOptions = (conversations: ChatConversationSummary[]) => {
  const seen = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.sourceOrigin) {
      seen.add(conversation.sourceOrigin)
    }
  }
  return [...seen]
}

/**
 * Applies the toolbar's search/outcome/agent/site filters to a mixed-kind
 * history page. Outcome and agent and site only mean something for chat
 * entries — a search or contact row simply has none of those facets — so
 * a non-'all' outcome/agent/site filter narrows the list to chat rows only,
 * while free-text search matches every kind against its own title-ish text.
 */
export const filterAllLensItems = (
  items: readonly HistoryListItem[],
  filters: ConversationFilterState,
  now: Date,
): HistoryListItem[] => items.filter((entry) => {
  if (entry.kind !== 'chat') {
    if (filters.outcome !== 'all' || filters.agentId !== null || filters.siteOrigin !== null) {
      return false
    }
    const text = entry.kind === 'search' ? entry.search.query : entry.contact.messagePreview ?? ''
    return matchesConversationSearchText(text, filters.search)
  }

  const search = filters.search.trim().toLowerCase()
  if (search && !resolveConversationDisplayTitle(entry.conversation).toLowerCase().includes(search)) {
    return false
  }
  if (filters.outcome !== 'all' && deriveConversationOutcome(entry.conversation, now).kind !== filters.outcome) {
    return false
  }
  if (filters.agentId !== null && entry.conversation.agentId !== filters.agentId) {
    return false
  }
  if (filters.siteOrigin !== null && entry.conversation.sourceOrigin !== filters.siteOrigin) {
    return false
  }
  return true
})

export interface AllConversationsListPaneProps {
  lensToggle: ReactNode
  items: HistoryListItem[]
  /**
   * Built by the caller from the unfiltered loaded page (see
   * `buildAgentOptions`/`buildSiteOptions`), not from `items` above — `items`
   * is already filter-narrowed, and deriving options from it would make
   * agents/sites disappear from the dropdowns (including the one behind an
   * active filter) as soon as any filter or search narrows the rows.
   */
  agentOptions: ReturnType<typeof buildAgentOptions>
  siteOptions: ReturnType<typeof buildSiteOptions>
  filters: ConversationFilterState
  onFiltersChange: (next: ConversationFilterState) => void
  now: Date
  selectedItem: SelectedHistoryItem
  onSelect: (item: SelectedHistoryItem) => void
  pagination: {
    summary: string
    currentPage: number
    totalPages: number
    previousHref: string
    nextHref: string
    onPrevious: () => void
    onNext: () => void
  }
}

/** The All lens's left pane: lens toggle, search + outcome/agent/site toolbar, rows, pagination. */
export function AllConversationsListPane({
  lensToggle,
  items,
  agentOptions,
  siteOptions,
  filters,
  onFiltersChange,
  now,
  selectedItem,
  onSelect,
  pagination,
}: AllConversationsListPaneProps) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-border md:w-[360px] md:border-r" aria-label="Conversations">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        {lensToggle}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex gap-1.5">
          <Select
            value={filters.outcome}
            onValueChange={(value) => onFiltersChange({ ...filters, outcome: value as OutcomeFilter })}
          >
            <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTCOME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.agentId ?? ALL_AGENTS}
            onValueChange={(value) => onFiltersChange({ ...filters, agentId: value === ALL_AGENTS ? null : value })}
          >
            <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_AGENTS}>Agent: all</SelectItem>
              {agentOptions.map((option) => (
                <SelectItem key={option.agentId} value={option.agentId}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.siteOrigin ?? ALL_SITES}
            onValueChange={(value) => onFiltersChange({ ...filters, siteOrigin: value === ALL_SITES ? null : value })}
          >
            <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 text-xs" aria-label="Filter by site">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SITES}>Site: all</SelectItem>
              {siteOptions.map((origin) => (
                <SelectItem key={origin} value={origin}>{siteLabel(origin)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">No conversations match your filters.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((entry) => {
              const key = `${entry.kind}:${entry.id}`
              const selected = selectedItem?.kind === entry.kind && selectedItem.id === entry.id
              if (entry.kind === 'chat') {
                return (
                  <ConversationRow
                    key={key}
                    conversation={entry.conversation}
                    now={now}
                    selected={selected}
                    onSelect={() => onSelect({ kind: 'chat', id: entry.id })}
                  />
                )
              }
              if (entry.kind === 'search') {
                return (
                  <SearchEntryRow
                    key={key}
                    search={entry.search}
                    selected={selected}
                    onSelect={() => onSelect({ kind: 'search', id: entry.id })}
                  />
                )
              }
              return (
                <ContactEntryRow
                  key={key}
                  contact={entry.contact}
                  selected={selected}
                  onSelect={() => onSelect({ kind: 'contact', id: entry.id })}
                />
              )
            })}
          </div>
        )}
        <div className="mt-3">
          <DashboardPagination
            summary={pagination.summary}
            currentPage={pagination.currentPage}
            totalPages={pagination.totalPages}
            previousHref={pagination.previousHref}
            nextHref={pagination.nextHref}
            onPrevious={pagination.onPrevious}
            onNext={pagination.onNext}
          />
        </div>
      </div>
    </aside>
  )
}
