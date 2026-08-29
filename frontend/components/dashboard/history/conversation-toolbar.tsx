'use client'

import { useMemo } from 'react'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { ChatConversationSummary } from '@/lib/api'
import type { ConversationFilterState, OutcomeFilter } from '@/lib/conversation-filters'

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

/** Distinct agents among the currently loaded conversations, in first-seen order. */
const buildAgentOptions = (conversations: ChatConversationSummary[]) => {
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

/** Distinct non-null site origins among the currently loaded conversations, in first-seen order. */
const buildSiteOptions = (conversations: ChatConversationSummary[]) => {
  const seen = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.sourceOrigin) {
      seen.add(conversation.sourceOrigin)
    }
  }
  return [...seen]
}

/**
 * Gmail-style toolbar above the Conversations table (spec 1116). Filtering is
 * entirely client-side over whatever page of conversations is currently
 * loaded — see `filterConversations` in `@/lib/conversation-filters` for why.
 */
export function ConversationToolbar({
  conversations,
  filters,
  onFiltersChange,
}: {
  conversations: ChatConversationSummary[]
  filters: ConversationFilterState
  onFiltersChange: (filters: ConversationFilterState) => void
}) {
  const agentOptions = useMemo(() => buildAgentOptions(conversations), [conversations])
  const siteOptions = useMemo(() => buildSiteOptions(conversations), [conversations])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
          placeholder="Search conversations"
          className="h-9 pl-10"
        />
      </div>
      <Select
        value={filters.outcome}
        onValueChange={(value) => onFiltersChange({ ...filters, outcome: value as OutcomeFilter })}
      >
        <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by outcome">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OUTCOME_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.agentId ?? ALL_AGENTS}
        onValueChange={(value) => onFiltersChange({ ...filters, agentId: value === ALL_AGENTS ? null : value })}
      >
        <SelectTrigger className="h-9 w-[170px]" aria-label="Filter by agent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_AGENTS}>Agent: all</SelectItem>
          {agentOptions.map((option) => (
            <SelectItem key={option.agentId} value={option.agentId}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.siteOrigin ?? ALL_SITES}
        onValueChange={(value) => onFiltersChange({ ...filters, siteOrigin: value === ALL_SITES ? null : value })}
      >
        <SelectTrigger className="h-9 w-[180px]" aria-label="Filter by site">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SITES}>Site: all</SelectItem>
          {siteOptions.map((origin) => (
            <SelectItem key={origin} value={origin}>
              {siteLabel(origin)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
