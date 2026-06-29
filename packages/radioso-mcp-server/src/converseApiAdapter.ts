import { RadiosoApiError } from "./radiosoApiAdapter.js";

export interface ConverseSessionExchangeRequest {
  launchToken: string;
  client?: {
    name?: string;
    version?: string;
  };
}

export interface ConverseSessionExchangeResponse {
  sessionToken: string;
  expiresAt: string;
  resumeToken?: string;
  agent: {
    id: string;
    name: string;
  };
  conversationId: string;
}

export interface ConverseSessionValidateResponse {
  valid: true;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  permissions: string[];
}

export interface ConverseAskResponse {
  conversationId: string;
  answer: {
    text: string;
    citations?: unknown[];
  };
  traceId?: string;
}

export interface ConverseGroundedAnswerResponse {
  answer: string;
  citations: unknown[];
  retrieval: {
    agentScoped: true;
  };
}

export interface ConverseResourceSummary {
  uri: string;
  name: string;
  mimeType: string;
}

export interface ConverseResourceListResponse {
  resources: ConverseResourceSummary[];
}

export interface ConverseResourceReadResponse extends ConverseResourceSummary {
  text: string;
}

export interface ConverseApiAdapter {
  exchange(body: ConverseSessionExchangeRequest): Promise<ConverseSessionExchangeResponse>;
  validate(sessionToken: string): Promise<ConverseSessionValidateResponse>;
  ask(sessionToken: string, body: { message: string }): Promise<ConverseAskResponse>;
  answerGrounded(sessionToken: string, body: { query: string; maxResults?: number }): Promise<ConverseGroundedAnswerResponse>;
  listResources(sessionToken: string): Promise<ConverseResourceListResponse>;
  readResource(sessionToken: string, resourceId: string): Promise<ConverseResourceReadResponse>;
}

type FetchLike = typeof fetch;

const readBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  return text.length > 0 ? text : undefined;
};

export const createConverseApiAdapter = (
  config: { baseUrl: string; requestTimeoutMs: number },
  fetchImpl: FetchLike = fetch,
): ConverseApiAdapter => {
  const request = async <TResult>(path: string, init: RequestInit): Promise<TResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new RadiosoApiError(`Radioso request timed out after ${config.requestTimeoutMs}ms`, 504, "upstream_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const data = await readBody(response);
    if (!response.ok) {
      const errorPayload = data as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      throw new RadiosoApiError(
        errorPayload?.error?.message ?? `Radioso request failed with status ${response.status}`,
        response.status,
        errorPayload?.error?.code,
        errorPayload?.error?.details,
      );
    }
    return data as TResult;
  };

  return {
    exchange: (body) =>
      request("/api/v1/mcp/converse/session", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    validate: (sessionToken) =>
      request("/api/v1/mcp/converse/session/validate", {
        method: "POST",
        body: JSON.stringify({ sessionToken }),
      }),
    ask: (sessionToken, body) =>
      request("/api/v1/mcp/converse/ask", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
    answerGrounded: (sessionToken, body) =>
      request("/api/v1/mcp/converse/grounded-answer", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
    listResources: (sessionToken) =>
      request("/api/v1/mcp/converse/resources", {
        method: "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      }),
    readResource: (sessionToken, resourceId) =>
      request(`/api/v1/mcp/converse/resources/${encodeURIComponent(resourceId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      }),
  };
};
