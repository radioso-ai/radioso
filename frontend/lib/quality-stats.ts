import {
  QUALITY_STATS_RANGES,
  type QualityStatsBucket,
  type QualityStatsMetric,
  type QualityStatsRange,
  type QualityStatsWindow,
} from '@/lib/api-quality'

export { QUALITY_STATS_RANGES }

/**
 * Below this many observations a rate is noise, so the tile prints the raw count
 * and says so instead of inventing a percentage. A delta needs BOTH windows to
 * clear the floor — an improvement measured against three turns is not an
 * improvement.
 */
export const MIN_RATE_SAMPLE = 20

/** Points drawn in a tile sparkline. See `toSparklineSeries` for how longer windows are reduced. */
export const SPARKLINE_POINTS = 12

// Keyed by the range union, so adding a range to the API contract fails to compile here
// until its day count is supplied.
const RANGE_DAYS: Record<QualityStatsRange, number> = { '7d': 7, '30d': 30 }

export const rangeDayCount = (range: QualityStatsRange): number => RANGE_DAYS[range]

export const rangeLabel = (range: QualityStatsRange): string =>
  `last ${rangeDayCount(range)} days`

export const previousRangeLabel = (range: QualityStatsRange): string =>
  `vs previous ${rangeDayCount(range)} days`

/** Which way is "better" for a metric. Drives the delta tone; never colour alone. */
export type QualityMetricDirection = 'higher_is_better' | 'lower_is_better' | 'neutral'

/** A volume metric's value is its count; a rate metric's value is count / denominator. */
export type QualityMetricKind = 'volume' | 'rate'

export type QualityDeltaTone = 'good' | 'bad' | 'neutral'

export type QualityMetricId = 'answers' | 'grounded' | 'negative_feedback' | 'skill_failures'

/**
 * One metric read off a window or a bucket. `denominator` is null for volume
 * metrics, which are not defined over a population.
 */
export interface QualityMetricSample {
  count: number
  denominator: number | null
  rate: number | null
}

export interface QualityMetricDescriptor {
  id: QualityMetricId
  label: string
  kind: QualityMetricKind
  direction: QualityMetricDirection
  /**
   * Sentence fragment completing "<count> of <denominator> ...", printed under
   * the value so the reader always sees what the rate is measured over.
   */
  denominatorNoun: string
  readWindow: (window: QualityStatsWindow) => QualityMetricSample
  readBucket: (bucket: QualityStatsBucket) => QualityMetricSample
}

const fromMetric = (metric: QualityStatsMetric): QualityMetricSample => ({
  count: metric.count,
  denominator: metric.denominator,
  rate: metric.rate,
})

const asVolume = (count: number): QualityMetricSample => ({
  count,
  denominator: null,
  rate: null,
})

export const QUALITY_METRICS: readonly QualityMetricDescriptor[] = [
  {
    id: 'answers',
    label: 'Answers',
    kind: 'volume',
    direction: 'neutral',
    denominatorNoun: 'answers',
    readWindow: (window) => asVolume(window.turnCount),
    readBucket: (bucket) => asVolume(bucket.turnCount),
  },
  {
    id: 'grounded',
    label: 'Grounded answers',
    kind: 'rate',
    direction: 'higher_is_better',
    denominatorNoun: 'answer attempts',
    readWindow: (window) => fromMetric(window.grounded),
    readBucket: (bucket) => fromMetric(bucket.grounded),
  },
  {
    id: 'negative_feedback',
    label: 'Negative feedback',
    kind: 'rate',
    direction: 'lower_is_better',
    denominatorNoun: 'rated',
    readWindow: (window) => fromMetric(window.negativeFeedback),
    readBucket: (bucket) => fromMetric(bucket.negativeFeedback),
  },
  {
    id: 'skill_failures',
    label: 'Skill failures',
    kind: 'rate',
    direction: 'lower_is_better',
    denominatorNoun: 'answers',
    readWindow: (window) => fromMetric(window.skillFailures),
    readBucket: (bucket) => fromMetric(bucket.skillFailures),
  },
]

/**
 * How many observations a sample rests on: the population for a rate, the count
 * itself for a volume. This is what `MIN_RATE_SAMPLE` is applied to.
 */
export const sampleSize = (sample: QualityMetricSample): number =>
  sample.denominator ?? sample.count

/** Whether a sample carries enough observations to report a rate or a delta. */
export const isSampleReportable = (sample: QualityMetricSample): boolean =>
  sampleSize(sample) >= MIN_RATE_SAMPLE

export type QualityDelta =
  /** Rate change expressed in percentage points (e.g. 62% -> 68% is +6 points). */
  | { kind: 'rate'; points: number; tone: QualityDeltaTone }
  /** Volume change expressed as a proportion of the previous window (0.25 is +25%). */
  | { kind: 'volume'; percent: number; tone: QualityDeltaTone }
  | { kind: 'unchanged' }
  | { kind: 'insufficient_data' }

/** Deltas smaller than these round to zero at display precision, so we say "no change" instead. */
const RATE_POINT_EPSILON = 0.05
const VOLUME_PERCENT_EPSILON = 0.005

