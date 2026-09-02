import type { AccessSessionRecord } from "../auth/sessionStore.js";
import type { RadiosoMcpConfig } from "../config.js";

import { toInternalAuthInfo } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";
import type { RuntimeStoreReadiness } from "../state/runtimeStores.js";

export type McpBearerTokenVerifier = (
  accessToken: string,
  sourceDigest?: string,
) => Promise<AccessSessionRecord | null>;

export interface McpRequestHandlerDependencies {
  config: Pick<RadiosoMcpConfig, "bindHost" | "bindPort">;
  readiness?: RuntimeStoreReadiness;
  serverManager: SessionMcpServerManager;
  verifyBearerToken: McpBearerTokenVerifier;
}

export interface McpHandledResponse {
  response: Response;
  successfulUse?: {
    session: AccessSessionRecord;
    sourceDigest?: string;
  };
}

export type McpRequestHandler = (request: Request, sourceDigest?: string) => Promise<McpHandledResponse>;

const BEARER_PREFIX = "Bearer ";
const MAX_BEARER_TOKEN_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 128;
const MAX_CLIENT_VERSION_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

const readBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const presented = authorization.slice(BEARER_PREFIX.length);
  if (CONTROL_CHARACTERS.test(presented)) return null;
  const token = presented.trim();
  return token.length > 0
    && token.length <= MAX_BEARER_TOKEN_LENGTH
    && !CONTROL_CHARACTERS.test(token)
    ? token
    : null;
};

const boundedClientValue = (value: unknown, maxLength: number): boolean =>
  value === undefined
  || (typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_CHARACTERS.test(value));

const hasBoundedClientMetadata = async (request: Request): Promise<boolean> => {
  if (request.method !== "POST") return true;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  const payloads = Array.isArray(body) ? body : [body];
  if (payloads.length === 0 || payloads.length > 50) return false;
  return payloads.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const payload = value as { method?: unknown; params?: unknown };
    if (payload.method !== "initialize") return true;
    if (!payload.params || typeof payload.params !== "object" || Array.isArray(payload.params)) return true;
    const clientInfo = (payload.params as { clientInfo?: unknown }).clientInfo;
    if (clientInfo === undefined) return true;
    if (!clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo)) return false;
    const client = clientInfo as { name?: unknown; version?: unknown };
    return boundedClientValue(client.name, MAX_CLIENT_NAME_LENGTH)
      && boundedClientValue(client.version, MAX_CLIENT_VERSION_LENGTH);
  });
};

const jsonRpcError = (status: number, code: number, message: string, data?: unknown): Response =>
  Response.json(
    {
      error: {
        code,
        ...(data !== undefined ? { data } : {}),
        message,
      },
      id: null,
      jsonrpc: "2.0",
    },
    { status },
  );

const withMcpAcceptHeader = (request: Request): Request => {
  const acceptHeader = request.headers.get("accept");
  if (
    typeof acceptHeader === "string"
    && acceptHeader.includes("application/json")
    && acceptHeader.includes("text/event-stream")
  ) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");

  return new Request(request, {
    headers,
  });
};

export const createMcpRequestHandler = ({
  readiness,
  serverManager,
  verifyBearerToken,
}: McpRequestHandlerDependencies): McpRequestHandler => {
  return async (request: Request, sourceDigest?: string): Promise<McpHandledResponse> => {
    if (readiness && !readiness.isReady()) {
      return {
        response: jsonRpcError(503, -32002, "MCP runtime is unavailable.", {
          code: "mcp_runtime_unavailable",
        }),
      };
    }

    if (!await hasBoundedClientMetadata(request)) {
      return {
        response: jsonRpcError(400, -32600, "Invalid MCP request metadata.", {
          code: "invalid_request",
        }),
      };
    }

    const accessToken = readBearerToken(request);
    if (!accessToken) {
      return {
        response: jsonRpcError(401, -32001, "MCP access token is invalid or expired.", {
          code: "invalid_access_token",
        }),
      };
    }

    const session = await verifyBearerToken(accessToken, sourceDigest);
    if (!session) {
      return {
        response: jsonRpcError(401, -32001, "MCP access token is invalid or expired.", {
          code: "invalid_access_token",
        }),
      };
    }

    const handle = await serverManager.getOrCreate(session);
    const response = await handle.transport.handleRequest(withMcpAcceptHeader(request), {
      authInfo: toInternalAuthInfo(session, accessToken, sourceDigest),
    });
    return {
      response,
      successfulUse: { session, sourceDigest },
    };
  };
};
