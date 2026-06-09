import {
  clearStoredWorkspaceToken,
  getStoredActiveWorkspaceId,
  readStoredWorkspaceToken,
  storeWorkspaceToken,
} from './api-storage'

export {
  activateWorkspaceToken,
  attachAnonymousSessionHeader,
  clearStoredAnonymousSession,
  clearStoredEmbedBootstrapSession,
  clearWorkspaceStorage,
  getPendingAccountSwitchId,
  getStoredActiveWorkspaceId,
  getStoredActiveWorkspacePublicRouteKey,
  persistAnonymousSessionHeader,
  readStoredAnonymousSessionId,
  readStoredEmbedBootstrapSession,
  readStoredEffectivePublicChatToken,
  readStoredPublicSessionResumeToken,
  readStoredPublicSessionToken,
  removeWorkspaceToken,
  seedWorkspaceSession,
  setPendingAccountSwitchId,
  storeAnonymousSessionId,
  storeEmbedBootstrapSession,
  storeEffectivePublicChatToken,
  storePublicSessionResumeToken,
  storePublicSessionToken,
  storeWorkspaceToken,
  type StoredEmbedBootstrapSession,
  type StoredPublicSessionToken,
  type StoredPublicSessionResumeToken,
} from './api-storage'

export const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
export const STREAMING_API_PATH = '/api/chat/stream'
export const PUBLIC_CHAT_STREAMING_API_PATH = '/api/public/chat'

export interface ErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
    retryAfterSeconds?: number
  }
}

interface WorkspaceTokenResponse {
  token: string
}

const workspaceTokenRequests = new Map<string, Promise<string>>()

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
