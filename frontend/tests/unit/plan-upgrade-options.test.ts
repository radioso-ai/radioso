import { describe, expect, it } from 'vitest'
import { planUpgradeDestination } from '@/lib/plan-upgrade-options'

describe('planUpgradeDestination', () => {
  it.each([
    ['active', 'portal'],
    ['past_due', 'portal'],
    ['canceled', 'checkout'],
    ['none', 'checkout'],
  ] as const)('routes a %s subscriber to %s', (status, destination) => {
    expect(planUpgradeDestination(status)).toBe(destination)
  })
})
