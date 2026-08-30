export interface SparklinePoint {
  x: number
  y: number
  value: number
}

const DEFAULT_WIDTH = 72
const DEFAULT_HEIGHT = 24
const DEFAULT_PADDING = 3

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Maps a topic share into the topic list's local 0–1 scale. */
export function normalizeTopicShare(share: number, maxShare: number): number {
  const safeShare = finiteNonNegative(share)
  const safeMaxShare = finiteNonNegative(maxShare)
  if (safeMaxShare === 0) return 0
  return Math.min(1, safeShare / safeMaxShare)
}

/** Returns the coverage-gap portion of a topic's visual share bar. */
export function getCoverageGapFraction(contentGapEligible: number, memberCount: number): number {
  const safeEligible = finiteNonNegative(contentGapEligible)
  const safeMemberCount = finiteNonNegative(memberCount)
  if (safeMemberCount === 0) return 0
  return Math.min(1, safeEligible / safeMemberCount)
}

/**
 * Produces a padded, evenly spaced polyline for one topic's weekly counts.
 * Each chart uses its own y-scale so it communicates change, not volume rank.
 */
export function getSparklinePoints(
  counts: number[],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  padding = DEFAULT_PADDING,
): SparklinePoint[] {
  const safeCounts = counts.map(finiteNonNegative)
  const maxValue = Math.max(0, ...safeCounts)
  if (safeCounts.length < 2 || maxValue === 0) return []

  const safeWidth = Math.max(0, width)
  const safeHeight = Math.max(0, height)
  const safePadding = Math.min(Math.max(0, padding), safeWidth / 2, safeHeight / 2)
  const drawableWidth = safeWidth - (safePadding * 2)
  const drawableHeight = safeHeight - (safePadding * 2)

  return safeCounts.map((value, index) => ({
    x: safePadding + ((drawableWidth * index) / (safeCounts.length - 1)),
    y: safePadding + (drawableHeight * (1 - (value / maxValue))),
    value,
  }))
}
