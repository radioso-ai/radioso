// Pure math for the dashboard plan card: usage percent, threshold banding, and which
// `byKind` bucket is driving this month's usage. Kept separate from plan-card.tsx so the
// arithmetic is unit-testable without mounting a component.

import type { PlanUsageLevel } from './api-types'

export type PlanUsageKind = 'conversation' | 'copilot' | 'test_run' | 'pulse_report'


interface PlanUsageBucket {
  used: number
  capacity: number
}

/** Display labels for the four kinds the account usage response breaks conversations into. */
export const PLAN_USAGE_KIND_LABELS: Readonly<Record<PlanUsageKind, string>> = {
  conversation: 'Customer conversations',
  copilot: 'Ray',
  test_run: 'Test runs',
  pulse_report: 'Pulse',
}

/** `used / capacity` as a percent, clamped to [0, 100]. The server computes `capacity`
 *  (plan allowance plus positive credits); a stale client-side `limit + credits` denominator
 *  reads wrong once credits are partly spent, since credits shrink as overshoot consumes them. */
export const planUsagePercent = (bucket: PlanUsageBucket): number => {
  if (bucket.capacity <= 0) {
    return 0
  }

  return Math.min(100, Math.max(0, Math.round((bucket.used / bucket.capacity) * 100)))
}

/** Whether this level's banner carries the Upgrade/Buy actions — both unresolved states a
 *  top-up or upgrade can fix, as opposed to `nearing_limit`'s plain heads-up. */
export const planUsageLevelHasActions = (level: PlanUsageLevel): boolean =>
  level === 'limit_reached' || level === 'grace_exhausted'

const formatResetDate = (value: string): string =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value))

const formatConversationCount = (value: number): string => new Intl.NumberFormat('en').format(value)

/**
 * One short, present-tense sentence for a level whose meaning holds regardless of which kind is
 * driving usage. `nearing_limit` has no fixed sentence here — the plan card names whichever kind
 * (`largestPlanUsageKind`) is using the month's budget instead — and `ok` shows no banner at all.
 */
export const planUsageLevelMessage = (input: {
  level: PlanUsageLevel
  graceRemaining: number
  resetAt: string
}): string | null => {
  const resetDate = formatResetDate(input.resetAt)
  switch (input.level) {
    case 'limit_reached':
      return `Plan allowance used. Visitors get up to ${formatConversationCount(input.graceRemaining)} extra conversations; Ray, Test Chat, and Pulse pause until ${resetDate}.`
    case 'grace_exhausted':
      return `Agents stopped answering visitors. They resume on ${resetDate}.`
    case 'nearing_limit':
    case 'ok':
      return null
  }
}

/** The kind with the largest share of this month's usage, or null when every kind is at 0. */
export const largestPlanUsageKind = (
  byKind: Readonly<Record<PlanUsageKind, number>>,
): PlanUsageKind | null => {
  const kinds = Object.keys(byKind) as PlanUsageKind[]
  let winner: PlanUsageKind | null = null
  let winnerValue = 0

  for (const kind of kinds) {
    const value = byKind[kind]
    if (value > winnerValue) {
      winner = kind
      winnerValue = value
    }
  }

  return winner
}

/**
 * Mirrors `@radioso/plan-catalog`'s `formatPrice`. Duplicated rather than imported: the
 * frontend consumes plan numbers over `GET /plans`, never the EE-only catalog package.
 */
export const formatPlanPriceCents = (cents: number, currency: string): string => {
  const isWhole = cents % 100 === 0
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(cents / 100)
}
