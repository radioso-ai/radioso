'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type SegmentedControlOption<TValue extends string> = {
  value: TValue
  label: ReactNode
}

export function SegmentedControl<TValue extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
  fullWidth = false,
}: {
  value: TValue
  onValueChange: (value: TValue) => void
  options: readonly SegmentedControlOption<TValue>[]
  'aria-label'?: string
  /** Stretches the control to fill its container's width, with segments sharing the space equally, instead of the default content-width sizing. */
  fullWidth?: boolean
}) {
  return (
    <div
      className={cn('inline-flex items-center rounded-lg bg-muted p-0.5', fullWidth && 'flex w-full')}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const isSelected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium transition',
              fullWidth && 'flex-1 text-center',
              isSelected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
