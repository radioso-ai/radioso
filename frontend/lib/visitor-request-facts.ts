/**
 * Pure, dependency-free parsing for the Visitor panel's request-derived display facts
 * (spec 1277, FR-042). Structural parsing only, over well-known protocol tokens
 * (`User-Agent` product tokens, BCP 47 language tags) — not product vocabulary.
 */

interface ParsedUserAgent {
  browser: string | null
  os: string | null
}

const BROWSER_TOKENS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // Order matters: Edge and Opera UAs also carry a Chrome token, and Chrome UAs also
  // carry a Safari token, so the more specific token must be checked first.
  { pattern: /Edg\//, label: 'Edge' },
  { pattern: /OPR\//, label: 'Opera' },
  { pattern: /Firefox\//, label: 'Firefox' },
  { pattern: /Chrome\//, label: 'Chrome' },
  { pattern: /Safari\//, label: 'Safari' },
]

const OS_TOKENS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // iOS and Android UAs also carry Linux-family tokens, so check them first.
  { pattern: /iPhone|iPad|iPod/, label: 'iOS' },
  { pattern: /Android/, label: 'Android' },
  { pattern: /Windows NT/, label: 'Windows' },
  { pattern: /Mac OS X/, label: 'macOS' },
  { pattern: /Linux/, label: 'Linux' },
]

const matchFirst = (userAgent: string, tokens: ReadonlyArray<{ pattern: RegExp; label: string }>): string | null =>
  tokens.find((token) => token.pattern.test(userAgent))?.label ?? null

/** Browser and OS family from a raw `User-Agent` string. Either is `null` when unrecognised. */
export const parseUserAgent = (userAgent: string | null | undefined): ParsedUserAgent => {
  if (!userAgent) {
    return { browser: null, os: null }
  }

  return {
    browser: matchFirst(userAgent, BROWSER_TOKENS),
    os: matchFirst(userAgent, OS_TOKENS),
  }
}

// BCP 47 primary subtags are 1-8 ASCII letters; this is a structural format check, not a
// language allowlist. Mirrors the backend's primaryLanguageTag (backend/src/modules/context-variables/visitorRequestFacts.ts).
const PRIMARY_LANGUAGE_SUBTAG_PATTERN = /^[a-zA-Z]{1,8}$/

/**
 * The primary tag of an `Accept-Language` header value: the first language-range, its
 * quality/`;`-parameters stripped, then only its primary subtag (before the first `-`).
 * `"de-DE,de;q=0.9"` -> `"de"`. A malformed or empty value resolves to `null`.
 */
export const parsePrimaryLanguageTag = (acceptLanguage: string | null | undefined): string | null => {
  if (typeof acceptLanguage !== 'string') {
    return null
  }
  const firstRange = acceptLanguage.split(',')[0]?.trim()
  if (!firstRange) {
    return null
  }
  const withoutQuality = firstRange.split(';')[0]?.trim()
  if (!withoutQuality) {
    return null
  }
  const primary = withoutQuality.split('-')[0]?.trim()
  if (!primary || !PRIMARY_LANGUAGE_SUBTAG_PATTERN.test(primary)) {
    return null
  }
  return primary.toLowerCase()
}
