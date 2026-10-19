import type { AgentBrandingSettings } from './api-types'

/** The agent's privacy notices as the API serves them, keyed by language tag. */
type AgentPrivacyNotices = NonNullable<AgentBrandingSettings['privacyNotice']>

/** The notice a visitor is shown: the operator's line and link, and the version the conversation records. */
export interface ShownPrivacyNotice {
  locale: string
  text: string
  url: string
  version: string
}

const languageOf = (tag: string): string => tag.split('-')[0]?.toLowerCase() ?? ''

/** The exact tag, else the bare language, else any tag of the same language. Tag structure only. */
const matchLocale = (tags: readonly string[], wanted: string): string | null => {
  const exact = wanted.toLowerCase()
  const language = languageOf(wanted)
  return tags.find((tag) => tag.toLowerCase() === exact)
    ?? tags.find((tag) => tag.toLowerCase() === language)
    ?? tags.find((tag) => languageOf(tag) === language)
    ?? null
}

/**
 * The notice for a visitor: in their language, else English, else the first language in tag order,
 * the same rule the backend applies to email and voice. Null when the agent wrote none.
 */
export const choosePrivacyNotice = (
  notices: AgentPrivacyNotices | null | undefined,
  locale: string | null | undefined,
): ShownPrivacyNotice | null => {
  const tags = Object.keys(notices ?? {}).sort()
  if (!notices || tags.length === 0) return null
  const wanted = [...(locale?.trim() ? [locale.trim()] : []), 'en']
  const tag = wanted.map((candidate) => matchLocale(tags, candidate)).find((match) => match !== null) ?? tags[0]
  const notice = tag ? notices[tag] : undefined
  if (!tag || !notice?.text.trim() || !notice.url.trim()) return null
  return { locale: tag, text: notice.text, url: notice.url, version: notice.version }
}

/** One language's notice as the settings card edits it. */
export interface PrivacyNoticeFormRow {
  locale: string
  text: string
  url: string
}

export const privacyNoticeRowsOf = (notices: AgentPrivacyNotices | null | undefined): PrivacyNoticeFormRow[] =>
  Object.entries(notices ?? {}).map(([locale, notice]) => ({ locale, text: notice.text, url: notice.url }))

const isWebLink = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** A row the agent can show: a line and an http or https link. */
export const isCompletePrivacyNoticeRow = (row: PrivacyNoticeFormRow): boolean =>
  row.text.trim().length > 0 && isWebLink(row.url.trim())

/**
 * The notices a save carries: the complete rows only, so a half-written one stays in the form
 * rather than failing the save. A row whose words and link are unchanged keeps its version; any
 * other has none until the save returns the one the server derives.
 */
export const privacyNoticesOf = (
  rows: readonly PrivacyNoticeFormRow[],
  stored: AgentPrivacyNotices | null | undefined,
): AgentPrivacyNotices =>
  Object.fromEntries(rows.filter(isCompletePrivacyNoticeRow).map((row) => {
    const text = row.text.trim()
    const url = row.url.trim()
    const previous = stored?.[row.locale]
    const version = previous && previous.text === text && previous.url === url ? previous.version : ''
    return [row.locale, { text, url, version }]
  }))

/** Whether two sets of notices say the same thing in the same languages; versions aside. */
export const samePrivacyNotices = (
  left: AgentPrivacyNotices | null | undefined,
  right: AgentPrivacyNotices | null | undefined,
): boolean => {
  const leftEntries = Object.entries(left ?? {})
  const rightNotices = right ?? {}
  return leftEntries.length === Object.keys(rightNotices).length
    && leftEntries.every(([locale, notice]) => rightNotices[locale]?.text === notice.text && rightNotices[locale]?.url === notice.url)
}
