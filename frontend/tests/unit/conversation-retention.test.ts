import { describe, expect, it } from 'vitest'

import {
  parseCustomRetentionDays,
  retentionChoiceFor,
  retentionErasesSooner,
} from '@/lib/conversation-retention'

describe('conversation retention choices', () => {
  it('shows a stored preset by name and any other window as custom', () => {
    expect(retentionChoiceFor(null)).toBe('off')
    expect(retentionChoiceFor(365)).toBe('365')
    expect(retentionChoiceFor(45)).toBe('custom')
  })

  it('accepts a custom window only as whole days from 7 to 3650', () => {
    expect(parseCustomRetentionDays(' 45 ')).toBe(45)
    expect(parseCustomRetentionDays('7')).toBe(7)
    expect(parseCustomRetentionDays('3650')).toBe(3650)
    expect(parseCustomRetentionDays('6')).toBeNull()
    expect(parseCustomRetentionDays('3651')).toBeNull()
    expect(parseCustomRetentionDays('30.5')).toBeNull()
    expect(parseCustomRetentionDays('')).toBeNull()
  })

  it('asks for confirmation only when the save lets the sweep erase conversations sooner', () => {
    expect(retentionErasesSooner(null, 365)).toBe(true)
    expect(retentionErasesSooner(365, 90)).toBe(true)
    expect(retentionErasesSooner(90, 365)).toBe(false)
    expect(retentionErasesSooner(90, null)).toBe(false)
    expect(retentionErasesSooner(90, 90)).toBe(false)
  })
})
