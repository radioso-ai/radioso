import { describe, expect, it } from 'vitest'

import { deriveAccountUsageBanner, nearingLimitDismissalKey } from '@/lib/account-usage-banner'
import type { AccountUsageSummary, EnterpriseBillingSummary } from '@/lib/api-types'

const baseUsage = (
  overrides: Partial<NonNullable<AccountUsageSummary['monthlyConversations']>> = {},
): AccountUsageSummary => ({
  accountId: 'account-1',
  profile: null,
  monthlyAnswers: { periodStart: '2026-04-01', resetAt: '2026-05-01T00:00:00.000Z', used: 0, limit: null },
  storedDocuments: { used: 0, limit: null },
  storedIndexedBytes: { used: 0, limit: null },
  monthlyIndexedBytes: { periodStart: '2026-04-01', resetAt: '2026-05-01T00:00:00.000Z', used: 0, limit: null },
  monthlyConversations: {
    periodStart: '2026-04-01',
    resetAt: '2026-05-01T00:00:00.000Z',
    used: 400,
    limit: 1000,
    credits: 0,
    capacity: 1000,
    grace: { limit: 100, borrowed: 0 },
    level: 'ok',
    byKind: { conversation: 400, copilot: 0, test_run: 0, pulse_report: 0 },
    ...overrides,
  },
})

const baseBilling = (overrides: Partial<EnterpriseBillingSummary> = {}): EnterpriseBillingSummary => ({
  configured: true,
  planId: 'satellite',
  planName: 'Satellite',
  status: 'active',
  hasCustomer: true,
  interval: 'month',
  currentPeriodEnd: '2026-05-01T00:00:00.000Z',
  upgradePlanId: 'planet',
  topUpAvailable: true,
  ...overrides,
})

describe('deriveAccountUsageBanner', () => {
  it('shows nothing when usage is ok and billing is active', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'ok' }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result).toBeNull()
  })

  it('shows nothing when usage and billing have not loaded yet', () => {
    const result = deriveAccountUsageBanner({
      usage: null,
      billing: null,
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result).toBeNull()
  })

  it('shows nothing for an answer-metered profile (monthlyConversations null)', () => {
    const result = deriveAccountUsageBanner({
      usage: { ...baseUsage(), monthlyConversations: null },
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result).toBeNull()
  })

  it('hides every level on the account usage tab itself', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'limit_reached' }),
      billing: baseBilling({ status: 'past_due' }),
      isOnUsageTab: true,
      isNearingLimitDismissed: false,
    })
    expect(result).toBeNull()
  })

  it('past_due takes precedence over grace_exhausted', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'grace_exhausted', used: 1100, capacity: 1100, grace: { limit: 100, borrowed: 100 } }),
      billing: baseBilling({ status: 'past_due' }),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result?.level).toBe('past_due')
    expect(result?.tone).toBe('destructive')
    expect(result?.dismissible).toBe(false)
    expect(result?.actionLabel).toBe('Manage billing')
  })

  it('does not treat an unconfigured billing module as past_due (OSS/unconfigured)', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'ok' }),
      billing: baseBilling({ configured: false, status: 'past_due' }),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result).toBeNull()
  })

  it('grace_exhausted takes precedence over limit_reached', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'grace_exhausted', used: 1100, capacity: 1100, grace: { limit: 100, borrowed: 100 } }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result?.level).toBe('grace_exhausted')
    expect(result?.tone).toBe('destructive')
    expect(result?.dismissible).toBe(false)
    expect(result?.message).toContain('stopped answering visitors')
  })

  it('limit_reached names the remaining grace allowance and is not dismissible', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'limit_reached', used: 1000, capacity: 1000, grace: { limit: 100, borrowed: 20 } }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result?.level).toBe('limit_reached')
    expect(result?.tone).toBe('warning')
    expect(result?.dismissible).toBe(false)
    expect(result?.message).toContain('up to 80 extra conversations')
  })

  it('nearing_limit reports the usage percent and is dismissible', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'nearing_limit', used: 850, capacity: 1000 }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: false,
    })
    expect(result?.level).toBe('nearing_limit')
    expect(result?.tone).toBe('default')
    expect(result?.dismissible).toBe(true)
    expect(result?.message).toContain("You've used 85%")
  })

  it('hides nearing_limit once dismissed for the period', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'nearing_limit', used: 850, capacity: 1000 }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: true,
    })
    expect(result).toBeNull()
  })

  it('a higher-precedence level still shows even though nearing_limit was dismissed', () => {
    const result = deriveAccountUsageBanner({
      usage: baseUsage({ level: 'limit_reached', used: 1000, capacity: 1000 }),
      billing: baseBilling(),
      isOnUsageTab: false,
      isNearingLimitDismissed: true,
    })
    expect(result?.level).toBe('limit_reached')
  })
})

describe('nearingLimitDismissalKey', () => {
  it('scopes the dismissal key to the billing period', () => {
    expect(nearingLimitDismissalKey('2026-04-01')).toContain('2026-04-01')
    expect(nearingLimitDismissalKey('2026-04-01')).not.toBe(nearingLimitDismissalKey('2026-05-01'))
  })
})
