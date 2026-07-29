'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { QualityStats, QualityStatsRange } from '@/lib/api'
import {
  computeQualityDelta,
  deltaTrend,
  formatCount,
  formatDelta,
  formatMetricSubtext,
  formatMetricValue,
  formatRate,
  previousRangeLabel,
  QUALITY_METRICS,
  QUALITY_STATS_RANGES,
  rangeDayCount,
  rangeLabel,
  sparklineSpanLabel,
  toSparklineSeries,
  type QualityDeltaTone,
  type QualityMetricDescriptor,
} from '@/lib/quality-stats'
import { Sparkline } from './sparkline'

const TONE_CLASS: Record<QualityDeltaTone, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  bad: 'text-destructive',
  neutral: 'text-muted-foreground',
}

const TREND_ICON = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
} as const

function DeltaChip({
  descriptor,
  stats,
}: {
  descriptor: QualityMetricDescriptor
  stats: QualityStats
}) {
  const delta = computeQualityDelta(
    descriptor,
    descriptor.readWindow(stats.current),
    descriptor.readWindow(stats.previous),
  )
  if (delta.kind === 'insufficient_data') {
    return (
      <span className="text-xs text-muted-foreground">Not enough data to compare</span>
    )
  }

  const text = formatDelta(delta)
  const trend = deltaTrend(delta)
  if (text === null || trend === null) {
    return null
  }

  const tone: QualityDeltaTone = delta.kind === 'unchanged' ? 'neutral' : delta.tone
  const Icon = TREND_ICON[trend]

  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_CLASS[tone])}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span>
        {text} {previousRangeLabel(stats.range)}
      </span>
    </span>
  )
}

function HealthTile({
  descriptor,
  stats,
}: {
  descriptor: QualityMetricDescriptor
  stats: QualityStats
}) {
  const sample = descriptor.readWindow(stats.current)
  const series = toSparklineSeries(stats.buckets, descriptor)
  const formatPoint = (value: number) =>
    descriptor.kind === 'volume' ? formatCount(value) : formatRate(value)

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid={`quality-tile-${descriptor.id}`}>
      <p className="text-sm text-muted-foreground">{descriptor.label}</p>
      {/* Proportional figures: this is a standalone number, not a table column. */}
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {formatMetricValue(descriptor, sample)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatMetricSubtext(descriptor, sample)}
      </p>
      <div className="mt-2">
        <DeltaChip descriptor={descriptor} stats={stats} />
      </div>
      <div className="mt-3">
        <Sparkline
          points={series}
          formatValue={formatPoint}
          ariaLabel={`${descriptor.label}, ${sparklineSpanLabel(series.length)}`}
        />
      </div>
    </div>
  )
}

/**
 * Zone 1 of the Quality view: windowed health rates with a delta against the
 * equal-length preceding window. Read-only — the range control here scopes these
 * tiles alone, never the queue below, which is an all-time backlog.
 */
export function QualityHealthRow({
  stats,
  range,
  onRangeChange,
  isRefreshing = false,
  error = null,
}: {
  stats: QualityStats | null
  range: QualityStatsRange
  onRangeChange: (next: QualityStatsRange) => void
  isRefreshing?: boolean
  error?: string | null
}) {
  return (
    <section aria-labelledby="quality-health-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="quality-health-heading" className="text-sm font-medium text-foreground">
          Health · {rangeLabel(range)}
        </h2>
        <div className="flex flex-wrap gap-2" aria-label="Health range">
          {QUALITY_STATS_RANGES.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant="outline"
              // The `outline` variant sets `dark:bg-input/30` and `dark:border-input`,
              // which otherwise beat these unprefixed classes in dark mode and leave the
              // selected range indistinguishable from the unselected one.
              className={
                range === value
                  ? 'border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background dark:border-foreground dark:bg-foreground dark:hover:bg-foreground/90'
                  : undefined
              }
              onClick={() => onRangeChange(value)}
              aria-pressed={range === value}
            >
              {rangeDayCount(value)} days
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <div
          className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground"
          data-testid="quality-health-error"
        >
          Health stats couldn&apos;t be loaded — {error}
        </div>
      ) : stats ? (
        <div
          className={cn(
            'grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-4',
            isRefreshing ? 'opacity-60' : undefined,
          )}
          data-testid="quality-health-row"
        >
          {QUALITY_METRICS.map((descriptor) => (
            <HealthTile key={descriptor.id} descriptor={descriptor} stats={stats} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
