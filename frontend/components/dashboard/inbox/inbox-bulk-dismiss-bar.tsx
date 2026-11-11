'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CloseReviewPopover } from '@/components/dashboard/quality/close-review-popover'
import { bulkDismissRowMessage } from '@/lib/needs-attention-bulk-dismiss'
import type { BulkDismissController } from './use-bulk-dismiss'

/**
 * The queue's bulk-dismiss controls: the selection, the one Dismiss action, and every row the last
 * dismissal left behind with its own reason. Renders nothing until rows are selected or left behind.
 */
export function InboxBulkDismissBar({ bulk }: { bulk: BulkDismissController }) {
  const [reasonAnchor, setReasonAnchor] = useState<HTMLElement | null>(null)
  if (bulk.selectedCount === 0 && bulk.leftBehind.length === 0) {
    return null
  }

  return (
    <div
      role="region"
      aria-label="Bulk dismiss"
      className="sticky top-0 z-10 -mx-3 -mt-3 mb-3 space-y-2 border-b border-border bg-background px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{bulk.selectedCount} selected</span>
        {bulk.selectedCount > 0 && bulk.selectedCount < bulk.selectableCount ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={bulk.running} onClick={bulk.selectAll}>
            Select all {bulk.selectableCount}
          </Button>
        ) : null}
        <span className="flex-1" />
        {bulk.selectedCount > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={bulk.running}
            onClick={(event) => setReasonAnchor(event.currentTarget)}
          >
            {bulk.running ? 'Dismissing…' : 'Dismiss'}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={bulk.running} onClick={bulk.clear}>
          Clear
        </Button>
      </div>

      {bulk.leftBehind.length > 0 ? (
        <div role="status" className="space-y-1 text-xs text-destructive">
          <p className="font-medium">Not dismissed</p>
          <ul className="space-y-0.5">
            {bulk.leftBehind.map(({ item, result }) => result.kind === 'dismissed' ? null : (
              <li key={item.key} className="flex gap-1.5">
                <span className="min-w-0 truncate font-medium">{item.title}</span>
                <span aria-hidden>—</span>
                <span className="shrink-0">{bulkDismissRowMessage(result)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <CloseReviewPopover
        open={reasonAnchor !== null}
        anchor={reasonAnchor}
        state="dismissed"
        count={bulk.selectedCount}
        submitting={bulk.running}
        onOpenChange={(open) => {
          if (!open) setReasonAnchor(null)
        }}
        onSubmit={(input) => {
          setReasonAnchor(null)
          void bulk.dismiss(input.resolution)
        }}
      />
    </div>
  )
}
