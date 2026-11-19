'use client'

import { FileText, PenLine } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ContentQueueItem } from '@/lib/audience-pulse-queue'

import { formatDayMonth } from './pulse-dates'

/**
 * When a document drafted from the topic was added, else Draft for someone who may both write
 * documents and record the draft against the topic (workspace.documents.manage and
 * workspace.quality.manage).
 */
export function DraftControl({
  item,
  onDraft,
  canDraft,
}: {
  item: ContentQueueItem
  onDraft: (item: ContentQueueItem) => void
  canDraft: boolean
}) {
  if (item.latestDraft) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
        <FileText className="size-3.5" aria-hidden />
        Added {formatDayMonth(item.latestDraft.createdAt)}
      </span>
    )
  }
  if (!canDraft) return null
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => onDraft(item)}>
      <PenLine aria-hidden />
      Draft
    </Button>
  )
}
