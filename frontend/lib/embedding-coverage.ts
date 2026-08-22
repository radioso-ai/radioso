import type { EmbeddingCoverage } from './api-types'

/**
 * Turns raw coverage counts into the one thing an operator needs from them: whether
 * indexing is finished, still moving, or stuck in a way that no amount of waiting fixes.
 *
 * The distinction matters because the two stuck states are invisible in the numbers
 * alone. A workspace with no embedding model produces no indexing work however often
 * the backfill runs, and a failed job keeps its job key, so the chunks behind it can
 * never be re-enqueued. Both look identical to "still working" if you only read the
 * missing count.
 */
export type EmbeddingCoverageStatus =
  | 'empty'
  | 'complete'
  | 'indexing'
  | 'stalled'
  | 'unconfigured'

/** Everything the coverage line renders, so the component reads one value. */
export interface EmbeddingCoverageSummary {
  status: EmbeddingCoverageStatus
  coveredChunks: number
  eligibleChunks: number
  queuedJobs: number
  failedJobs: number
  /** Whole percent, floored so it never reads 100% while chunks are still missing. */
  percentComplete: number
}

export const summarizeEmbeddingCoverage = (
  coverage: EmbeddingCoverage,
): EmbeddingCoverageSummary => {
  const base = {
    coveredChunks: coverage.coveredChunks,
    eligibleChunks: coverage.eligibleChunks,
    queuedJobs: coverage.queuedJobs,
    failedJobs: coverage.failedJobs,
    percentComplete: coverage.eligibleChunks === 0
      ? 100
      : Math.floor((coverage.coveredChunks / coverage.eligibleChunks) * 100),
  }

  if (coverage.eligibleChunks === 0) {
    return { ...base, status: 'empty' }
  }
  if (coverage.missingChunks === 0) {
    return { ...base, status: 'complete' }
  }
  // Ordered by what blocks progress hardest: without an embedding model there is no
  // work to queue at all, so that outranks a failed job, which outranks a live queue.
  if (!coverage.hasEmbeddingProfile) {
    return { ...base, status: 'unconfigured' }
  }
  if (coverage.failedJobs > 0) {
    return { ...base, status: 'stalled' }
  }
  return { ...base, status: 'indexing' }
}
