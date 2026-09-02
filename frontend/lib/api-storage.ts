const LEGACY_API_TOKEN_STORAGE_KEY = "radioso.apiToken";
const LEGACY_WORKSPACE_TOKENS_STORAGE_KEY = "radioso.workspaceTokens";
const ACTIVE_WORKSPACE_STORAGE_KEY = "radioso.activeWorkspaceId";
const ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY = "radioso.activeWorkspacePublicRouteKey";
const PENDING_ACCOUNT_SWITCH_STORAGE_KEY = 'radioso.pendingAccountSwitchId'
const ANONYMOUS_SESSION_HEADER = 'X-Radioso-Anonymous-Session'
const ANONYMOUS_SESSION_STORAGE_PREFIX = 'radioso.anonymousSession.'
const PUBLIC_SESSION_HEADER = 'X-Radioso-Public-Session'
const PUBLIC_SESSION_STORAGE_PREFIX = 'radioso.publicSession.'
const PUBLIC_SESSION_RESUME_STORAGE_PREFIX = 'radioso.publicSessionResume.'
const PUBLIC_SESSION_EFFECTIVE_TOKEN_STORAGE_PREFIX = 'radioso.publicSessionEffectiveToken.'
const EMBED_BOOTSTRAP_STORAGE_PREFIX = 'radioso.embedBootstrap.'

export interface StoredEmbedBootstrapSession {
  workspaceName?: string
  publicChatToken: string
  publicSessionId: string
  publicSessionToken: string
  expiresAt: string
  resumeToken: string
  resumeExpiresAt: string
}

export interface StoredPublicSessionToken {
  token: string
  expiresAt: string
}

export interface StoredPublicSessionResumeToken {
  token: string
  expiresAt: string
}

export const activateWorkspaceSession = (workspaceId: string, workspacePublicRouteKey?: string): boolean => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    if (workspacePublicRouteKey) {
      window.localStorage.setItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY, workspacePublicRouteKey);
    } else {
      window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
    }
  }
  return true;
};

export const seedWorkspaceSession = (workspaceId: string, workspacePublicRouteKey?: string) => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    if (workspacePublicRouteKey) {
      window.localStorage.setItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY, workspacePublicRouteKey);
    } else {
      window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
    }
  }
};

export const getStoredActiveWorkspaceId = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
};

export const getStoredActiveWorkspacePublicRouteKey = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
};

export const setPendingAccountSwitchId = (accountId: string | null) => {
  if (typeof window === 'undefined') return
  if (!window.sessionStorage) return
  if (accountId) {
    window.sessionStorage.setItem(PENDING_ACCOUNT_SWITCH_STORAGE_KEY, accountId)
  } else {
    window.sessionStorage.removeItem(PENDING_ACCOUNT_SWITCH_STORAGE_KEY)
  }
}

export const getPendingAccountSwitchId = (): string | null => {
  if (typeof window === 'undefined') return null
  if (!window.sessionStorage) return null
  return window.sessionStorage.getItem(PENDING_ACCOUNT_SWITCH_STORAGE_KEY)
}

export const clearWorkspaceStorage = () => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_API_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_WORKSPACE_TOKENS_STORAGE_KEY);
  window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
  window.sessionStorage?.removeItem(PENDING_ACCOUNT_SWITCH_STORAGE_KEY)
};

export const removeWorkspaceSession = (workspaceId: string) => {
  if (typeof window === "undefined") return;
  if (getStoredActiveWorkspaceId() === workspaceId) {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
  }
  // Remove pre-1117 values if an older dashboard left them behind; they are
  // never read or written by the session transport.
  window.localStorage.removeItem(LEGACY_API_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_WORKSPACE_TOKENS_STORAGE_KEY);
};

