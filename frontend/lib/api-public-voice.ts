import { PUBLIC_CHAT_STREAMING_API_PATH, attachAnonymousSessionHeader } from './api-client'
import type { StartedVoiceSession, VoiceSessionStart } from './voice-call'
import { isVoiceVendor } from './voice-runtime'

const parseStartedSession = (body: unknown): StartedVoiceSession | null => {
  if (!body || typeof body !== 'object') return null
  const { vendor, signedUrl, sessionKey, locale } = body as Record<string, unknown>
  if (!isVoiceVendor(vendor) || typeof signedUrl !== 'string' || typeof sessionKey !== 'string' || typeof locale !== 'string') {
    return null
  }
  return { vendor, signedUrl, sessionKey, locale }
}

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
  const session = parseStartedSession(await response.json().catch(() => null))
  return session ? { kind: 'started', session } : { kind: 'refused' }
}
