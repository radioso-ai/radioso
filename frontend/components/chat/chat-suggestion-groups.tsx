'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ChatSuggestion, ChatSuggestionKind } from '@/lib/api'

const SUGGESTION_GROUP_ORDER: readonly ChatSuggestionKind[] = ['deeper', 'broader']

const DEFAULT_SUGGESTION_GROUP_LABELS: Record<ChatSuggestionKind, string> = {
  deeper: 'Deeper',
  broader: 'Broader',
}

export interface ChatSuggestionGroup {
  kind: ChatSuggestionKind
  suggestions: ChatSuggestion[]
}

export const groupChatSuggestions = (
  suggestions: ChatSuggestion[] | undefined,
): ChatSuggestionGroup[] => {
  if (!suggestions || suggestions.length === 0) {
    return []
  }

  const groupedSuggestions = new Map<ChatSuggestionKind, ChatSuggestion[]>()

  for (const suggestion of suggestions) {
    if (!suggestion.text.trim()) {
      continue
    }

    const kind: ChatSuggestionKind = suggestion.kind === 'broader' ? 'broader' : 'deeper'
    const nextSuggestions = groupedSuggestions.get(kind) ?? []
    nextSuggestions.push(suggestion)
    groupedSuggestions.set(kind, nextSuggestions)
  }

  return SUGGESTION_GROUP_ORDER.flatMap((kind) => {
    const items = groupedSuggestions.get(kind)
    if (!items || items.length === 0) {
      return []
    }

    return [{ kind, suggestions: items }]
  })
}

export function ChatSuggestionGroups({
  messageId,
  suggestions,
  groupLabels,
  onSuggestionSelect,
}: {
  messageId: string
  suggestions?: ChatSuggestion[]
  groupLabels?: Partial<Record<ChatSuggestionKind, string>>
  onSuggestionSelect?: (text: string, messageId: string) => void
}) {
  const suggestionGroups = groupChatSuggestions(suggestions)
  const resolvedGroupLabels = {
    ...DEFAULT_SUGGESTION_GROUP_LABELS,
    ...groupLabels,
  }

  if (suggestionGroups.length === 0) {
    return null
  }

  return (
    <div className="space-y-3 px-1">
      {suggestionGroups.map((group) => (
        <section key={`${messageId}-${group.kind}`} data-suggestion-group={group.kind} className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-primary/20 bg-primary/5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {resolvedGroupLabels[group.kind]}
            </Badge>
          </div>
          <div className="flex max-w-full flex-wrap gap-2">
            {group.suggestions.map((suggestion, suggestionIndex) =>
              onSuggestionSelect ? (
                <Button
                  key={`${messageId}-${group.kind}-suggestion-${suggestionIndex}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal px-3 py-2 text-left"
                  onClick={(event) => {
                    event.stopPropagation()
                    onSuggestionSelect(suggestion.text, messageId)
                  }}
                >
                  {suggestion.text}
                </Button>
              ) : (
                <div
                  key={`${messageId}-${group.kind}-suggestion-${suggestionIndex}`}
                  className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
                >
                  {suggestion.text}
                </div>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
