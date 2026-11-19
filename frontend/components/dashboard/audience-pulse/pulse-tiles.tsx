'use client'

import { DeltaChip } from '@/components/dashboard/shared/delta-chip'
import { Sparkline } from '@/components/dashboard/shared/sparkline'
import { StatTile } from '@/components/dashboard/shared/stat-tile'
import { formatCount, type PulseTile } from '@/lib/audience-pulse-figures'

const formatRatePoint = (value: number) => `${Math.round(value * 100)}%`

export function PulseTiles({ tiles }: { tiles: readonly PulseTile[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="audience-pulse-tiles">
      {tiles.map((tile) => (
        <StatTile
          key={tile.id}
          testId={`audience-pulse-tile-${tile.id}`}
          label={tile.label}
          value={tile.value}
          subtext={tile.subtext}
          delta={<DeltaChip delta={tile.delta} />}
          chart={(
            <Sparkline
              points={tile.series}
              formatValue={tile.seriesKind === 'rate' ? formatRatePoint : formatCount}
              ariaLabel={`${tile.label}, daily, last ${tile.series.length} days`}
            />
          )}
        />
      ))}
    </div>
  )
}
