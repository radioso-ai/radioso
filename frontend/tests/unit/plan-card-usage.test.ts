import { describe, expect, it } from 'vitest'

import {
  formatPlanPriceCents,
  largestPlanUsageKind,
  planUsagePercent,
  planUsageThreshold,
} from '@/lib/plan-card-usage'

describe('planUsagePercent', () => {
  it('divides used by limit plus credits', () => {
    expect(planUsagePercent({ used: 250, limit: 1000, credits: 0 })).toBe(25)
    expect(planUsagePercent({ used: 250, limit: 500, credits: 500 })).toBe(25)
  })

  it('clamps to 100 when usage exceeds capacity', () => {
    expect(planUsagePercent({ used: 1200, limit: 1000, credits: 0 })).toBe(100)
  })

  it('treats zero capacity as 0 rather than dividing by zero', () => {
    expect(planUsagePercent({ used: 0, limit: 0, credits: 0 })).toBe(0)
  })
})

describe('planUsageThreshold', () => {
  it('is ok under 80%', () => {
    expect(planUsageThreshold({ used: 799, limit: 1000, credits: 0 })).toBe('ok')
  })

  it('is warning from 80% up to just under 100%', () => {
    expect(planUsageThreshold({ used: 800, limit: 1000, credits: 0 })).toBe('warning')
    expect(planUsageThreshold({ used: 999, limit: 1000, credits: 0 })).toBe('warning')
  })

  it('is exceeded at and beyond 100%', () => {
    expect(planUsageThreshold({ used: 1000, limit: 1000, credits: 0 })).toBe('exceeded')
    expect(planUsageThreshold({ used: 1500, limit: 1000, credits: 0 })).toBe('exceeded')
  })

  it('counts credits toward capacity', () => {
    // 1000/1000 alone would be exceeded; 500 credits push capacity to 1500, landing in warning.
    expect(planUsageThreshold({ used: 1200, limit: 1000, credits: 500 })).toBe('warning')
  })

  it('is ok when there is no capacity to measure against', () => {
    expect(planUsageThreshold({ used: 0, limit: 0, credits: 0 })).toBe('ok')
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
