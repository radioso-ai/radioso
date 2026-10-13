import { describe, expect, it } from 'vitest'
import { planUpgradeOptions } from '@/lib/plan-upgrade-options'

describe('planUpgradeOptions', () => {
  it('offers both Planet credential policies from Satellite', () => {
    expect(planUpgradeOptions('satellite', ['planet', 'planet_managed'])).toEqual([
      { planId: 'planet', label: 'Planet — bring your own provider keys', requiresWorkspaceKey: true },
      { planId: 'planet_managed', label: "Planet with Radioso's models", requiresWorkspaceKey: false },
    ])
  })
})
