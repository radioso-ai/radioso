import { describe, expect, it } from 'vitest'

import { decideDefaultInboxLens, hasBlockingInboxLoadError } from '@/lib/inbox-default-lens'

const baseInput = {
  activityTab: undefined,
  alreadyDecided: false,
  isLoading: false,
  hasError: false,
  isQueueEmpty: false,
}

describe('decideDefaultInboxLens', () => {
  it('waits while the queue is still loading', () => {
    expect(decideDefaultInboxLens({ ...baseInput, isLoading: true })).toEqual({ kind: 'wait' })
  })

  it('waits when the queue failed to load, so it never guesses from a broken read', () => {
    expect(decideDefaultInboxLens({ ...baseInput, hasError: true })).toEqual({ kind: 'wait' })
  })

  it('stays on Needs-you (no-op) once loaded when there is open work', () => {
    expect(decideDefaultInboxLens({ ...baseInput, isQueueEmpty: false })).toEqual({ kind: 'no-op' })
  })

  it('redirects to the All lens once loaded when Needs-you has nothing open', () => {
    expect(decideDefaultInboxLens({ ...baseInput, isQueueEmpty: true })).toEqual({
      kind: 'redirect',
      activityTab: 'all',
    })
  })

  it('never decides again once alreadyDecided is set, even if the queue is now empty', () => {
    expect(decideDefaultInboxLens({ ...baseInput, alreadyDecided: true, isQueueEmpty: true })).toEqual({
      kind: 'wait',
    })
  })

  it('skips the decision entirely for an explicit lens choice, even "needs-attention"', () => {
    expect(decideDefaultInboxLens({ ...baseInput, activityTab: 'needs-attention', isQueueEmpty: true })).toEqual({
      kind: 'wait',
    })
    expect(decideDefaultInboxLens({ ...baseInput, activityTab: 'all', isQueueEmpty: true })).toEqual({
      kind: 'wait',
    })
  })
})

const noBlockingErrors = {
  approvalError: false,
  conversationError: false,
  qualityLoadFailed: false,
  qualityPermissionDenied: false,
}

describe('hasBlockingInboxLoadError', () => {
  it('is false when every source loaded cleanly', () => {
    expect(hasBlockingInboxLoadError(noBlockingErrors)).toBe(false)
  })

  it('blocks on an approval load error', () => {
    expect(hasBlockingInboxLoadError({ ...noBlockingErrors, approvalError: true })).toBe(true)
  })

  it('blocks on a human-owned conversation load error', () => {
    expect(hasBlockingInboxLoadError({ ...noBlockingErrors, conversationError: true })).toBe(true)
  })

  it('blocks on a quality load failure — a broken quality read must not read as "genuinely empty"', () => {
    expect(hasBlockingInboxLoadError({ ...noBlockingErrors, qualityLoadFailed: true })).toBe(true)
  })

  it('blocks on quality permission-denied — a 403 must not read as "genuinely empty" either', () => {
    expect(hasBlockingInboxLoadError({ ...noBlockingErrors, qualityPermissionDenied: true })).toBe(true)
  })
})

describe('decideDefaultInboxLens with hasBlockingInboxLoadError as the hasError source', () => {
  it('stays on Needs-you (never decides) when approvals/conversations are empty but quality failed to load', () => {
    // The exact regression: an empty reading of decisions + human-owned
    // conversations, with the quality query erroring or 403ing, must not be
    // read as "genuinely nothing needs you" and redirect to All — the
    // operator would never see the permission/load-failure state
    // InboxEmptyState shows for this.
    const hasError = hasBlockingInboxLoadError({
      approvalError: false,
      conversationError: false,
      qualityLoadFailed: true,
      qualityPermissionDenied: false,
    })

    expect(decideDefaultInboxLens({ ...baseInput, hasError, isQueueEmpty: true })).toEqual({ kind: 'wait' })
  })

  it('stays on Needs-you when quality is permission-denied specifically (403), not just a generic failure', () => {
    const hasError = hasBlockingInboxLoadError({
      approvalError: false,
      conversationError: false,
      qualityLoadFailed: false,
      qualityPermissionDenied: true,
    })

    expect(decideDefaultInboxLens({ ...baseInput, hasError, isQueueEmpty: true })).toEqual({ kind: 'wait' })
  })

  it('still redirects when every source loaded cleanly and the queue is genuinely empty', () => {
    const hasError = hasBlockingInboxLoadError(noBlockingErrors)

    expect(decideDefaultInboxLens({ ...baseInput, hasError, isQueueEmpty: true })).toEqual({
      kind: 'redirect',
      activityTab: 'all',
    })
  })
})
