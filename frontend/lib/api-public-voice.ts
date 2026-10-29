import { PUBLIC_CHAT_STREAMING_API_PATH, attachAnonymousSessionHeader } from './api-client'
import type { PublicVoiceSessionResponse } from './api-types'
import type { StartedVoiceSession, VoiceSessionStart } from './voice-call'
import { isVoiceVendor } from './voice-runtime'

/**
 * Whether a start's answer is the contract's session, checked before its URL reaches a vendor's
 * client: a vendor this page has no client for is not one.
 */
const isStartedSession = (body: unknown): body is PublicVoiceSessionResponse => {
  if (!body || typeof body !== 'object') return false
  const { vendor, signedUrl, sessionKey, locale } = body as Partial<Record<keyof PublicVoiceSessionResponse, unknown>>
  return isVoiceVendor(vendor) && typeof signedUrl === 'string' && typeof sessionKey === 'string' && typeof locale === 'string'
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/**
 * What the page keeps of the answer: the expiry is the vendor's to enforce. `firstMessage` and
 * `vendorLanguage` are kept only when the start names them, since a vendor agent that does not
 * allow either closes a session that sets it.
 */
const startedSessionOf = (
  { vendor, signedUrl, sessionKey, locale, recordingNotice, firstMessage, vendorLanguage }: PublicVoiceSessionResponse,
): StartedVoiceSession => ({
  vendor,
  signedUrl,
  sessionKey,
  locale,
  ...(hasText(recordingNotice) ? { recordingNotice } : {}),
  ...(hasText(firstMessage) ? { firstMessage } : {}),
  ...(hasText(vendorLanguage) ? { vendorLanguage } : {}),
})

/**
 * Asks Radioso to start a voice session for the website embed's visitor, with the public session
 * the embed already holds. It goes through the app host's relay, the way a chat message does, so
 * the backend sees the visitor's request source.
 */
export async function startPublicVoiceSession(token: string, input: { locale?: string }): Promise<VoiceSessionStart> {
  let response: Response
  try {
    response = await fetch(`${PUBLIC_CHAT_STREAMING_API_PATH}/${encodeURIComponent(token)}/voice/sessions`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(input.locale ? { locale: input.locale } : {}),
    })
  } catch {
    return { kind: 'refused' }
  }
  if (!response.ok) return { kind: 'refused' }
  const body: unknown = await response.json().catch(() => null)
  return isStartedSession(body) ? { kind: 'started', session: startedSessionOf(body) } : { kind: 'refused' }
}

/**
 * How a vendor conversation report ended: `recorded` (204), `refused` (Radioso will not take it for
 * this session, which a second try cannot change), or `failed` (it did not get through, or Radioso
 * could not check it now; the page may send it again).
 */
export type VoiceVendorConversationReportOutcome = 'recorded' | 'refused' | 'failed'

const reportOnce = async (url: string, token: string, vendorConversationId: string): Promise<VoiceVendorConversationReportOutcome | 'throttled'> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      // The report may be sent as the call ends, while the page closes.
      keepalive: true,
      headers: attachAnonymousSessionHeader(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ vendorConversationId }),
    })
    if (response.ok) return 'recorded'
    if (response.status === 429) return 'throttled'
    return response.status === 400 || response.status === 404 ? 'refused' : 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * Tells Radioso the vendor's id for a call the page opened, so the Inbox can play the call's
 * recording. Through the app host's relay, with the embed's public session the session was started
 * for, tried once more when it does not get through. A throttled report is not tried again at once,
 * which would meet the same budget: it reads as `failed`, for the call's end to send again. It never
 * rejects, and the call goes on whatever the answer.
 */
export async function reportVoiceVendorConversation(
  token: string,
  input: { sessionKey: string; vendorConversationId: string },
): Promise<VoiceVendorConversationReportOutcome> {
  const url = `${PUBLIC_CHAT_STREAMING_API_PATH}/${encodeURIComponent(token)}/voice/sessions/${encodeURIComponent(input.sessionKey)}/vendor-conversation`
  const first = await reportOnce(url, token, input.vendorConversationId)
  if (first === 'throttled') return 'failed'
  if (first !== 'failed') return first
  const second = await reportOnce(url, token, input.vendorConversationId)
  return second === 'throttled' ? 'failed' : second
}
