import { describe, expect, it } from 'vitest'
import { planUpgradeDestination, planUpgradeOptions } from '@/lib/plan-upgrade-options'

describe('planUpgradeOptions', () => {
  it('offers both Planet credential policies from Satellite', () => {
    expect(planUpgradeOptions('satellite', ['planet', 'planet_managed'])).toEqual([
      { planId: 'planet', label: 'Planet — bring your own provider keys', requiresWorkspaceKey: true },
      { planId: 'planet_managed', label: "Planet with Radioso's models", requiresWorkspaceKey: false },
    ])
  })

  it('labels the managed-model choice from Planet without presenting it as a ladder step', () => {
    expect(planUpgradeOptions('planet', ['planet_managed'])).toEqual([
      { planId: 'planet_managed', label: "Planet with Radioso's models", requiresWorkspaceKey: false },
    ])
  })

  it.each([
    ['active', 'portal'],
    ['past_due', 'portal'],
    ['canceled', 'checkout'],
    ['none', 'checkout'],
  ] as const)('routes a %s subscriber to %s', (status, destination) => {
    expect(planUpgradeDestination(status)).toBe(destination)
  })
})
