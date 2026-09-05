'use client'

import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  isFilterApplied,
  type FilterDefinition,
  type FilterValue,
  type FilterValues,
} from './filter-schema'

interface ActiveFilterPillsProps {
  filters: ReadonlyArray<FilterDefinition>
  values: FilterValues
  onRemove: (id: string) => void
  className?: string
  emptyLabel?: string
}

const formatList = (entries: string[]): string => {
  if (entries.length === 0) return ''
  if (entries.length === 1) return entries[0]
  if (entries.length === 2) return `${entries[0]} or ${entries[1]}`
  return `${entries.slice(0, 2).join(', ')}, +${entries.length - 2} more`
}

const describeValue = (filter: FilterDefinition, value: FilterValue): string => {
  if (filter.kind === 'multi-select' && value.kind === 'multi-select') {
    const labels = value.values
      .map((selected) => filter.options.find((option) => option.value === selected)?.label ?? selected)
    return formatList(labels)
  }
  if (filter.kind === 'single-select' && value.kind === 'single-select') {
    return filter.options.find((option) => option.value === value.value)?.label ?? value.value
  }
  return ''
}

export function ActiveFilterPills({
  filters,
  values,
  onRemove,
  className,
  emptyLabel,
}: ActiveFilterPillsProps) {
  const applied = filters.filter((filter) => isFilterApplied(values[filter.id]))

  if (applied.length === 0) {
    return emptyLabel ? (
      <p className={cn('text-xs text-muted-foreground', className)}>{emptyLabel}</p>
    ) : null
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} aria-label="Active filters">
      {applied.map((filter) => {
        const value = values[filter.id]!
        const isBoolean = filter.kind === 'boolean'
        const description = isBoolean ? null : describeValue(filter, value)

        return (
          <button
            key={filter.id}
            type="button"
            onClick={() => onRemove(filter.id)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground hover:bg-accent"
            aria-label={`Remove filter: ${filter.label}`}
          >
            {isBoolean ? (
              <span className="font-medium">{filter.label}</span>
            ) : (
              <>
                <span className="text-muted-foreground">{filter.label}:</span>
                <span className="font-medium">{description}</span>
              </>
            )}
            <X className="h-3 w-3" />
          </button>
        )
      })}
    </div>
  )
}
