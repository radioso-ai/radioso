import { describe, expect, it } from 'vitest'

import type { QualityStatsBucket } from '@/lib/api'
import {
  computeQualityDelta,
  deltaTrend,
  formatDelta,
  formatMetricSubtext,
  formatMetricValue,
  formatRate,
  isSampleReportable,
  MIN_RATE_SAMPLE,
  previousRangeLabel,
  QUALITY_METRICS,
  rangeLabel,
  sparklineSpanLabel,
  toSparklineSeries,
  type QualityMetricSample,
} from '@/lib/quality-stats'

const rateSample = (count: number, denominator: number): QualityMetricSample => ({
  count,
  denominator,
  rate: denominator === 0 ? null : count / denominator,
})

const volumeSample = (count: number): QualityMetricSample => ({
  count,
  denominator: null,
  rate: null,
})

const RATE_METRIC = { kind: 'rate' as const, direction: 'higher_is_better' as const }
const INVERSE_RATE_METRIC = { kind: 'rate' as const, direction: 'lower_is_better' as const }
const VOLUME_METRIC = { kind: 'volume' as const, direction: 'neutral' as const }

const bucket = (date: string, turnCount: number, grounded: [number, number]): QualityStatsBucket => ({
  date,
  turnCount,
  grounded: {
    count: grounded[0],
    denominator: grounded[1],
    rate: grounded[1] === 0 ? null : grounded[0] / grounded[1],
  },
  negativeFeedback: { count: 0, denominator: 0, rate: null },
  skillFailures: { count: 0, denominator: 0, rate: null },
})

const groundedDescriptor = QUALITY_METRICS.find((metric) => metric.id === 'grounded')!
const answersDescriptor = QUALITY_METRICS.find((metric) => metric.id === 'answers')!

describe('sample floor', () => {
  it('reports a rate only once the denominator clears the floor', () => {
    expect(isSampleReportable(rateSample(10, MIN_RATE_SAMPLE - 1))).toBe(false)
    expect(isSampleReportable(rateSample(10, MIN_RATE_SAMPLE))).toBe(true)
  })

  it('measures a volume sample by its own count', () => {
    expect(isSampleReportable(volumeSample(MIN_RATE_SAMPLE - 1))).toBe(false)
    expect(isSampleReportable(volumeSample(MIN_RATE_SAMPLE))).toBe(true)
  })
})

describe('computeQualityDelta', () => {
  it('reads a rise in a higher-is-better rate as good, in percentage points', () => {
    const delta = computeQualityDelta(RATE_METRIC, rateSample(68, 100), rateSample(62, 100))

    expect(delta).toEqual({ kind: 'rate', points: expect.closeTo(6, 5), tone: 'good' })
    expect(deltaTrend(delta)).toBe('up')
    expect(formatDelta(delta)).toBe('+6 pts')
  })

  it('reads a fall in a higher-is-better rate as bad', () => {
    const delta = computeQualityDelta(RATE_METRIC, rateSample(50, 100), rateSample(62, 100))

    expect(delta).toMatchObject({ kind: 'rate', tone: 'bad' })
    expect(deltaTrend(delta)).toBe('down')
    expect(formatDelta(delta)).toBe('-12 pts')
  })

  it('flips the tone for a lower-is-better rate', () => {
    const worse = computeQualityDelta(INVERSE_RATE_METRIC, rateSample(12, 100), rateSample(4, 100))
    const better = computeQualityDelta(INVERSE_RATE_METRIC, rateSample(4, 100), rateSample(12, 100))

    expect(worse).toMatchObject({ kind: 'rate', tone: 'bad' })
    expect(deltaTrend(worse)).toBe('up')
    expect(better).toMatchObject({ kind: 'rate', tone: 'good' })
    expect(deltaTrend(better)).toBe('down')
  })

  it('expresses a volume change as a percentage of the previous window, tone neutral', () => {
    const delta = computeQualityDelta(VOLUME_METRIC, volumeSample(125), volumeSample(100))

    expect(delta).toEqual({ kind: 'volume', percent: expect.closeTo(0.25, 5), tone: 'neutral' })
    expect(formatDelta(delta)).toBe('+25%')
    expect(deltaTrend(delta)).toBe('up')
  })

  it('says no change when the movement rounds away at display precision', () => {
    const flatRate = computeQualityDelta(RATE_METRIC, rateSample(620, 1000), rateSample(620, 1000))
    const flatVolume = computeQualityDelta(VOLUME_METRIC, volumeSample(100), volumeSample(100))

    expect(flatRate).toEqual({ kind: 'unchanged' })
    expect(flatVolume).toEqual({ kind: 'unchanged' })
    expect(formatDelta(flatRate)).toBe('No change')
    expect(deltaTrend(flatRate)).toBe('flat')
  })

  it('refuses a delta when the current window is below the floor', () => {
    const delta = computeQualityDelta(RATE_METRIC, rateSample(3, 5), rateSample(62, 100))

    expect(delta).toEqual({ kind: 'insufficient_data' })
    expect(formatDelta(delta)).toBeNull()
    expect(deltaTrend(delta)).toBeNull()
  })

  it('refuses a delta when the previous window is below the floor', () => {
    expect(computeQualityDelta(RATE_METRIC, rateSample(62, 100), rateSample(3, 5))).toEqual({
      kind: 'insufficient_data',
    })
  })

  it('refuses a volume delta when the previous window is empty', () => {
    expect(computeQualityDelta(VOLUME_METRIC, volumeSample(40), volumeSample(0))).toEqual({
      kind: 'insufficient_data',
    })
  })

  it('refuses a rate delta when either window has no defined rate', () => {
    const undefinedRate: QualityMetricSample = { count: 0, denominator: 40, rate: null }

    expect(computeQualityDelta(RATE_METRIC, undefinedRate, rateSample(62, 100))).toEqual({
      kind: 'insufficient_data',
    })
  })
})

