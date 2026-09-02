import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { OkResponseOf, RequestBodyOf } from "./operationTypes.js";

// MCP connection endpoints declare inline bodies; converse-grant endpoints use named schemas.
export type McpConnectionListResponse = OkResponseOf<"listMcpConnections">;
export type McpConnectionCreateRequest = RequestBodyOf<"createMcpConnection">;
export type McpConnectionResponse = OkResponseOf<"getMcpConnection">;
export type McpConnectionUpdateRequest = RequestBodyOf<"updateMcpConnection">;
export type McpConnectionDiscoverResponse = OkResponseOf<"discoverMcpConnectionTools">;
export type McpConnectionOauthStartResponse = OkResponseOf<"startMcpConnectionOauth">;
export type McpConnectionOauthCompleteRequest = RequestBodyOf<"completeMcpConnectionOauth">;
export type McpConnectionOauthCompleteResponse = OkResponseOf<"completeMcpConnectionOauth">;

const connectionsBase = (agentId: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/mcp-connections`;

/** Agent-scoped external MCP server connections (for external/tool-backed skills). */
export const createMcpConnectionsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<McpConnectionListResponse> =>
    requestJson(config, { method: "GET", path: connectionsBase(agentId) }),

  create: (agentId: string, body: McpConnectionCreateRequest): Promise<McpConnectionResponse> =>
    requestJson(config, { method: "POST", path: connectionsBase(agentId), body }),

  get: (agentId: string, connectionId: string): Promise<McpConnectionResponse> =>
    requestJson(config, {
      method: "GET",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}`,
    }),

  update: (
    agentId: string,
    connectionId: string,
    body: McpConnectionUpdateRequest,
  ): Promise<McpConnectionResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}`,
      body,
    }),

  delete: (agentId: string, connectionId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}`,
    }),

  discover: (agentId: string, connectionId: string): Promise<McpConnectionDiscoverResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}/discover`,
    }),

  startOauth: (agentId: string, connectionId: string): Promise<McpConnectionOauthStartResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}/oauth/authorize`,
    }),

  completeOauth: (
    agentId: string,
    connectionId: string,
    body: McpConnectionOauthCompleteRequest,
  ): Promise<McpConnectionOauthCompleteResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${connectionsBase(agentId)}/${encodeURIComponent(connectionId)}/oauth/complete`,
      body,
    }),
});

export type McpConnectionsResource = ReturnType<typeof createMcpConnectionsResource>;
