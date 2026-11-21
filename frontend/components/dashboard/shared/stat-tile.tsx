'use client'

import type { ReactNode } from 'react'

/**
 * One headline figure: label, value, the line saying what it is measured over, its change, and a
 * trend. Pages supply the figures; the tile owns only the anatomy.
 */
export function StatTile({
  label,
  value,
  subtext,
  delta,
  chart,
  testId,
}: {
  label: ReactNode
  value: ReactNode
  subtext: ReactNode
  delta: ReactNode
  chart: ReactNode
  testId?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid={testId}>
      <p className="text-sm text-muted-foreground">{label}</p>
      {/* Proportional figures: this is a standalone number, not a table column. */}
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
      <div className="mt-2">{delta}</div>
      <div className="mt-3">{chart}</div>
    </div>
  )
}
