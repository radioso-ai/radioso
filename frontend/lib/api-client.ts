export const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
export const STREAMING_API_PATH = '/api/chat/stream'
export const PUBLIC_CHAT_STREAMING_API_PATH = '/api/public/chat'
const API_TOKEN_STORAGE_KEY = "radioso.apiToken";
const WORKSPACE_TOKENS_STORAGE_KEY = "radioso.workspaceTokens";
const ACTIVE_WORKSPACE_STORAGE_KEY = "radioso.activeWorkspaceId";
const ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY = "radioso.activeWorkspacePublicRouteKey";
const PENDING_ACCOUNT_SWITCH_STORAGE_KEY = 'radioso.pendingAccountSwitchId'
const ANONYMOUS_SESSION_HEADER = 'X-Radioso-Anonymous-Session'
const ANONYMOUS_SESSION_STORAGE_PREFIX = 'radioso.anonymousSession.'
const PUBLIC_SESSION_HEADER = 'X-Radioso-Public-Session'
const PUBLIC_SESSION_STORAGE_PREFIX = 'radioso.publicSession.'
const PUBLIC_SESSION_EFFECTIVE_TOKEN_STORAGE_PREFIX = 'radioso.publicSessionEffectiveToken.'
const EMBED_BOOTSTRAP_STORAGE_PREFIX = 'radioso.embedBootstrap.'

export interface StoredEmbedBootstrapSession {
  workspaceName?: string
  publicChatToken: string
  publicSessionId: string
  publicSessionToken: string
  actions?: Record<string, unknown>
  expiresAt: string
}

export interface StoredPublicSessionToken {
  token: string
  expiresAt: string
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
    retryAfterSeconds?: number
  }
}

interface WorkspaceTokenResponse {
  token: string
}

const workspaceTokenRequests = new Map<string, Promise<string>>()

const readStoredWorkspaceTokens = (): Record<string, string> => {
  if (typeof window === "undefined") {
    return {}
  }

  const rawValue = window.localStorage.getItem(WORKSPACE_TOKENS_STORAGE_KEY)
  if (!rawValue) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      window.localStorage.removeItem(WORKSPACE_TOKENS_STORAGE_KEY)
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
  } catch {
    window.localStorage.removeItem(WORKSPACE_TOKENS_STORAGE_KEY)
    return {}
  }
}

const writeStoredWorkspaceTokens = (tokens: Record<string, string>) => {
  if (typeof window === "undefined") {
    return
  }

  const entries = Object.entries(tokens).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  if (entries.length === 0) {
    window.localStorage.removeItem(WORKSPACE_TOKENS_STORAGE_KEY)
  } else {
    window.localStorage.setItem(WORKSPACE_TOKENS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  }

  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY)
}

const readStoredWorkspaceToken = (workspaceId: string): string | null => {
  if (typeof window === "undefined") {
    return null
  }

  const storedTokens = readStoredWorkspaceTokens()
  const cachedToken = storedTokens[workspaceId]
  if (typeof cachedToken === "string" && cachedToken.length > 0) {
    return cachedToken
  }

  const legacyToken = window.localStorage.getItem(API_TOKEN_STORAGE_KEY)
  if (legacyToken && getStoredActiveWorkspaceId() === workspaceId) {
    writeStoredWorkspaceTokens({
      ...storedTokens,
      [workspaceId]: legacyToken,
    })
    return legacyToken
  }

  return null
}

export const storeWorkspaceToken = (workspaceId: string, token: string) => {
  if (typeof window === "undefined") {
    return
  }

  writeStoredWorkspaceTokens({
    ...readStoredWorkspaceTokens(),
    [workspaceId]: token,
  })
}

const clearStoredWorkspaceToken = (workspaceId: string) => {
  if (typeof window === "undefined") {
    return
  }

  const nextTokens = { ...readStoredWorkspaceTokens() }
  delete nextTokens[workspaceId]
  writeStoredWorkspaceTokens(nextTokens)
}

export const activateWorkspaceToken = (workspaceId: string, workspacePublicRouteKey?: string): boolean => {
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
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_TOKENS_STORAGE_KEY);
  window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
  window.sessionStorage?.removeItem(PENDING_ACCOUNT_SWITCH_STORAGE_KEY)
};

export const removeWorkspaceToken = (workspaceId: string) => {
  if (typeof window === "undefined") return;
  clearStoredWorkspaceToken(workspaceId)
  if (getStoredActiveWorkspaceId() === workspaceId) {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_WORKSPACE_ROUTE_KEY_STORAGE_KEY);
  }
};

const getAnonymousSessionStorageKey = (token: string) => `${ANONYMOUS_SESSION_STORAGE_PREFIX}${token}`
const getPublicSessionStorageKey = (token: string) => `${PUBLIC_SESSION_STORAGE_PREFIX}${token}`
const getPublicSessionEffectiveTokenStorageKey = (token: string) => `${PUBLIC_SESSION_EFFECTIVE_TOKEN_STORAGE_PREFIX}${token}`
const getEmbedBootstrapStorageKey = (token: string) => `${EMBED_BOOTSTRAP_STORAGE_PREFIX}${token}`

