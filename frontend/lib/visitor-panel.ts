import type { ChatConversationDetail } from './api-types'
import { parsePrimaryLanguageTag, parseUserAgent } from './visitor-request-facts'

/**
 * Display-ready view of the Visitor panel (spec 1277, FR-042), derived once from the
 * conversation detail DTO so the component itself only renders. Null fields render as
 * unknown ("—") in the component; this adapter only ever returns `null` for a field it
 * has no fact for.
 */
interface VisitorPanelViewModel {
  visitorId: string | null
  firstSeenAt: string | null
  conversationCount: number | null
  verified: boolean | null
  country: string | null
  region: string | null
  city: string | null
  browser: string | null
  os: string | null
  rawUserAgent: string | null
  language: string | null
  entryPageUrl: string | null
  referrer: string | null
  clientIp: string | null
  /** The edge marker was present but did not verify — every request fact is null, not a guess. */
  unverifiedRequestFacts: boolean
  /** Previous conversations beyond the current one, or null when there is no visitor. */
  previousConversationsTotal: number | null
  /** True when previousConversationsTotal exceeds the five the panel lists directly. */
  showSeeAllPreviousConversations: boolean
}

type VisitorPanelSourceConversation = Pick<
  ChatConversationDetail,
  'visitor' | 'requestContext' | 'entryPageUrl' | 'entryReferrer'
>

const PREVIOUS_CONVERSATIONS_LISTED = 5

/**
 * Builds the Visitor panel's view model, or `null` when the conversation carries neither a
 * visitor nor a request context — the panel renders only then (FR-042).
 */
export const buildVisitorPanelViewModel = (
  conversation: VisitorPanelSourceConversation,
): VisitorPanelViewModel | null => {
  const { visitor, requestContext } = conversation
  if (!visitor && !requestContext) {
    return null
  }

  const { browser, os } = parseUserAgent(requestContext?.userAgent ?? null)
  const previousConversationsTotal = visitor ? Math.max(0, visitor.conversationCount - 1) : null

  return {
    visitorId: visitor?.id ?? null,
    firstSeenAt: visitor?.firstSeenAt ?? null,
    conversationCount: visitor?.conversationCount ?? null,
    verified: visitor?.verified ?? null,
    country: requestContext?.country ?? null,
    region: requestContext?.region ?? null,
    city: requestContext?.city ?? null,
    browser,
    os,
    rawUserAgent: requestContext?.userAgent ?? null,
    language: parsePrimaryLanguageTag(requestContext?.acceptLanguage ?? null),
    entryPageUrl: conversation.entryPageUrl ?? null,
    referrer: conversation.entryReferrer ?? null,
    clientIp: requestContext?.clientIp ?? null,
    unverifiedRequestFacts: requestContext?.observedVia === 'unproven',
    previousConversationsTotal,
    showSeeAllPreviousConversations:
      previousConversationsTotal !== null && previousConversationsTotal > PREVIOUS_CONVERSATIONS_LISTED,
  }
}