const toneFor = (direction: QualityMetricDirection, change: number): QualityDeltaTone => {
  if (direction === 'neutral' || change === 0) {
    return 'neutral'
  }
  const improving = direction === 'higher_is_better' ? change > 0 : change < 0
  return improving ? 'good' : 'bad'
}

/**
 * Compare a metric across the two windows. Returns `insufficient_data` unless
 * both windows clear `MIN_RATE_SAMPLE`, so a delta is never computed off a
 * sample too small to mean anything.
 */
export const computeQualityDelta = (
  descriptor: Pick<QualityMetricDescriptor, 'kind' | 'direction'>,
  current: QualityMetricSample,
  previous: QualityMetricSample,
): QualityDelta => {
  if (!isSampleReportable(current) || !isSampleReportable(previous)) {
    return { kind: 'insufficient_data' }
  }

  if (descriptor.kind === 'volume') {
    if (previous.count === 0) {
      return { kind: 'insufficient_data' }
    }
    const percent = (current.count - previous.count) / previous.count
    if (Math.abs(percent) < VOLUME_PERCENT_EPSILON) {
      return { kind: 'unchanged' }
    }
    return { kind: 'volume', percent, tone: toneFor(descriptor.direction, percent) }
  }

  if (current.rate === null || previous.rate === null) {
    return { kind: 'insufficient_data' }
  }
  const points = (current.rate - previous.rate) * 100
  if (Math.abs(points) < RATE_POINT_EPSILON) {
    return { kind: 'unchanged' }
  }
  return { kind: 'rate', points, tone: toneFor(descriptor.direction, points) }
}

export interface SparklinePoint {
  /** YYYY-MM-DD, the UTC day this point covers. */
  date: string
  /** Rate (0..1) for rate metrics, count for volume metrics; null when undefined for the day. */
  value: number | null
}

/**
 * Reduce a window's daily buckets to at most `maxPoints` points.
 *
 * A 30-day window has 30 buckets, so something has to give. We keep the TRAILING
 * points rather than sampling across the window: every point stays a real,
 * contiguous day (matching the per-day hover readout), and no spike is dropped
 * by a sampling stride. The consumer must label the sparkline with the span it
 * actually shows — see `sparklineSpanLabel`.
 */
export const toSparklineSeries = (
  buckets: readonly QualityStatsBucket[],
  descriptor: Pick<QualityMetricDescriptor, 'kind' | 'readBucket'>,
  maxPoints: number = SPARKLINE_POINTS,
): SparklinePoint[] => {
  const trailing = maxPoints > 0 ? buckets.slice(-maxPoints) : []
  return trailing.map((bucket) => {
    const sample = descriptor.readBucket(bucket)
    return {
      date: bucket.date,
      value: descriptor.kind === 'volume' ? sample.count : sample.rate,
    }
  })
}

/** Honest caption for a sparkline that may cover fewer days than the tile's window. */
export const sparklineSpanLabel = (pointCount: number): string =>
  pointCount === 1 ? 'last day' : `last ${pointCount} days`

const countFormatter = new Intl.NumberFormat()
const rateFormatter = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
})
const pointsFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
})
const percentChangeFormatter = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
})

export const formatCount = (value: number): string => countFormatter.format(value)

export const formatRate = (rate: number | null): string =>
  rate === null ? '—' : rateFormatter.format(rate)

/** Shown in place of a rate when the sample is below the floor. */
export const TOO_FEW_TO_RATE = 'too few to rate'

/**
 * The headline figure for a tile: the count for volume metrics, the rate for
 * rate metrics, and the raw count when a rate would be built on too little data.
 */
export const formatMetricValue = (
  descriptor: Pick<QualityMetricDescriptor, 'kind'>,
  sample: QualityMetricSample,
): string => {
  if (descriptor.kind === 'volume' || !isSampleReportable(sample)) {
    return formatCount(sample.count)
  }
  return formatRate(sample.rate)
}

/** The line under the value: either the denominator, or why there is no rate. */
export const formatMetricSubtext = (
  descriptor: Pick<QualityMetricDescriptor, 'kind' | 'denominatorNoun'>,
  sample: QualityMetricSample,
): string => {
  if (descriptor.kind === 'volume') {
    return descriptor.denominatorNoun
  }
  const denominator = sample.denominator ?? 0
  const of = `${formatCount(sample.count)} of ${formatCount(denominator)} ${descriptor.denominatorNoun}`
  return isSampleReportable(sample) ? of : `${of} — ${TOO_FEW_TO_RATE}`
}

/** The delta chip text. Null means render no chip at all. */
export const formatDelta = (delta: QualityDelta): string | null => {
  switch (delta.kind) {
    case 'rate':
      return `${pointsFormatter.format(delta.points)} pts`
    case 'volume':
      return percentChangeFormatter.format(delta.percent)
    case 'unchanged':
      return 'No change'
    case 'insufficient_data':
      return null
  }
}

/** Arrow direction for the delta chip, so tone is never carried by colour alone. */
export const deltaTrend = (delta: QualityDelta): 'up' | 'down' | 'flat' | null => {
  switch (delta.kind) {
    case 'rate':
      return delta.points > 0 ? 'up' : 'down'
    case 'volume':
      return delta.percent > 0 ? 'up' : 'down'
    case 'unchanged':
      return 'flat'
    case 'insufficient_data':
      return null
  }
}
