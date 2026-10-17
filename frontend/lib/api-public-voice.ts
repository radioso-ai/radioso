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
const startedSessionOf = ({ vendor, signedUrl, sessionKey, locale }: PublicVoiceSessionResponse): StartedVoiceSession =>
  ({ vendor, signedUrl, sessionKey, locale })

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
