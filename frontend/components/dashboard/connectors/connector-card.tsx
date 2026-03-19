'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ConnectorSummary } from '@/lib/api'

interface ConnectorCardProps {
  connector: ConnectorSummary
  isSelected: boolean
  onSelect: (connectorId: string) => void
}

export function ConnectorCard({
  connector,
  isSelected,
  onSelect,
}: ConnectorCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(connector.id)}
      className={cn(
        'w-full rounded-xl border px-4 py-4 text-left transition-colors',
        isSelected
          ? 'border-primary bg-primary/10 shadow-sm'
          : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">{connector.name}</p>
          <p className="text-sm text-muted-foreground">{connector.description}</p>
        </div>
        <Badge variant={connector.enabled ? 'default' : 'outline'}>
          {connector.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
      </div>

      {connector.errorStatus ? (
        <div className="mt-3 flex items-center gap-2">
          <Badge variant="destructive">Needs attention</Badge>
          <span className="text-xs text-muted-foreground">{connector.errorStatus}</span>
        </div>
      ) : null}
    </button>
  )
}
