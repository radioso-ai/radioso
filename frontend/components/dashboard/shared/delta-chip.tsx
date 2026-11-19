'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'

export type DeltaTone = 'good' | 'bad' | 'neutral'

export interface DeltaChipValue {
  /** The whole line, e.g. "+6 pts vs previous 7 days". */
  text: string
  trend: 'up' | 'down' | 'flat'
  tone: DeltaTone
}

const TONE_CLASS: Record<DeltaTone, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  bad: 'text-destructive',
  neutral: 'text-muted-foreground',
}

const TREND_ICON = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
} as const

/**
 * A stat tile's change against the previous window. The arrow carries the direction, so tone is
 * never colour alone; null means there was nothing to compare against.
 */
export function DeltaChip({ delta }: { delta: DeltaChipValue | null }) {
  if (delta === null) {
    return <span className="text-xs text-muted-foreground">Not enough data to compare</span>
  }
  const Icon = TREND_ICON[delta.trend]
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_CLASS[delta.tone])}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span>{delta.text}</span>
    </span>
  )
}
