import { describe, expect, it } from 'vitest'

import {
  choosePrivacyNotice,
  privacyNoticeRowsOf,
  privacyNoticesOf,
  samePrivacyNotices,
} from '@/lib/privacy-notice'

const notices = {
  de: { text: 'Wir nutzen Ihre Nachrichten.', url: 'https://example.com/de/datenschutz', version: 'de:1111111111111111' },
  en: { text: 'We use your messages to answer you.', url: 'https://example.com/privacy', version: 'en:2222222222222222' },
  'pt-BR': { text: 'Usamos suas mensagens.', url: 'https://example.com/pt', version: 'pt-BR:3333333333333333' },
}

describe('choosing the privacy notice a visitor sees', () => {
  it("is in the visitor's language, by tag then by language", () => {
    expect(choosePrivacyNotice(notices, 'de-AT')?.locale).toBe('de')
    expect(choosePrivacyNotice(notices, 'pt')?.version).toBe('pt-BR:3333333333333333')
  })

  it('falls back to English, then to the first language, rather than to none', () => {
    expect(choosePrivacyNotice(notices, 'fr')?.locale).toBe('en')
    expect(choosePrivacyNotice({ it: notices.en, de: notices.de }, null)?.locale).toBe('de')
  })

  it('is none when the agent wrote none', () => {
    expect(choosePrivacyNotice({}, 'en')).toBeNull()
    expect(choosePrivacyNotice(undefined, 'en')).toBeNull()
  })
})

describe('the privacy notice form', () => {
  it('saves only the complete rows, keeping the version of a notice that did not change', () => {
    const rows = [
      ...privacyNoticeRowsOf({ en: notices.en, de: notices.de }),
      { locale: 'fr', text: 'Nous utilisons vos messages.', url: 'not a link yet' },
    ]
    rows[1] = { ...rows[1], text: 'Wir lesen Ihre Nachrichten.' }

    expect(privacyNoticesOf(rows, notices)).toEqual({
      en: notices.en,
      de: { text: 'Wir lesen Ihre Nachrichten.', url: notices.de.url, version: '' },
    })
  })

  it('tells a real change from a version-only difference', () => {
    expect(samePrivacyNotices({ en: { ...notices.en, version: '' } }, { en: notices.en })).toBe(true)
    expect(samePrivacyNotices({ en: notices.en }, { en: notices.en, de: notices.de })).toBe(false)
    expect(samePrivacyNotices({ en: { ...notices.en, text: 'Other.' } }, { en: notices.en })).toBe(false)
  })
})
