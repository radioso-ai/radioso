// Pure derivation for the dashboard-wide usage/billing banner. No fetching, no storage, no
// React: inputs in, a banner descriptor or null out, so the precedence and copy rules are
// unit-testable without mounting anything.

import type { AccountUsageSummary, EnterpriseBillingSummary } from './api-types'
import { planUsagePercent } from './plan-card-usage'

type AccountUsageBannerLevel = 'past_due' | 'grace_exhausted' | 'limit_reached' | 'nearing_limit'
type AccountUsageBannerTone = 'default' | 'warning' | 'destructive'

export interface AccountUsageBannerDescriptor {
  level: AccountUsageBannerLevel
  tone: AccountUsageBannerTone
  message: string
  actionLabel: string
  dismissible: boolean
}

const TONE_BY_LEVEL: Readonly<Record<AccountUsageBannerLevel, AccountUsageBannerTone>> = {
  past_due: 'destructive',
  grace_exhausted: 'destructive',
  limit_reached: 'warning',
  nearing_limit: 'default',
}

/**
 * localStorage key for a dismissed `nearing_limit` banner, scoped to the account and the billing
 * period: per-period so a new period re-shows the heads-up even though last period's dismissal is
 * still in storage, and per-account so dismissing one account's banner (localStorage is shared
 * across a browser, not per-account) never hides a different account's.
 */
export const nearingLimitDismissalKey = (accountId: string, periodStart: string): string =>
  `radioso:account-usage-banner:nearing-limit-dismissed:${accountId}:${periodStart}`

/**
 * Precedence: past_due > grace_exhausted > limit_reached > nearing_limit. Hidden on the account
 * usage tab (the plan card there already shows the state) and when there is nothing to report.
 */
export function deriveAccountUsageBanner(input: {
  usage: AccountUsageSummary | null
  billing: EnterpriseBillingSummary | null
  isOnUsageTab: boolean
  isNearingLimitDismissed: boolean
}): AccountUsageBannerDescriptor | null {
  if (input.isOnUsageTab) {
    return null
  }

  if (input.billing?.configured && input.billing.status === 'past_due') {
    return {
      level: 'past_due',
      tone: TONE_BY_LEVEL.past_due,
      message: "Your last payment didn't go through. Update your billing details to keep your plan.",
      actionLabel: 'Manage billing',
      dismissible: false,
    }
  }

  const monthlyConversations = input.usage?.monthlyConversations ?? null
  if (!monthlyConversations) {
    return null
  }

  if (monthlyConversations.level === 'grace_exhausted') {
    return {
      level: 'grace_exhausted',
      tone: TONE_BY_LEVEL.grace_exhausted,
      message: "Agents stopped answering visitors. This month's conversations are used up.",
      actionLabel: 'Add conversations',
      dismissible: false,
    }
  }

  if (monthlyConversations.level === 'limit_reached') {
    const graceRemaining = monthlyConversations.grace.limit - monthlyConversations.grace.borrowed
    return {
      level: 'limit_reached',
      tone: TONE_BY_LEVEL.limit_reached,
      message: `This month's conversations are used up. Visitors get up to ${graceRemaining} extra conversations; Ray, Test Chat, and Pulse are paused.`,
      actionLabel: 'Review usage',
      dismissible: false,
    }
  }

  if (monthlyConversations.level === 'nearing_limit') {
    if (input.isNearingLimitDismissed) {
      return null
    }

    const percent = planUsagePercent(monthlyConversations)
    return {
      level: 'nearing_limit',
      tone: TONE_BY_LEVEL.nearing_limit,
      message: `You've used ${percent}% of this month's conversations.`,
      actionLabel: 'Review usage',
      dismissible: true,
    }
  }

  return null
}
