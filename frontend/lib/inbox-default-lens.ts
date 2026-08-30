import type { ActivityTab } from '@/lib/dashboard-routes'

/**
 * The Inbox's smart default lens (spec 1116 follow-up): an operator who
 * arrives with no explicit lens in the URL sees Needs-you when there's open
 * work, otherwise the All lens is more useful than an empty queue. The
 * decision is made once, from the first load's resolved data — `alreadyDecided`
 * lets the caller guard against re-deciding later so draining the queue (or
 * new items arriving) never yanks the lens out from under an operator already
 * on the page, and an explicit `activityTab` (including a deliberate
 * `'needs-attention'` choice) always short-circuits this entirely.
 */
export type InboxDefaultLensDecision =
  /** Not ready to decide (already decided, an explicit lens is set, or the queue hasn't resolved yet). */
  | { kind: 'wait' }
  /** Decided: stay on the lens already rendering (Needs-you has open items). */
  | { kind: 'no-op' }
  /** Decided: redirect to the given lens (Needs-you is empty). */
  | { kind: 'redirect'; activityTab: ActivityTab }

/**
 * Whether the Inbox's data sources are in a state that should block the
 * smart-default-lens decision from treating an empty reading as trustworthy.
 * An approval/conversation load error, a quality load failure, or a quality
 * permission-denied state all mean "we don't actually know whether Needs-you
 * is empty" — redirecting to All in that state would skip straight past the
 * error/permission message the Needs-you empty state already shows for it
 * (InboxEmptyState's qualityPermissionDenied / qualityLoadFailed props).
 */
export const hasBlockingInboxLoadError = (input: {
  approvalError: boolean
  conversationError: boolean
  qualityLoadFailed: boolean
  qualityPermissionDenied: boolean
}): boolean => input.approvalError
  || input.conversationError
  || input.qualityLoadFailed
  || input.qualityPermissionDenied

export function decideDefaultInboxLens(input: {
  /** The URL's current lens choice; undefined means "no explicit preference yet." */
  activityTab: ActivityTab | undefined
  /** True once this mount has already made its one-time decision. */
  alreadyDecided: boolean
  isLoading: boolean
  hasError: boolean
  isQueueEmpty: boolean
}): InboxDefaultLensDecision {
  if (input.activityTab !== undefined || input.alreadyDecided) {
    return { kind: 'wait' }
  }

  if (input.isLoading || input.hasError) {
    return { kind: 'wait' }
  }

  return input.isQueueEmpty ? { kind: 'redirect', activityTab: 'all' } : { kind: 'no-op' }
}
