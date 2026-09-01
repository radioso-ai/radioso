import { createMcpSourceProof, MCP_SOURCE_PROOF_HEADERS } from "@radioso/mcp-source-proof";

export class RadiosoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RadiosoApiError";
  }
}

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

export interface ConverseApiAdapter {
  exchange(body: ConverseSessionExchangeRequest, context?: ConverseSourceContext): Promise<ConverseSessionExchangeResponse>;
  validate(sessionToken: string, context?: ConverseSourceContext): Promise<ConverseSessionValidateResponse>;
  ask(sessionToken: string, body: { message: string }, context?: ConverseSourceContext): Promise<ConverseAskResponse>;
  recordUse(sessionToken: string, context?: ConverseSourceContext): Promise<void>;
}

export interface ConverseSourceContext {
  sourceDigest?: string;
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
  config: { baseUrl: string; requestTimeoutMs: number; signingSecret?: string },
  fetchImpl: FetchLike = fetch,
): ConverseApiAdapter => {
  const sourceProofHeaders = (
    path: string,
    method: string,
    context?: ConverseSourceContext,
  ): Record<string, string> => {
    if (!config.signingSecret || !context?.sourceDigest) return {};
    const proof = createMcpSourceProof({
      method,
      path,
      secret: config.signingSecret,
      sourceDigest: context.sourceDigest,
    });
    return {
      [MCP_SOURCE_PROOF_HEADERS.digest]: proof.sourceDigest,
      [MCP_SOURCE_PROOF_HEADERS.signature]: proof.signature,
      [MCP_SOURCE_PROOF_HEADERS.timestamp]: proof.timestamp,
    };
  };

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
    exchange: (body, context) => {
      const path = "/api/v1/mcp/converse/session";
      return request(path, {
        method: "POST",
        headers: sourceProofHeaders(path, "POST", context),
        body: JSON.stringify(body),
      });
    },
    validate: (sessionToken, context) => {
      const path = "/api/v1/mcp/converse/session/validate";
      return request(path, {
        method: "POST",
        headers: sourceProofHeaders(path, "POST", context),
        body: JSON.stringify({ sessionToken }),
      });
    },
    ask: (sessionToken, body, context) => {
      const path = "/api/v1/mcp/converse/ask";
      return request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          ...sourceProofHeaders(path, "POST", context),
        },
        body: JSON.stringify(body),
      });
    },
    recordUse: (sessionToken, context) => {
      const path = "/api/v1/mcp/converse/session/use";
      return request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          ...sourceProofHeaders(path, "POST", context),
        },
      });
    },
  };
};
