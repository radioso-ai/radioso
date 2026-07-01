import { describe, expect, it } from 'vitest'

import {
  BUILT_IN_EMBED_LOCALE_PACKS,
  TRANSLATABLE_COPY_KEYS,
  parseAcceptLanguageLocales,
  pickBuiltInEmbedLocale,
  resolveBuiltInEmbedCopy,
} from '@/lib/embed-locale-packs'
import { DEFAULT_WEBSITE_EMBED_COPY, getWebsiteEmbedCopy } from '@/lib/embed-widget'
import { resolveEmbedLocaleOverride } from '@/lib/embed-locale'

describe('built-in embed locale packs', () => {
  const locales = Object.keys(BUILT_IN_EMBED_LOCALE_PACKS)

  it('ships the ten documented locales', () => {
    expect(locales.sort()).toEqual(['de', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'ru', 'zh'])
  })

  it('translates every required copy key in every locale', () => {
    for (const locale of locales) {
      const pack = BUILT_IN_EMBED_LOCALE_PACKS[locale]
      for (const key of TRANSLATABLE_COPY_KEYS) {
        expect(pack[key], `${locale}.${key}`).toBeTruthy()
      }
    }
  })

  it('keeps every required key aligned with the in-frame copy contract', () => {
    for (const key of TRANSLATABLE_COPY_KEYS) {
      expect(DEFAULT_WEBSITE_EMBED_COPY).toHaveProperty(key)
    }
  })

  it('resolves an exact locale pack', () => {
    expect(resolveBuiltInEmbedCopy(['de']).publicChatSendMessageLabel).toBe('Nachricht senden')
  })

  it('falls back from a regional tag to its base language', () => {
    expect(pickBuiltInEmbedLocale(['fr-CA'])).toBe('fr')
    expect(resolveBuiltInEmbedCopy(['fr-CA']).publicChatEmptyTitle).toBe('Commencer une conversation')
  })

  it('prefers the first candidate that has a pack', () => {
    expect(pickBuiltInEmbedLocale(['sv', 'xx-YY', 'ja'])).toBe('ja')
  })

  it('treats English as a terminal baseline over lower-priority packs', () => {
    // English outranks French: keep the English baseline, do not fall to French.
    expect(pickBuiltInEmbedLocale(['en-US', 'en', 'fr'])).toBeNull()
    // A lower-priority translated language still wins when it outranks English.
    expect(pickBuiltInEmbedLocale(['fr', 'en'])).toBe('fr')
    // An untranslated non-English top choice still falls through to a pack.
    expect(pickBuiltInEmbedLocale(['sv', 'fr', 'en'])).toBe('fr')
  })

  it('returns nothing for unknown or empty candidates', () => {
    expect(pickBuiltInEmbedLocale(['sv', '', null, undefined])).toBeNull()
    expect(resolveBuiltInEmbedCopy(['sv'])).toEqual({})
  })

  it('never leaks the launcher-only teaser into in-frame copy', () => {
    expect(resolveBuiltInEmbedCopy(['es'])).not.toHaveProperty('proactiveGreetingTeaser')
  })
})

describe('getWebsiteEmbedCopy locale resolution', () => {
  it('localizes the whole in-frame chrome from a locale tag', () => {
    const copy = getWebsiteEmbedCopy('de', undefined)
    expect(copy.publicChatSendMessageLabel).toBe('Nachricht senden')
    expect(copy.publicChatContactHumanLabel).toBe('Mit einem Menschen sprechen')
    expect(copy.skillReceiptSubmittedLabel).toBe('Gesendet')
  })

  it('keeps the English baseline when no locale matches', () => {
    expect(getWebsiteEmbedCopy('sv', undefined)).toEqual(DEFAULT_WEBSITE_EMBED_COPY)
    expect(getWebsiteEmbedCopy(undefined, undefined)).toEqual(DEFAULT_WEBSITE_EMBED_COPY)
  })

  it('lets explicit overrides win over the built-in pack', () => {
    const copy = getWebsiteEmbedCopy('de', { publicChatSendMessageLabel: 'Custom' })
    expect(copy.publicChatSendMessageLabel).toBe('Custom')
    // Untouched keys still come from the German pack.
    expect(copy.publicChatContactHumanLabel).toBe('Mit einem Menschen sprechen')
  })
})

describe('accept-language resolution', () => {
  it('orders tags by q-value and drops wildcards', () => {
    expect(parseAcceptLanguageLocales('fr-CA,en;q=0.8,de;q=0.9,*;q=0.1')).toEqual(['fr-CA', 'de', 'en'])
  })

  it('drops entries the client explicitly rejects with q=0', () => {
    expect(parseAcceptLanguageLocales('sv-SE,fr;q=0')).toEqual(['sv-SE'])
    // A rejected language must not be selected even though it has a pack.
    expect(resolveEmbedLocaleOverride({ param: undefined, acceptLanguage: 'sv-SE,fr;q=0' })).toBe('sv-SE')
  })

  it('treats an explicit param as authoritative', () => {
    expect(resolveEmbedLocaleOverride({ param: 'de', acceptLanguage: 'fr-FR' })).toBe('de')
  })

  it('falls back to the first Accept-Language pack match', () => {
    expect(resolveEmbedLocaleOverride({ param: undefined, acceptLanguage: 'sv,fr-FR;q=0.8' })).toBe('fr')
  })

  it('keeps English-preferring visitors on the English baseline', () => {
    // The English preference outranks French, so return English (baseline UI +
    // English reply hint), never French.
    expect(resolveEmbedLocaleOverride({ param: undefined, acceptLanguage: 'en-US,en;q=0.9,fr;q=0.8' })).toBe('en-US')
  })

  it('keeps the top language as a reply hint even without a pack', () => {
    expect(resolveEmbedLocaleOverride({ param: undefined, acceptLanguage: 'sv-SE,sv;q=0.9' })).toBe('sv-SE')
  })

  it('resolves to undefined without any signal', () => {
    expect(resolveEmbedLocaleOverride({ param: undefined, acceptLanguage: null })).toBeUndefined()
  })
})