describe('toSparklineSeries', () => {
  const thirtyBuckets = Array.from({ length: 30 }, (_, index) =>
    bucket(`2026-07-${String(index + 1).padStart(2, '0')}`, index, [index, 100]),
  )

  it('keeps every bucket when the window already fits', () => {
    const sevenBuckets = thirtyBuckets.slice(0, 7)

    expect(toSparklineSeries(sevenBuckets, groundedDescriptor)).toHaveLength(7)
  })

  it('keeps the trailing 12 days of a 30-day window', () => {
    const series = toSparklineSeries(thirtyBuckets, groundedDescriptor)

    expect(series).toHaveLength(12)
    expect(series[0].date).toBe('2026-07-19')
    expect(series[11].date).toBe('2026-07-30')
  })

  it('reads rates for rate metrics and counts for volume metrics', () => {
    const buckets = [bucket('2026-07-01', 42, [30, 60])]

    expect(toSparklineSeries(buckets, groundedDescriptor)[0].value).toBeCloseTo(0.5, 5)
    expect(toSparklineSeries(buckets, answersDescriptor)[0].value).toBe(42)
  })

  it('leaves a day with no population as a gap rather than inventing a zero', () => {
    const buckets = [bucket('2026-07-01', 0, [0, 0])]

    expect(toSparklineSeries(buckets, groundedDescriptor)[0].value).toBeNull()
  })

  it('names the span it actually shows', () => {
    expect(sparklineSpanLabel(12)).toBe('last 12 days')
    expect(sparklineSpanLabel(1)).toBe('last day')
  })
})

describe('formatting', () => {
  it('prints a rate once the sample clears the floor', () => {
    expect(formatMetricValue(groundedDescriptor, rateSample(62, 100))).toBe('62%')
    expect(formatRate(null)).toBe('—')
  })

  it('falls back to the raw count when a rate would be built on too little data', () => {
    const thin = rateSample(3, 5)

    expect(formatMetricValue(groundedDescriptor, thin)).toBe('3')
    expect(formatMetricSubtext(groundedDescriptor, thin)).toBe('3 of 5 answer attempts — too few to rate')
  })

  it('always prints the denominator under a reportable rate', () => {
    expect(formatMetricSubtext(groundedDescriptor, rateSample(22, 534))).toBe('22 of 534 answer attempts')
  })

  it('prints the count for a volume metric', () => {
    expect(formatMetricValue(answersDescriptor, volumeSample(1204))).toBe('1,204')
    expect(formatMetricSubtext(answersDescriptor, volumeSample(1204))).toBe('answers')
  })

  it('names the period a delta is measured against', () => {
    expect(rangeLabel('7d')).toBe('last 7 days')
    expect(rangeLabel('30d')).toBe('last 30 days')
    expect(previousRangeLabel('30d')).toBe('vs previous 30 days')
  })
})
