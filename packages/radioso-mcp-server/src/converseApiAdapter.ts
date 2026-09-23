import { createMcpSourceProof, MCP_SOURCE_PROOF_HEADERS } from "@radioso/mcp-source-proof";

import type { components, operations } from "./generated/openapiTypes.js";

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

// The backend OpenAPI contract is the only source of these shapes; this package
// never imports backend modules. Regenerate with `pnpm run sync:openapi`.
export type ConverseSessionExchangeRequest =
  operations["createMcpConverseSession"]["requestBody"]["content"]["application/json"];

export type ConverseSessionExchangeResponse =
  operations["createMcpConverseSession"]["responses"][201]["content"]["application/json"];

export type ConverseSessionValidateResponse =
  operations["validateMcpConverseSession"]["responses"][200]["content"]["application/json"];

/** One turn: a `message`, or a `routine` invocation of a tool from the session's catalog. */
export type ConverseAskRequest =
  operations["askMcpConverseAgent"]["requestBody"]["content"]["application/json"];

/** The agent reply envelope core plus `answer.{text,citations}`; forwarded verbatim as structuredContent. */
export type ConverseAskResponse = components["schemas"]["McpConverseAskResponse"];

/** The bound agent's exposed routines as tools, read once per session. */
export type ConverseToolsResponse = components["schemas"]["McpConverseToolsResponse"];

/** What this session's conversation has seen since a cursor, plus who owns it now. */
export type ConverseMessagesResponse = components["schemas"]["ConverseMessagesResponse"];

/** An opaque resume cursor and an optional long-poll deadline. */
export type ConverseMessagesQuery = NonNullable<operations["getMcpConverseMessages"]["parameters"]["query"]>;

export type AgentToolDescriptor = components["schemas"]["AgentToolDescriptor"];

export interface ConverseApiAdapter {
  exchange(body: ConverseSessionExchangeRequest, context?: ConverseSourceContext): Promise<ConverseSessionExchangeResponse>;
  validate(sessionToken: string, context?: ConverseSourceContext): Promise<ConverseSessionValidateResponse>;
  tools(sessionToken: string, context?: ConverseSourceContext): Promise<ConverseToolsResponse>;
  messages(sessionToken: string, query: ConverseMessagesQuery, context?: ConverseSourceContext): Promise<ConverseMessagesResponse>;
  ask(sessionToken: string, body: ConverseAskRequest, context?: ConverseSourceContext): Promise<ConverseAskResponse>;
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

  const request = async <TResult>(
    path: string,
    init: RequestInit,
    // A long poll is a deliberate wait, not a slow backend, so the caller's requested
    // deadline is added to the transport timeout rather than racing it.
    timeoutMs: number = config.requestTimeoutMs,
  ): Promise<TResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        throw new RadiosoApiError(`Radioso request timed out after ${timeoutMs}ms`, 504, "upstream_timeout");
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
    tools: (sessionToken, context) => {
      const path = "/api/v1/mcp/converse/tools";
      return request(path, {
        method: "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          ...sourceProofHeaders(path, "GET", context),
        },
      });
    },
    messages: (sessionToken, query, context) => {
      const path = "/api/v1/mcp/converse/messages";
      const search = new URLSearchParams();
      if (query.cursor) search.set("cursor", query.cursor);
      if (typeof query.waitMs === "number") search.set("waitMs", String(query.waitMs));
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      return request(`${path}${suffix}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          // The source proof signs the route, not its query, so a long poll and a
          // catch-up read present the same proof.
          ...sourceProofHeaders(path, "GET", context),
        },
      }, config.requestTimeoutMs + (query.waitMs ?? 0));
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