const getAnonymousSessionStorageKey = (token: string) => `${ANONYMOUS_SESSION_STORAGE_PREFIX}${token}`
const getPublicSessionStorageKey = (token: string) => `${PUBLIC_SESSION_STORAGE_PREFIX}${token}`
const getPublicSessionResumeStorageKey = (token: string) => `${PUBLIC_SESSION_RESUME_STORAGE_PREFIX}${token}`
const getPublicSessionEffectiveTokenStorageKey = (token: string) => `${PUBLIC_SESSION_EFFECTIVE_TOKEN_STORAGE_PREFIX}${token}`
const getEmbedBootstrapStorageKey = (token: string) => `${EMBED_BOOTSTRAP_STORAGE_PREFIX}${token}`

const readAnonymousSessionId = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.sessionStorage.getItem(getAnonymousSessionStorageKey(token))
}

export const readStoredAnonymousSessionId = (token: string) => readAnonymousSessionId(token)

export const storeAnonymousSessionId = (token: string, sessionId: string | null) => {
  writeAnonymousSessionId(token, sessionId)
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

export const readStoredPublicSessionToken = (token: string) => readPublicSessionToken(token)

const readPublicSessionResumeToken = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const rawValue = window.sessionStorage.getItem(getPublicSessionResumeStorageKey(token))
  if (!rawValue) {
    return null
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredPublicSessionResumeToken>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') {
      window.sessionStorage.removeItem(getPublicSessionResumeStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getPublicSessionResumeStorageKey(token))
      return null
    }

    return parsed.token
  } catch {
    window.sessionStorage.removeItem(getPublicSessionResumeStorageKey(token))
    return null
  }
}

export const readStoredPublicSessionResumeToken = (token: string) => readPublicSessionResumeToken(token)

export const readStoredEffectivePublicChatToken = (launchToken: string): string | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const effectiveToken = window.sessionStorage.getItem(getPublicSessionEffectiveTokenStorageKey(launchToken))
  if (!effectiveToken) {
    return null
  }

  if (!readPublicSessionToken(effectiveToken)) {
    window.sessionStorage.removeItem(getPublicSessionEffectiveTokenStorageKey(launchToken))
    return null
  }

  return effectiveToken
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
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.resumeToken !== 'string' ||
      typeof parsed.resumeExpiresAt !== 'string'
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
      resumeToken: parsed.resumeToken,
      resumeExpiresAt: parsed.resumeExpiresAt,
    }
  } catch {
    window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
    return null
  }
}

export const clearStoredAnonymousSession = (token: string) => {
  const effectiveToken = readStoredEffectivePublicChatToken(token)
  if (effectiveToken && effectiveToken !== token) {
    writeAnonymousSessionId(effectiveToken, null)
    storePublicSessionToken(effectiveToken, null)
    storePublicSessionResumeToken(effectiveToken, null)
  }
  writeAnonymousSessionId(token, null)
  storePublicSessionToken(token, null)
  storePublicSessionResumeToken(token, null)
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(getPublicSessionEffectiveTokenStorageKey(token))
  }
}

export const clearStoredEmbedBootstrapSession = (token: string) => {
  const currentSession = readStoredEmbedBootstrapSession(token)
  if (currentSession) {
    clearStoredAnonymousSession(currentSession.publicChatToken)
  }

  storeEmbedBootstrapSession(token, null)
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

export const storePublicSessionResumeToken = (
  token: string,
  resumeToken: string | null,
  expiresAt?: string,
) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getPublicSessionResumeStorageKey(token)
  if (!resumeToken || !expiresAt) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify({ token: resumeToken, expiresAt }))
}

export const storeEffectivePublicChatToken = (launchToken: string, effectiveToken: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = getPublicSessionEffectiveTokenStorageKey(launchToken)
  if (!effectiveToken || effectiveToken === launchToken) {
    window.sessionStorage.removeItem(storageKey)
    return
  }

  window.sessionStorage.setItem(storageKey, effectiveToken)
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
  storePublicSessionResumeToken(session.publicChatToken, session.resumeToken, session.resumeExpiresAt)
  writeAnonymousSessionId(session.publicChatToken, session.publicSessionId)
}

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
