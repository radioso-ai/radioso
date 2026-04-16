import { describe, expect, it } from 'vitest'

import { resolveEmbedLocaleSearchParam } from '@/app/embed/[token]/page'

describe('resolveEmbedLocaleSearchParam', () => {
  it('returns the locale string when only one locale is provided', () => {
    expect(resolveEmbedLocaleSearchParam('it-IT')).toBe('it-IT')
  })

  it('uses the first locale when the query param repeats', () => {
    expect(resolveEmbedLocaleSearchParam(['it-IT', 'fr-FR'])).toBe('it-IT')
  })
})
