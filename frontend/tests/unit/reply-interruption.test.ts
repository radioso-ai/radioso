import { describe, expect, it } from 'vitest'

import { heardPercent } from '@/lib/reply-interruption'

describe('heardPercent', () => {
  it('states the share of the spoken reply the caller heard', () => {
    expect(heardPercent(20, 40)).toBe(50)
    expect(heardPercent(0, 40)).toBe(0)
    expect(heardPercent(40, 40)).toBe(100)
  })

  it('rounds to a whole percentage', () => {
    expect(heardPercent(23, 62)).toBe(37)
    expect(heardPercent(1, 8)).toBe(13)
    expect(heardPercent(1, 3)).toBe(33)
  })

  it('never states more than all of the reply', () => {
    expect(heardPercent(50, 40)).toBe(100)
  })

  it('states no share when nothing was spoken', () => {
    expect(heardPercent(0, 0)).toBeUndefined()
    expect(heardPercent(5, 0)).toBeUndefined()
  })
})
