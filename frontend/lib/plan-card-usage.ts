// Pure math for the dashboard plan card: usage percent, threshold banding, and which
// `byKind` bucket is driving this month's usage. Kept separate from plan-card.tsx so the
// arithmetic is unit-testable without mounting a component.

export type PlanUsageKind = 'conversation' | 'copilot' | 'test_run' | 'pulse_report'

type PlanUsageThreshold = 'ok' | 'warning' | 'exceeded'

interface PlanUsageBucket {
  used: number
  limit: number
  credits: number
}

/** Display labels for the four kinds the account usage response breaks conversations into. */
export const PLAN_USAGE_KIND_LABELS: Readonly<Record<PlanUsageKind, string>> = {
  conversation: 'Customer conversations',
  copilot: 'Ray',
  test_run: 'Test runs',
  pulse_report: 'Pulse',
}

const capacity = (bucket: PlanUsageBucket): number => bucket.limit + bucket.credits

/** `used / (limit + credits)` as a percent, clamped to [0, 100]. Uncapped capacity reads 0. */
export const planUsagePercent = (bucket: PlanUsageBucket): number => {
  const total = capacity(bucket)
  if (total <= 0) {
    return 0
  }

  return Math.min(100, Math.max(0, Math.round((bucket.used / total) * 100)))
}

/** Under 80% is quiet, 80-99% warns, 100%+ (including over-capacity) is exceeded. */
export const planUsageThreshold = (bucket: PlanUsageBucket): PlanUsageThreshold => {
  const total = capacity(bucket)
  if (total <= 0) {
    return 'ok'
  }

  const ratio = bucket.used / total
  if (ratio >= 1) {
    return 'exceeded'
  }
  if (ratio >= 0.8) {
    return 'warning'
  }
  return 'ok'
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
