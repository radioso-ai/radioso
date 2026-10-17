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

/** What the page keeps of the answer: the expiry is the vendor's to enforce. */
const startedSessionOf = ({ vendor, signedUrl, sessionKey, locale, recordingNotice }: PublicVoiceSessionResponse): StartedVoiceSession =>
  ({ vendor, signedUrl, sessionKey, locale, ...(typeof recordingNotice === 'string' && recordingNotice.trim() ? { recordingNotice } : {}) })


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
 * Tells Radioso the vendor's id for a call the page opened, so the Inbox can play the call's
 * recording. Through the app host's relay, with the embed's public session the session was started
 * for. Best effort: it never rejects, and the call goes on whatever the answer.
 */
export async function reportVoiceVendorConversation(
  token: string,
  input: { sessionKey: string; vendorConversationId: string },
): Promise<void> {
  try {
    await fetch(
      `${PUBLIC_CHAT_STREAMING_API_PATH}/${encodeURIComponent(token)}/voice/sessions/${encodeURIComponent(input.sessionKey)}/vendor-conversation`,
      {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: attachAnonymousSessionHeader(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ vendorConversationId: input.vendorConversationId }),
      },
    )
  } catch {
    // The recording stays unnamed; the call is unaffected.
  }
}
