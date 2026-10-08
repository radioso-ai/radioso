import { describe, expect, it } from 'vitest'

import {
  formatPlanPriceCents,
  largestPlanUsageKind,
  planUsageLevelHasActions,
  planUsageLevelMessage,
  planUsagePercent,
} from '@/lib/plan-card-usage'

describe('planUsagePercent', () => {
  it('divides used by the server-computed capacity', () => {
    expect(planUsagePercent({ used: 250, capacity: 1000 })).toBe(25)
    expect(planUsagePercent({ used: 250, capacity: 1000 })).toBe(25)
  })

  it('clamps to 100 when usage exceeds capacity', () => {
    expect(planUsagePercent({ used: 1200, capacity: 1000 })).toBe(100)
  })

  it('treats zero capacity as 0 rather than dividing by zero', () => {
    expect(planUsagePercent({ used: 0, capacity: 0 })).toBe(0)
  })
})

describe('planUsageLevelHasActions', () => {
  it('is false for ok and nearing_limit', () => {
    expect(planUsageLevelHasActions('ok')).toBe(false)
    expect(planUsageLevelHasActions('nearing_limit')).toBe(false)
  })

  it('is true for limit_reached and grace_exhausted, both fixable with a top-up or upgrade', () => {
    expect(planUsageLevelHasActions('limit_reached')).toBe(true)
    expect(planUsageLevelHasActions('grace_exhausted')).toBe(true)
  })
})

describe('planUsageLevelMessage', () => {
  it('has no fixed sentence for ok or nearing_limit', () => {
    expect(planUsageLevelMessage({ level: 'ok', graceRemaining: 5, resetAt: '2026-05-01T00:00:00.000Z' })).toBeNull()
    expect(planUsageLevelMessage({ level: 'nearing_limit', graceRemaining: 5, resetAt: '2026-05-01T00:00:00.000Z' })).toBeNull()
  })

  it('names the remaining grace and reset date for limit_reached', () => {
    const message = planUsageLevelMessage({ level: 'limit_reached', graceRemaining: 100, resetAt: '2026-05-01T00:00:00.000Z' })
    expect(message).toContain('100 extra conversations')
    expect(message).toContain('May 1, 2026')
    expect(message).not.toContain('!')
  })

  it('names the reset date for grace_exhausted, without a grace figure', () => {
    const message = planUsageLevelMessage({ level: 'grace_exhausted', graceRemaining: 0, resetAt: '2026-06-01T00:00:00.000Z' })
    expect(message).toContain('Jun 1, 2026')
    expect(message).not.toContain('!')
  })
})

describe('largestPlanUsageKind', () => {
  it('returns the kind with the highest count', () => {
    expect(
      largestPlanUsageKind({ conversation: 40, copilot: 2, test_run: 0.5, pulse_report: 0 }),
    ).toBe('conversation')
  })

  it('picks the first max on a tie', () => {
    expect(
      largestPlanUsageKind({ conversation: 5, copilot: 5, test_run: 0, pulse_report: 0 }),
    ).toBe('conversation')
  })

  it('returns null when every kind is at zero', () => {
    expect(
      largestPlanUsageKind({ conversation: 0, copilot: 0, test_run: 0, pulse_report: 0 }),
    ).toBeNull()
  })
})

describe('formatPlanPriceCents', () => {
  it('formats whole amounts without decimals', () => {
    expect(formatPlanPriceCents(14900, 'EUR')).toBe('€149')
  })

  it('formats fractional amounts with two decimals', () => {
    expect(formatPlanPriceCents(4999, 'EUR')).toBe('€49.99')
  })
})
