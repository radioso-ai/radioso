import type { WebsiteEmbedPageContext } from '@/lib/api-types'

// IANA names run to about 32 characters; the backend drops anything longer than this.
const TIME_ZONE_MAX_LENGTH = 64

/** The IANA zone this browser reports, or null when it reports none. */
const browserTimeZone = (): string | null => {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof timeZone === 'string' && timeZone.length > 0 && timeZone.length <= TIME_ZONE_MAX_LENGTH
      ? timeZone
      : null
  } catch {
    return null
  }
}

/**
 * Adds the visitor's browser zone to a public chat request's page context, so "today",
 * "tomorrow" and "this weekend" resolve in the visitor's own day. Read where the chat runs (the
 * embed's frame or the hosted chat page), which is the visitor's browser either way.
 */
export const withBrowserTimeZone = <T extends { pageContext?: WebsiteEmbedPageContext | null }>(request: T): T => {
  const timeZone = browserTimeZone()
  return timeZone ? { ...request, pageContext: { ...request.pageContext, browserTimeZone: timeZone } } : request
}
