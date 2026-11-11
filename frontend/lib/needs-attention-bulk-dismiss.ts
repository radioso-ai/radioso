import { getApiErrorStatus } from './api-error'
import { getQualityTriageConflict, type QualityTriageRecord } from './api-quality'
import type { InboxItem } from './needs-attention'
import { createRequestQueue } from './needs-attention-query-state'
import { isTerminalQualityTriageState } from './quality-signals'

/** A feedback row that can be dismissed: it names the turn the dismissal is recorded against. */
export type BulkDismissItem = InboxItem & { assistantMessageId: string }

/** The queue's still-open feedback rows. Handoffs, approvals and failures are not triage and never qualify. */
export const bulkDismissableItems = (items: readonly InboxItem[]): BulkDismissItem[] =>
  items.filter((item): item is BulkDismissItem =>
    item.type === 'negative_feedback'
    && item.assistantMessageId !== undefined
    && (item.triageState === 'open' || item.triageState === 'acknowledged'))

/**
 * What became of one row. A row another operator already closed has left the queue either way,
 * so it is its own outcome; a row they only changed stays, carrying the version a retry needs.
 */
export type BulkDismissResult =
  | { kind: 'dismissed'; triage: QualityTriageRecord }
  | { kind: 'closed_elsewhere'; current: QualityTriageRecord }
  | { kind: 'changed'; current: QualityTriageRecord }
  | { kind: 'failed'; status: number | null }

export interface BulkDismissRowResult {
  item: BulkDismissItem
  result: BulkDismissResult
}

/** Rows dismissed at once. Each is one request to the single-row triage endpoint. */
const BULK_DISMISS_CONCURRENCY = 4

const resultOfFailure = (caught: unknown): BulkDismissResult => {
  const current = getQualityTriageConflict(caught)
  if (current) {
    return { kind: isTerminalQualityTriageState(current.state) ? 'closed_elsewhere' : 'changed', current }
  }
  return { kind: 'failed', status: getApiErrorStatus(caught) ?? null }
}

/**
 * Dismisses each row through `dismiss`, a few at a time, and settles every one on its own: a row
 * that fails is reported and the rest carry on. `onSettled` fires as each row lands, so the queue
 * can update while the rest are still running.
 *
 * Aborting `signal` starts no row that is still waiting its turn, because a request that starts
 * late would read the active workspace as it is by then. Rows already sent finish where they were
 * sent, and nothing settles after an abort: whoever aborted has left the queue those results are for.
 */
export const runBulkDismiss = async ({
  items,
  dismiss,
  onSettled,
  concurrency = BULK_DISMISS_CONCURRENCY,
  signal,
}: {
  items: readonly BulkDismissItem[]
  dismiss: (item: BulkDismissItem) => Promise<QualityTriageRecord>
  onSettled?: (row: BulkDismissRowResult) => void
  concurrency?: number
  signal?: AbortSignal
}): Promise<BulkDismissRowResult[]> => {
  const enqueue = createRequestQueue(concurrency)
  return Promise.all(items.map(async (item) => {
    let result: BulkDismissResult
    try {
      result = { kind: 'dismissed', triage: await enqueue(() => dismiss(item), signal) }
    } catch (caught) {
      result = resultOfFailure(caught)
    }
    const row = { item, result }
    if (!signal?.aborted) {
      onSettled?.(row)
    }
    return row
  }))
}

const feedbackItems = (count: number): string => `${count} feedback ${count === 1 ? 'item' : 'items'}`

interface BulkDismissSummary {
  dismissed: number
  /** The rows that were not dismissed by this run, each to be reported on its own. */
  needsAttention: BulkDismissRowResult[]
  announcement: string
}

export const summarizeBulkDismiss = (rows: readonly BulkDismissRowResult[]): BulkDismissSummary => {
  const needsAttention = rows.filter((row) => row.result.kind !== 'dismissed')
  const dismissed = rows.length - needsAttention.length
  return {
    dismissed,
    needsAttention,
    announcement: needsAttention.length === 0
      ? `Dismissed ${feedbackItems(dismissed)}.`
      : `Dismissed ${dismissed} of ${feedbackItems(rows.length)}. ${needsAttention.length} need${needsAttention.length === 1 ? 's' : ''} a look.`,
  }
}

/** Why a row was not dismissed, in the words shown beside its title. */
export const bulkDismissRowMessage = (result: Exclude<BulkDismissResult, { kind: 'dismissed' }>): string => {
  switch (result.kind) {
    case 'closed_elsewhere':
      return 'Another operator already closed it.'
    case 'changed':
      return 'Another operator changed it. Try again.'
    case 'failed':
      return result.status === 403 ? 'You do not have permission to dismiss feedback.' : 'Could not dismiss. Try again.'
  }
}
