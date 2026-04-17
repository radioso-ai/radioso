import { describe, expect, it } from 'vitest'

import { resolveAnonymousChatBootstrapLocale } from '@/lib/anonymous-chat-context'

describe('resolveAnonymousChatBootstrapLocale', () => {
  it('prefers a valid script-level locale override', () => {
    expect(
      resolveAnonymousChatBootstrapLocale({
        localeOverride: 'it-IT',
        browserLocales: ['en-US'],
      }),
    ).toBe('it-IT')
  })

  it('falls back to the browser locale when the override is unsupported', () => {
    expect(
      resolveAnonymousChatBootstrapLocale({
        localeOverride: 'bad_locale',
        browserLocales: ['fr-FR', 'en-US'],
      }),
    ).toBe('fr-FR')
  })

  it('returns undefined when neither override nor browser locales are usable', () => {
    expect(
      resolveAnonymousChatBootstrapLocale({
        localeOverride: 'bad_locale',
        browserLocales: ['bad locale'],
      }),
    ).toBeUndefined()
  })
})
