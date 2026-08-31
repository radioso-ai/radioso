import { describe, expect, it } from 'vitest'

import {
  getCoverageGapFraction,
  getSparklinePoints,
  normalizeTopicShare,
} from '@/lib/audience-pulse-topic-viz'

describe('audience-pulse-topic-viz', () => {
  it('normalizes shares against the largest topic while bounding malformed values', () => {
    expect(normalizeTopicShare(0.125, 0.25)).toBe(0.5)
    expect(normalizeTopicShare(0.25, 0.25)).toBe(1)
    expect(normalizeTopicShare(2, 0.25)).toBe(1)
    expect(normalizeTopicShare(-1, 0.25)).toBe(0)
    expect(normalizeTopicShare(0.25, 0)).toBe(0)
  })

  it('returns a bounded coverage-gap fraction of a topic', () => {
    expect(getCoverageGapFraction(6, 30)).toBe(0.2)
    expect(getCoverageGapFraction(40, 30)).toBe(1)
    expect(getCoverageGapFraction(1, 0)).toBe(0)
    expect(getCoverageGapFraction(-1, 30)).toBe(0)
  })

  it('creates an evenly spaced, topic-scaled sparkline with padded endpoints', () => {
    expect(getSparklinePoints([2, 4, 3])).toEqual([
      { x: 3, y: 12, value: 2 },
      { x: 36, y: 3, value: 4 },
      { x: 69, y: 7.5, value: 3 },
    ])
  })

  it('omits sparklines without a meaningful trend', () => {
    expect(getSparklinePoints([4])).toEqual([])
    expect(getSparklinePoints([0, 0])).toEqual([])
  })
})
