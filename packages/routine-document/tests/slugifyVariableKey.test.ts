import { describe, expect, it } from 'vitest'

import { slugifyVariableKey } from '../src/index.js'

describe('slugifyVariableKey', () => {
  it('lowercases and joins words with single underscores', () => {
    expect(slugifyVariableKey('Order Number')).toBe('order_number')
    expect(slugifyVariableKey('  customer -- e-mail  ')).toBe('customer_e_mail')
    expect(slugifyVariableKey('already_ok')).toBe('already_ok')
  })

  it('collapses runs of separators and trims them from both ends', () => {
    expect(slugifyVariableKey('___a___b___')).toBe('a_b')
    expect(slugifyVariableKey('--a--')).toBe('a')
    expect(slugifyVariableKey('a b  c')).toBe('a_b_c')
  })

  it('falls back to "value" when nothing survives', () => {
    expect(slugifyVariableKey('')).toBe('value')
    expect(slugifyVariableKey('___')).toBe('value')
    expect(slugifyVariableKey('!!! ???')).toBe('value')
  })

  it('prefixes an underscore when the key would start with a digit', () => {
    expect(slugifyVariableKey('2nd choice')).toBe('_2nd_choice')
  })

  it('reduces non-ASCII letters to separators', () => {
    expect(slugifyVariableKey('naïve café')).toBe('na_ve_caf')
  })

  it('handles a long separator run in linear time', () => {
    const startedAt = performance.now()
    expect(slugifyVariableKey(`${'_'.repeat(100_000)}x${'_'.repeat(100_000)}`)).toBe('x')
    expect(performance.now() - startedAt).toBeLessThan(200)
  })
})
