import { getStoredActiveWorkspaceId } from './api-storage'

export {
  activateWorkspaceSession,
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
  removeWorkspaceSession,
  seedWorkspaceSession,
  setPendingAccountSwitchId,
  storeAnonymousSessionId,
  storeEmbedBootstrapSession,
  storeEffectivePublicChatToken,
  storePublicSessionResumeToken,
  storePublicSessionToken,
  type StoredEmbedBootstrapSession,
  type StoredPublicSessionToken,
  type StoredPublicSessionResumeToken,
} from './api-storage'

export const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
export const STREAMING_API_PATH = '/api/chat/stream'
export const PUBLIC_CHAT_STREAMING_API_PATH = '/api/public/chat'

export interface ErrorResponse {
  status?: number
  error: {
    code: string
    message: string
    details?: unknown
    retryAfterSeconds?: number
  }
}

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
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
      return { ...(payload as ErrorResponse), status: response.status };
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
        status: response.status,
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
      status: response.status,
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  } catch (error) {
    if (isAbortError(error)) throw error
    return {
      status: response.status,
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  }
};

export const request = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean } = { withSession: true },
): Promise<T> => {
  const headers = new Headers(init.headers);
  const signal = init.signal ?? undefined
  throwIfAborted(signal)
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("X-Forwarded-Prefix")) {
    headers.set("X-Forwarded-Prefix", "/backend");
  }
  const useSession = options.withSession !== false
  if (useSession && !headers.has("X-Workspace-Id")) {
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) {
      headers.set("X-Workspace-Id", workspaceId)
    }
  }

  const executeFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers,
    credentials: useSession ? "include" : init.credentials,
  });

  const response = await executeFetch()

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
  options: { withSession?: boolean } = { withSession: true },
): Promise<T> => {
  const headers = new Headers(init.headers);
  const signal = init.signal ?? undefined
  throwIfAborted(signal)
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const useSession = options.withSession !== false

  if (useSession && !headers.has("X-Workspace-Id")) {
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) {
      headers.set("X-Workspace-Id", workspaceId)
    }
  }

  if (!headers.has("Content-Type") && init.body && !isFormData) {
    headers.set("Content-Type", "application/json");
  }

  const executeFetch = () => fetch(path, {
    ...init,
    cache: "no-store",
    headers,
    credentials: useSession ? "include" : init.credentials,
  });

  const response = await executeFetch()

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
