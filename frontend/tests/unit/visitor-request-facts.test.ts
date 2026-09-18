import { describe, expect, it } from 'vitest'

import { parsePrimaryLanguageTag, parseUserAgent } from '@/lib/visitor-request-facts'

describe('parseUserAgent', () => {
  it('returns null for both fields when the user agent is missing', () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null })
    expect(parseUserAgent(undefined)).toEqual({ browser: null, os: null })
    expect(parseUserAgent('')).toEqual({ browser: null, os: null })
  })

  it('identifies Chrome on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Windows' })
  })

  it('identifies Safari on macOS, not Chrome', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Safari', os: 'macOS' })
  })

  it('identifies Edge, not Chrome, even though Edge UAs carry a Chrome token', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Edge', os: 'Windows' })
  })

  it('identifies Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Firefox', os: 'Linux' })
  })

  it('identifies iOS, not Linux/Android, for an iPhone Safari user agent', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Safari', os: 'iOS' })
  })

  it('identifies Android, not Linux, for an Android Chrome user agent', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
    expect(parseUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Android' })
  })

  it('returns null fields for an unrecognised user agent string', () => {
    expect(parseUserAgent('SomeBot/1.0 (+https://example.com/bot)')).toEqual({ browser: null, os: null })
  })
})

describe('parsePrimaryLanguageTag', () => {
  it('extracts the primary subtag from a quality-weighted Accept-Language value', () => {
    expect(parsePrimaryLanguageTag('de-DE,de;q=0.9,en;q=0.8')).toBe('de')
  })

  it('lower-cases the primary subtag', () => {
    expect(parsePrimaryLanguageTag('EN-US')).toBe('en')
  })

  it('returns null for a missing or empty value', () => {
    expect(parsePrimaryLanguageTag(null)).toBeNull()
    expect(parsePrimaryLanguageTag(undefined)).toBeNull()
    expect(parsePrimaryLanguageTag('')).toBeNull()
  })

  it('returns null for a malformed primary subtag', () => {
    expect(parsePrimaryLanguageTag('123-DE')).toBeNull()
  })
})
