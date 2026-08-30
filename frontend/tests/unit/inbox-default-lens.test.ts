import { describe, expect, it } from 'vitest'

import { decideDefaultInboxLens } from '@/lib/inbox-default-lens'

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
