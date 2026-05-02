import type { StoredEmbedBootstrapSession, StoredPublicSessionToken } from './public-chat-types'

const ANONYMOUS_SESSION_HEADER = 'X-Radioso-Anonymous-Session'
const ANONYMOUS_SESSION_STORAGE_PREFIX = 'radioso.anonymousSession.'
const PUBLIC_SESSION_HEADER = 'X-Radioso-Public-Session'
const PUBLIC_SESSION_STORAGE_PREFIX = 'radioso.publicSession.'
const EMBED_BOOTSTRAP_STORAGE_PREFIX = 'radioso.embedBootstrap.'

const getAnonymousSessionStorageKey = (token: string) => `${ANONYMOUS_SESSION_STORAGE_PREFIX}${token}`
const getPublicSessionStorageKey = (token: string) => `${PUBLIC_SESSION_STORAGE_PREFIX}${token}`
const getEmbedBootstrapStorageKey = (token: string) => `${EMBED_BOOTSTRAP_STORAGE_PREFIX}${token}`

const readAnonymousSessionId = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.sessionStorage.getItem(getAnonymousSessionStorageKey(token))
}

export const readStoredAnonymousSessionId = (token: string) => readAnonymousSessionId(token)

const writeAnonymousSessionId = (token: string, sessionId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getAnonymousSessionStorageKey(token)
  if (!sessionId) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, sessionId)
}

const readPublicSessionToken = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.sessionStorage.getItem(getPublicSessionStorageKey(token))
  if (!rawValue) {
    return null
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredPublicSessionToken>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') {
      window.sessionStorage.removeItem(getPublicSessionStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getPublicSessionStorageKey(token))
      return null
    }

    return parsed.token
  } catch {
    window.sessionStorage.removeItem(getPublicSessionStorageKey(token))
    return null
  }
}

export const readStoredEmbedBootstrapSession = (token: string): StoredEmbedBootstrapSession | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.sessionStorage.getItem(getEmbedBootstrapStorageKey(token))
  if (!rawValue) {
    return null
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredEmbedBootstrapSession>
    if (
      typeof parsed.publicChatToken !== 'string' ||
      typeof parsed.publicSessionId !== 'string' ||
      typeof parsed.publicSessionToken !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    return {
      workspaceName: typeof parsed.workspaceName === 'string' ? parsed.workspaceName : undefined,
      publicChatToken: parsed.publicChatToken,
      publicSessionId: parsed.publicSessionId,
      publicSessionToken: parsed.publicSessionToken,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
    return null
  }
}

export const storePublicSessionToken = (
  token: string,
  sessionToken: string | null,
  expiresAt?: string,
) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getPublicSessionStorageKey(token)
  if (!sessionToken || !expiresAt) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify({ token: sessionToken, expiresAt }))
}

export const storeEmbedBootstrapSession = (token: string, session: StoredEmbedBootstrapSession | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getEmbedBootstrapStorageKey(token)
  if (!session) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(session))
  storePublicSessionToken(session.publicChatToken, session.publicSessionToken, session.expiresAt)
  writeAnonymousSessionId(session.publicChatToken, session.publicSessionId)
}

export const clearStoredAnonymousSession = (token: string) => {
  writeAnonymousSessionId(token, null)
  storePublicSessionToken(token, null)
}

export const clearStoredEmbedBootstrapSession = (token: string) => {
  const currentSession = readStoredEmbedBootstrapSession(token)
  if (currentSession) {
    clearStoredAnonymousSession(currentSession.publicChatToken)
  }

  storeEmbedBootstrapSession(token, null)
}

export const attachAnonymousSessionHeader = (token: string, headers?: HeadersInit) => {
  const nextHeaders = new Headers(headers)
  const sessionId = readAnonymousSessionId(token)
  const publicSessionToken = readPublicSessionToken(token)

  if (sessionId && !nextHeaders.has(ANONYMOUS_SESSION_HEADER)) {
    nextHeaders.set(ANONYMOUS_SESSION_HEADER, sessionId)
  }

  if (publicSessionToken && !nextHeaders.has(PUBLIC_SESSION_HEADER)) {
    nextHeaders.set(PUBLIC_SESSION_HEADER, publicSessionToken)
  }

  return nextHeaders
}

export const persistAnonymousSessionHeader = (token: string, response: Response) => {
  const sessionId = response.headers.get(ANONYMOUS_SESSION_HEADER)
  if (sessionId) {
    writeAnonymousSessionId(token, sessionId)
  }
}
