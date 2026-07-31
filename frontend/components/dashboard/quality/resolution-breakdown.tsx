'use client'

import type {
  QualityResolutionBreakdownReason,
  QualityStats,
} from '@/lib/api-quality'
import { Button } from '@/components/ui/button'
import { REASON_LABELS } from './close-review-popover'

const reasonLabel = (reason: QualityResolutionBreakdownReason): string =>
  reason === 'unspecified' ? 'Reason unspecified' : REASON_LABELS[reason]

export function ResolutionBreakdown({
  stats,
  onSelect,
}: {
  stats: QualityStats | null
  onSelect: (
    entry: QualityStats['resolutionBreakdown'][number],
    window: { from: string; to: string },
  ) => void
}) {
  const entries = stats?.resolutionBreakdown ?? []
  if (!stats || entries.length === 0) return null
  const groups = [
    { state: 'resolved' as const, label: 'Resolved' },
    { state: 'dismissed' as const, label: 'Not actionable' },
  ].map((group) => ({
    ...group,
    entries: entries.filter((entry) => entry.state === group.state),
  })).filter((group) => group.entries.length > 0)

  return (
    <section className="mt-3 rounded-lg border border-border bg-card px-4 py-3" aria-labelledby="resolution-breakdown-heading">
      <h3 id="resolution-breakdown-heading" className="text-sm font-medium text-foreground">
        Closed review reasons
      </h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {groups.map((group) => {
          const headingId = `resolution-breakdown-${group.state}`
          return (
            <div key={group.state} role="group" aria-labelledby={headingId}>
              <p id={headingId} className="text-xs font-medium text-muted-foreground">
                {group.label}
              </p>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                {group.entries.map((entry) => (
                  <Button
                    key={entry.reason}
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => onSelect(entry, {
                      from: stats.current.from,
                      to: stats.current.to,
                    })}
                  >
                    {entry.count} {reasonLabel(entry.reason)}
                  </Button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
