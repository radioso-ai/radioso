import type { AccessSessionRecord } from "../auth/sessionStore.js";
import type { RadiosoMcpConfig } from "../config.js";

import { toInternalAuthInfo } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";

export type McpBearerTokenVerifier = (accessToken: string) => Promise<AccessSessionRecord | null>;

export interface McpRequestHandlerDependencies {
  config: Pick<RadiosoMcpConfig, "bindHost" | "bindPort">;
  serverManager: SessionMcpServerManager;
  verifyBearerToken: McpBearerTokenVerifier;
}

export type McpRequestHandler = (request: Request) => Promise<Response>;

const BEARER_PREFIX = "Bearer ";

const readBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
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
  serverManager,
  verifyBearerToken,
}: McpRequestHandlerDependencies): McpRequestHandler => {
  return async (request: Request): Promise<Response> => {
    const accessToken = readBearerToken(request);
    if (!accessToken) {
      return jsonRpcError(401, -32001, "MCP access token is invalid or expired.", {
        code: "invalid_access_token",
      });
    }

    const session = await verifyBearerToken(accessToken);
    if (!session) {
      return jsonRpcError(401, -32001, "MCP access token is invalid or expired.", {
        code: "invalid_access_token",
      });
    }

    const handle = await serverManager.getOrCreate(session);
    const response = await handle.transport.handleRequest(withMcpAcceptHeader(request), {
      authInfo: toInternalAuthInfo(session, accessToken),
    });
    return response;
  };
};
