'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight, MoreHorizontal, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatCount } from '@/lib/audience-pulse-figures'
import type { ContentQueue, ContentQueueItem } from '@/lib/audience-pulse-queue'
import { cn } from '@/lib/utils'

import { NO_ANSWER_FILL } from './answer-split-bar'

const ROW_LIMIT = 5

function QueueRow({
  item,
  rank,
  largestNoAnswerCount,
  canDismiss,
  draftControl,
  onDismiss,
  onRevealTopic,
}: {
  item: ContentQueueItem
  rank: number
  largestNoAnswerCount: number
  canDismiss: boolean
  draftControl: ReactNode
  onDismiss: (item: ContentQueueItem) => void
  onRevealTopic: (topicId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const barWidth = largestNoAnswerCount > 0 ? Math.max(3, (item.noAnswerCount / largestNoAnswerCount) * 100) : 0
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-b border-border py-3"
      data-testid="audience-pulse-queue-row"
    >
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_8rem_auto_2rem] items-start gap-x-4">
        <span className="pt-0.5 text-sm tabular-nums text-muted-foreground">{rank}</span>
        <div className="min-w-0">
          <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md text-left text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
              aria-hidden
            />
            {item.title}
          </CollapsibleTrigger>
          <p className="mt-0.5 pl-5 text-sm text-muted-foreground">
            {formatCount(item.noAnswerCount)} with no answer · {formatCount(item.conversationCount)}{' '}
            {item.conversationCount === 1 ? 'conversation' : 'conversations'} · in{' '}
            <button
              type="button"
              onClick={() => onRevealTopic(item.topicId)}
              className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
            >
              {item.topicTitle}
            </button>
          </p>
        </div>
        <div className="pt-2">
          <div className={cn('h-1.5 rounded-full', NO_ANSWER_FILL)} style={{ width: `${barWidth}%` }} aria-hidden />
        </div>
        <div className="justify-self-end">{draftControl}</div>
        <div>
          {canDismiss && item.keepsState ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${item.title}`}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onDismiss(item)}>
                  <X aria-hidden />
                  Not for us
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <CollapsibleContent className="space-y-3 pl-[3.5rem] pr-12 pt-3">
        {item.rationale ? <p className="max-w-2xl text-sm text-foreground">{item.rationale}</p> : null}
        {item.questions.length > 0 ? (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Questions to cover</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
              {item.questions.map((question) => <li key={question}>{question}</li>)}
            </ul>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** "Content to write": topics whose questions your documents could not answer, the most first. */
export function ContentQueueSection({
  queue,
  totalNoAnswerCount,
  canDismiss,
  draftControlFor,
  onDismiss,
  onRestoreAll,
  onRevealTopic,
}: {
  queue: ContentQueue
  /** Questions with no answer in your content across the whole window; null for an older report. */
  totalNoAnswerCount: number | null
  canDismiss: boolean
  draftControlFor: (item: ContentQueueItem) => ReactNode
  onDismiss: (item: ContentQueueItem) => void
  onRestoreAll: () => void
  onRevealTopic: (topicId: string) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const { items, dismissedTopicIds } = queue
  const shown = showAll ? items : items.slice(0, ROW_LIMIT)
  const largestNoAnswerCount = items[0]?.noAnswerCount ?? 0
  const questions = totalNoAnswerCount === null
    ? formatCount(queue.noAnswerCount)
    : `${formatCount(queue.noAnswerCount)} of ${formatCount(totalNoAnswerCount)}`

  return (
    <section aria-labelledby="audience-pulse-content" className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-3">
        <h2 id="audience-pulse-content" className="text-base font-semibold text-foreground">Content to write</h2>
        {items.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? 'topic' : 'topics'} · {questions} questions with no answer in your content
          </span>
        ) : null}
      </div>
      {items.length === 0 && dismissedTopicIds.length === 0 ? (
        <p className="pt-2 text-sm text-muted-foreground">No content gaps in this period.</p>
      ) : null}
      {shown.map((item, index) => (
        <QueueRow
          key={item.topicId}
          item={item}
          rank={index + 1}
          largestNoAnswerCount={largestNoAnswerCount}
          canDismiss={canDismiss}
          draftControl={draftControlFor(item)}
          onDismiss={onDismiss}
          onRevealTopic={onRevealTopic}
        />
      ))}
      <div className="flex flex-wrap items-center gap-4 pt-2">
        {items.length > ROW_LIMIT ? (
          <Button type="button" variant="link" className="h-auto px-0 text-foreground" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${items.length}`}
          </Button>
        ) : null}
        {canDismiss && dismissedTopicIds.length > 0 ? (
          <Button type="button" variant="link" className="h-auto px-0 text-muted-foreground" onClick={onRestoreAll}>
            {dismissedTopicIds.length} not for us · Restore
          </Button>
        ) : null}
      </div>
    </section>
  )
}
