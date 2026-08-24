'use client'

import { useEffect, useRef, useState, type Key } from 'react'
import { Line, LineChart, Tooltip, type TooltipContentProps } from 'recharts'

import { ChartTooltipCard } from '@/components/dashboard/chart-tooltip'
import type { SparklinePoint } from '@/lib/quality-stats'

interface SparklineDotProps {
  cx?: number
  cy?: number
  index?: number
  key?: Key | null
}

/**
 * Single-series trend line for a stat tile. Deliberately bare: no axes, no
 * gridlines, no legend — the tile's value and label carry the meaning, and the
 * line only carries shape. The most recent point is marked in accent so the eye
 * lands on "now" first.
 *
 * Width is measured with a `ResizeObserver` rather than recharts'
 * `ResponsiveContainer`, which reports zero width in headless browsers and makes
 * end-to-end tests flaky.
 */
export function Sparkline({
  points,
  formatValue,
  ariaLabel,
  height = 40,
}: {
  points: readonly SparklinePoint[]
  formatValue: (value: number) => string
  ariaLabel: string
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const updateWidth = () => {
      setWidth(Math.max(0, Math.floor(element.getBoundingClientRect().width)))
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const drawablePoints = points.filter((point) => point.value !== null)
  // Index of the day the accent marker sits on: the latest day that has a value.
  const lastDrawableIndex = points.reduce(
    (latest, point, index) => (point.value === null ? latest : index),
    -1,
  )

  const renderDot = ({ cx, cy, index, key }: SparklineDotProps) => {
    if (cx === undefined || cy === undefined || index !== lastDrawableIndex) {
      return <g key={key} />
    }
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={4}
        fill="var(--chart-1)"
        stroke="var(--card)"
        strokeWidth={2}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      data-testid="quality-sparkline"
      className="w-full"
      style={{ height }}
    >
      {width > 0 && drawablePoints.length > 1 ? (
        <LineChart
          accessibilityLayer
          width={width}
          height={height}
          data={points as SparklinePoint[]}
          margin={{ top: 6, right: 6, bottom: 2, left: 6 }}
        >
          <Tooltip
            cursor={false}
            isAnimationActive={false}
            content={({ active, payload }: TooltipContentProps) => {
              const entry = active ? payload?.[0] : undefined
              if (!entry) return null
              const point = entry.payload as SparklinePoint | undefined
              return (
                <ChartTooltipCard
                  label={point?.date}
                  rows={[{ key: 'value', value: formatValue(Number(entry.value ?? 0)) }]}
                />
              )
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--muted-foreground)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            connectNulls
            isAnimationActive={false}
            dot={renderDot}
            activeDot={{ r: 4, fill: 'var(--chart-1)', stroke: 'var(--card)', strokeWidth: 2 }}
          />
        </LineChart>
      ) : null}
    </div>
  )
}
