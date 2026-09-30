import { describe, expect, it } from 'vitest'

import { teammateLabel } from '@/lib/teammate-label'

describe('teammateLabel', () => {
  it('names a teammate by display name', () => {
    expect(teammateLabel({ displayName: 'Ada Lovelace', email: 'ada@example.com' })).toBe('Ada Lovelace')
  })

  it('falls back to the email when no display name is set or known', () => {
    expect(teammateLabel({ displayName: null, email: 'ada@example.com' })).toBe('ada@example.com')
    expect(teammateLabel({ email: 'ada@example.com' })).toBe('ada@example.com')
  })
})
