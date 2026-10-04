import { describe, expect, it } from 'vitest'

import { parseWalkInBudget, resolvePublicAccessToggles } from '@/components/dashboard/settings/walk-in-access-section'

describe('resolvePublicAccessToggles', () => {
  const off = { agentCardEnabled: false, publicAgentAccessEnabled: false }

  it('publishes the card when walk-in access is opened', () => {
    expect(resolvePublicAccessToggles(off, { publicAgentAccessEnabled: true }))
      .toEqual({ agentCardEnabled: true, publicAgentAccessEnabled: true })
  })

  it('closes walk-in access when the card comes down', () => {
    const open = { agentCardEnabled: true, publicAgentAccessEnabled: true }

    expect(resolvePublicAccessToggles(open, { agentCardEnabled: false }))
      .toEqual({ agentCardEnabled: false, publicAgentAccessEnabled: false })
  })

  it('leaves walk-in access alone when only the card is published', () => {
    expect(resolvePublicAccessToggles(off, { agentCardEnabled: true }))
      .toEqual({ agentCardEnabled: true, publicAgentAccessEnabled: false })
  })

  it('keeps the card up when walk-in access is closed on its own', () => {
    const open = { agentCardEnabled: true, publicAgentAccessEnabled: true }

    expect(resolvePublicAccessToggles(open, { publicAgentAccessEnabled: false }))
      .toEqual({ agentCardEnabled: true, publicAgentAccessEnabled: false })
  })
})

describe('parseWalkInBudget', () => {
  it('reads an empty field as no override', () => {
    expect(parseWalkInBudget('')).toBeNull()
    expect(parseWalkInBudget('   ')).toBeNull()
  })

  it('accepts a whole number inside the allowed range', () => {
    expect(parseWalkInBudget('40')).toBe(40)
    expect(parseWalkInBudget(' 1 ')).toBe(1)
    expect(parseWalkInBudget('100000')).toBe(100_000)
  })

  it('rejects anything the backend would refuse', () => {
    expect(parseWalkInBudget('0')).toBeUndefined()
    expect(parseWalkInBudget('2.5')).toBeUndefined()
    expect(parseWalkInBudget('-4')).toBeUndefined()
    expect(parseWalkInBudget('100001')).toBeUndefined()
    expect(parseWalkInBudget('many')).toBeUndefined()
  })
})
