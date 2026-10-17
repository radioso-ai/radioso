import { describe, expect, it } from 'vitest'

import { heardPercent } from '@/lib/reply-interruption'

describe('heardPercent', () => {
  it('states the share of the spoken reply the caller heard', () => {
    expect(heardPercent(20, 40)).toBe(50)
    expect(heardPercent(0, 40)).toBe(0)
  })

  it('rounds the share down', () => {
    expect(heardPercent(23, 62)).toBe(37)
    expect(heardPercent(2, 3)).toBe(66)
    expect(heardPercent(1, 8)).toBe(12)
  })

  it('stays below all of the reply while any of it went unheard', () => {
    expect(heardPercent(995, 1000)).toBe(99)
    expect(heardPercent(999, 1000)).toBe(99)
  })

  it('states all of the reply only when the caller heard all of it', () => {
    expect(heardPercent(40, 40)).toBe(100)
    expect(heardPercent(50, 40)).toBe(100)
  })

  it('states no share when nothing was spoken', () => {
    expect(heardPercent(0, 0)).toBeUndefined()
    expect(heardPercent(5, 0)).toBeUndefined()
  })
})
