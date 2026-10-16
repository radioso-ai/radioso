import { PUBLIC_CHAT_STREAMING_API_PATH, attachAnonymousSessionHeader } from './api-client'

/** The voice runtimes the chat panel can open a session on. */
const VOICE_VENDORS = ['elevenlabs'] as const

export type VoiceVendor = (typeof VOICE_VENDORS)[number]

/** What the page needs to open the session on the vendor; `signedUrl` is a bearer credential. */
export interface StartedVoiceSession {
  vendor: VoiceVendor
  signedUrl: string
  sessionKey: string
  locale: string
}

/**
 * How a start ended, as the visitor can act on it. `refused` covers every answer that is not a
 * session (voice off, a start budget spent, a vendor that would not start one, a network that
 * failed): the visitor reads one line for all of them, and the backend's metric says which.
 */
export type PublicVoiceSessionStart = { kind: 'started'; session: StartedVoiceSession } | { kind: 'refused' }

const isVoiceVendor = (value: unknown): value is VoiceVendor =>
  typeof value === 'string' && (VOICE_VENDORS as readonly string[]).includes(value)

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
export async function startPublicVoiceSession(token: string, input: { locale?: string }): Promise<PublicVoiceSessionStart> {
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