const readAnonymousSessionId = (token: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.sessionStorage.getItem(getAnonymousSessionStorageKey(token))
}

export const readStoredAnonymousSessionId = (token: string) => readAnonymousSessionId(token)

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
      typeof parsed.expiresAt !== 'string'
    ) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      return null
    }

    const actions =
      parsed.actions && typeof parsed.actions === 'object' && !Array.isArray(parsed.actions)
        ? parsed.actions
        : null

    if (!actions) {
      window.sessionStorage.removeItem(getEmbedBootstrapStorageKey(token))
      storePublicSessionToken(parsed.publicChatToken, null)
      return null
    }

    return {
      workspaceName: typeof parsed.workspaceName === 'string' ? parsed.workspaceName : undefined,
      publicChatToken: parsed.publicChatToken,
      publicSessionId: parsed.publicSessionId,
      publicSessionToken: parsed.publicSessionToken,
      actions,
      expiresAt: parsed.expiresAt,
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
  }
  writeAnonymousSessionId(token, null)
  storePublicSessionToken(token, null)
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

export const buildError = async (response: Response): Promise<ErrorResponse> => {
  try {
    const payload = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
    ) {
      return payload as ErrorResponse;
    }

    if (
      payload &&
      typeof payload === "object" &&
      "code" in payload &&
      typeof payload.code === "string" &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      return {
        error: {
          code: payload.code,
          message: payload.message,
          retryAfterSeconds:
            "retryAfterSeconds" in payload && typeof payload.retryAfterSeconds === "number"
              ? payload.retryAfterSeconds
              : undefined,
        },
      };
    }

    return {
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  } catch {
    return {
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  }
};

export const requireWorkspaceApiToken = async (): Promise<string> => {
  const workspaceId = getStoredActiveWorkspaceId()

  if (!workspaceId) {
    throw {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in again to continue.",
      },
    } satisfies ErrorResponse
  }

  const cachedToken = readStoredWorkspaceToken(workspaceId)
  if (cachedToken) {
    return cachedToken
  }

  const inFlightRequest = workspaceTokenRequests.get(workspaceId)
  if (inFlightRequest) {
    return inFlightRequest
  }

  const tokenRequest = (async () => {
    const response = await fetch(`${API_BASE}/account/workspaces/${workspaceId}/token`, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: {
        "X-Forwarded-Prefix": "/backend",
      },
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    const payload = (await response.json()) as Partial<WorkspaceTokenResponse>
    if (typeof payload.token !== "string" || payload.token.length === 0) {
      throw {
        error: {
          code: "HTTP_ERROR",
          message: "Workspace token response was invalid.",
        },
      } satisfies ErrorResponse
    }

    storeWorkspaceToken(workspaceId, payload.token)
    return payload.token
  })()

  workspaceTokenRequests.set(workspaceId, tokenRequest)

  try {
    return await tokenRequest
  } finally {
    workspaceTokenRequests.delete(workspaceId)
  }
}

export const canRetryWithFreshWorkspaceToken = (response: Response): boolean =>
  response.status === 401 && Boolean(getStoredActiveWorkspaceId())

export const refreshWorkspaceApiToken = async (headers: Headers): Promise<boolean> => {
  const workspaceId = getStoredActiveWorkspaceId()
  if (!workspaceId) {
    return false
  }

  clearStoredWorkspaceToken(workspaceId)
  headers.set("Authorization", `Bearer ${await requireWorkspaceApiToken()}`)
  return true
}

export const request = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean; withApiToken?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("X-Forwarded-Prefix")) {
    headers.set("X-Forwarded-Prefix", "/backend");
  }
  if (options.withSession && !headers.has("X-Workspace-Id")) {
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) {
      headers.set("X-Workspace-Id", workspaceId)
    }
  }

  if (options.withApiToken) {
    headers.set("Authorization", `Bearer ${await requireWorkspaceApiToken()}`);
  }

  const executeFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers,
    credentials: options.withSession ? "include" : options.withApiToken ? "omit" : init.credentials,
  });

  let response = await executeFetch()
  if (options.withApiToken && canRetryWithFreshWorkspaceToken(response) && await refreshWorkspaceApiToken(headers)) {
    response = await executeFetch()
  }

  if (!response.ok) {
    throw await buildError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

export const requestLongRunning = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean; withApiToken?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }

  if (options.withApiToken) {
    headers.set("Authorization", `Bearer ${await requireWorkspaceApiToken()}`);
  }

  const executeFetch = () => fetch(path, {
    ...init,
    cache: "no-store",
    headers,
    credentials: options.withSession ? "include" : options.withApiToken ? "omit" : init.credentials,
  });

  let response = await executeFetch()
  if (options.withApiToken && canRetryWithFreshWorkspaceToken(response) && await refreshWorkspaceApiToken(headers)) {
    response = await executeFetch()
  }

  if (!response.ok) {
    throw await buildError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};
