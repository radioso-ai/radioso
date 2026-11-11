'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import { qualityApi } from '@/lib/api-quality'
import type { InboxItem } from '@/lib/needs-attention'
import {
  bulkDismissableItems,
  runBulkDismiss,
  summarizeBulkDismiss,
  type BulkDismissItem,
  type BulkDismissResult,
  type BulkDismissRowResult,
} from '@/lib/needs-attention-bulk-dismiss'
import type { CloseReviewInput } from '@/components/dashboard/quality/close-review-popover'

/** What the queue shows for the selection: its size, and the rows the last dismissal left. */
export interface BulkDismissController {
  isSelectable: (item: InboxItem) => boolean
  isSelected: (item: InboxItem) => boolean
  toggle: (item: InboxItem) => void
  selectedCount: number
  selectableCount: number
  selectAll: () => void
  clear: () => void
  dismiss: (resolution: CloseReviewInput['resolution']) => Promise<void>
  running: boolean
  /** The rows the last run did not dismiss, each with its own outcome; empty after a clean run. */
  leftBehind: BulkDismissRowResult[]
}

/**
 * Selection and one-action dismissal of the queue's visible feedback rows. A dismissal is the
 * single-row triage write, once per row, so each leaves the same record; `onResult` applies the
 * outcome to the queue as each row settles. Rows hidden by a filter are never dismissed unseen.
 */
export function useBulkDismiss({
  items,
  onResult,
  onAnnounce,
}: {
  /** The rows the operator can see; the selection is read against these. */
  items: readonly InboxItem[]
  onResult: (item: BulkDismissItem, result: BulkDismissResult) => void
  onAnnounce: (message: string) => void
}): BulkDismissController {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState(false)
  const [leftBehind, setLeftBehind] = useState<BulkDismissRowResult[]>([])
  const runningRef = useRef(false)

  const selectable = useMemo(() => bulkDismissableItems(items), [items])
  const selected = useMemo(
    () => selectable.filter((item) => selectedIds.has(item.assistantMessageId)),
    [selectable, selectedIds],
  )

  const selectableKeys = useMemo(() => new Set(selectable.map((item) => item.key)), [selectable])
  const isSelectable = useCallback((item: InboxItem) => selectableKeys.has(item.key), [selectableKeys])
  const isSelected = useCallback(
    (item: InboxItem) => item.assistantMessageId !== undefined && selectedIds.has(item.assistantMessageId),
    [selectedIds],
  )

  const toggle = useCallback((item: InboxItem) => {
    const id = item.assistantMessageId
    if (!id || runningRef.current) return
    setLeftBehind([])
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (runningRef.current) return
    setLeftBehind([])
    setSelectedIds(new Set(selectable.map((item) => item.assistantMessageId)))
  }, [selectable])

  const clear = useCallback(() => {
    if (runningRef.current) return
    setLeftBehind([])
    setSelectedIds(new Set())
  }, [])

  const dismiss = useCallback(async (resolution: CloseReviewInput['resolution']) => {
    if (runningRef.current || selected.length === 0) return
    runningRef.current = true
    setRunning(true)
    setLeftBehind([])
    try {
      const rows = await runBulkDismiss({
        items: selected,
        dismiss: (item) => qualityApi.setTriageState(item.assistantMessageId, {
          state: 'dismissed',
          expectedVersion: item.triage?.version ?? 0,
          ...(resolution ? { resolution } : {}),
        }),
        onSettled: (row) => onResult(row.item, row.result),
      })
      const summary = summarizeBulkDismiss(rows)
      // Only rows still in the queue stay selected, so the same action retries them.
      const stillHere = new Set(
        summary.needsAttention
          .filter((row) => row.result.kind === 'failed' || row.result.kind === 'changed')
          .map((row) => row.item.assistantMessageId),
      )
      setSelectedIds(stillHere)
      setLeftBehind(summary.needsAttention)
      onAnnounce(summary.announcement)
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [onAnnounce, onResult, selected])

  return {
    isSelectable,
    isSelected,
    toggle,
    selectedCount: selected.length,
    selectableCount: selectable.length,
    selectAll,
    clear,
    dismiss,
    running,
    leftBehind,
  }
}
