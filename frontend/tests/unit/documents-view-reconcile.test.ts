/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DOCUMENTS_RECONCILE_INTERVAL_MS,
  startDocumentsReconcileFloor,
} from '@/components/dashboard/documents-view'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('documents reconcile floor', () => {
  it('runs every 45 seconds without waiting for an active job status', () => {
    const reconcile = vi.fn()
    const intervalId = startDocumentsReconcileFloor(reconcile)

    vi.advanceTimersByTime(DOCUMENTS_RECONCILE_INTERVAL_MS - 1)
    expect(reconcile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(reconcile).toHaveBeenCalledTimes(1)

    window.clearInterval(intervalId)
  })
})
