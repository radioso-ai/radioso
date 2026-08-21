/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEmbeddingCoverage } from '@/hooks/use-embedding-coverage'
import { settingsApi } from '@/lib/api'
import { summarizeEmbeddingCoverage } from '@/lib/embedding-coverage'
import type { EmbeddingCoverage } from '@/lib/api-types'

vi.mock('@/lib/api', () => ({
  settingsApi: { getEmbeddingCoverage: vi.fn() },
}))

const settingsApiMock = vi.mocked(settingsApi)

const coverage = (overrides: Partial<EmbeddingCoverage> = {}): EmbeddingCoverage => ({
  eligibleChunks: 100,
  coveredChunks: 100,
  missingChunks: 0,
  hasEmbeddingProfile: true,
  queuedJobs: 0,
  failedJobs: 0,
  ...overrides,
})

describe('summarizeEmbeddingCoverage', () => {
  it('reports complete coverage when nothing is missing', () => {
    expect(summarizeEmbeddingCoverage(coverage()).status).toBe('complete')
  })

  it('reports an empty workspace separately from a finished one', () => {
    // Nothing to index reads as 100% but is not the same state, and offering to fix it
    // would be nonsense.
    const summary = summarizeEmbeddingCoverage(coverage({
      eligibleChunks: 0,
      coveredChunks: 0,
    }))

    expect(summary.status).toBe('empty')
    expect(summary.percentComplete).toBe(100)
  })

  it('reports work in progress while jobs are queued', () => {
    expect(summarizeEmbeddingCoverage(coverage({
      coveredChunks: 60,
      missingChunks: 40,
      queuedJobs: 5,
    })).status).toBe('indexing')
  })

  it('reports a failed job as stalled rather than in progress', () => {
    // A failed job holds the profile-job key, so its chunks can never be re-enqueued.
    // Waiting will not clear it.
    expect(summarizeEmbeddingCoverage(coverage({
      coveredChunks: 60,
      missingChunks: 40,
      queuedJobs: 5,
      failedJobs: 1,
    })).status).toBe('stalled')
  })

  it('reports a missing embedding model ahead of any other blocker', () => {
    // Indexing joins the workspace's embedding profile, so without one there is no work
    // to queue at all — retrying is pointless until a model is set.
    expect(summarizeEmbeddingCoverage(coverage({
      coveredChunks: 0,
      missingChunks: 100,
      hasEmbeddingProfile: false,
      failedJobs: 3,
    })).status).toBe('unconfigured')
  })

  it('floors the percentage so it never reads complete while chunks are missing', () => {
    const summary = summarizeEmbeddingCoverage(coverage({
      eligibleChunks: 1000,
      coveredChunks: 999,
      missingChunks: 1,
    }))

    expect(summary.percentComplete).toBe(99)
    expect(summary.status).toBe('indexing')
  })
})

describe('useEmbeddingCoverage', () => {
  let container: HTMLDivElement
  let root: Root
  const observed: { current: EmbeddingCoverage | null } = { current: null }

  function Probe() {
    const current = useEmbeddingCoverage('text-embedding-3-small', 20_000)
    useEffect(() => {
      observed.current = current
    }, [current])
    return null
  }

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    observed.current = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('retries after a transient coverage request failure', async () => {
    settingsApiMock.getEmbeddingCoverage
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce(coverage({ coveredChunks: 75, missingChunks: 25 }))

    await act(async () => {
      root.render(createElement(Probe))
      await Promise.resolve()
    })
    expect(settingsApiMock.getEmbeddingCoverage).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(settingsApiMock.getEmbeddingCoverage).toHaveBeenCalledTimes(2)
    expect(observed.current?.coveredChunks).toBe(75)
  })
})
