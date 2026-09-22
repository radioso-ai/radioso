import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { AuditLogger } from "../audit/auditLogger.js";
import { AuthServiceError } from "../auth/authService.js";
import { toMcpRequestAuthInfo } from "../auth/authInfo.js";
import type { AccessSessionRecord, SessionToolCatalog } from "../auth/sessionStore.js";
import { toToolCatalogKey } from "../auth/toolCatalogKey.js";
import type { RadiosoMcpConfig } from "../config.js";
import { createConverseApiAdapter } from "../converseApiAdapter.js";
import { createRadiosoMcpServer, getRemoteToolAuthInfo } from "../server.js";
import type { InternalMcpRequestAuthInfo, SessionMcpServerManager } from "./types.js";

const toInternalAuthInfo = (
  session: AccessSessionRecord,
  accessToken: string,
  sourceDigest?: string,
): InternalMcpRequestAuthInfo => ({
  ...toMcpRequestAuthInfo(session),
  accessToken,
  clientId: session.clientName ?? session.sessionId,
  scopes: ["ask_agent"],
  sourceDigest,
  token: accessToken,
});

/** A session persisted before catalogs were pinned sees the static tools only. */
const STATIC_TOOL_CATALOG: SessionToolCatalog = { key: toToolCatalogKey([]), tools: [] };

export interface SessionServerManagerDependencies {
  auditLogger?: AuditLogger;
  config: RadiosoMcpConfig;
  entryPoint?: "merged" | "standalone";
}

/**
 * Answers each MCP request on a server built for that request from the session's
 * pinned catalog, connected to a transport of its own. The streamable transport maps
 * responses to requests by raw JSON-RPC id, so two clients sharing one transport and
 * both sending `id: 1` would receive each other's replies; one transport per request
 * makes that impossible, and building the server from the descriptors stored on the
 * session record costs a few schema compilations per request — no cache to evict
 * mid-flight, and nothing that outlives the response.
 */
export const createSessionMcpServerManager = ({
  auditLogger,
  config,
  entryPoint = "standalone",
}: SessionServerManagerDependencies): SessionMcpServerManager => {
  const converseAdapter = createConverseApiAdapter({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    signingSecret: config.signingSecret,
  });

  const createServer = (session: AccessSessionRecord, toolCatalog: SessionToolCatalog) =>
    createRadiosoMcpServer({
      onToolError: async (tool, context, error) => {
        if (!auditLogger) {
          return;
        }

        await auditLogger.emit({
          eventType: error.code === "unsupported_capability"
            ? "upstream.unsupported_capability"
            : error.code.includes("forbidden") || error.code.includes("required") || error.code.includes("invalid")
            ? "tool.denied"
            : "tool.failed",
          metadata: {
            code: error.code,
            details: error.details,
            entryPoint,
            conversationId: context?.authInfo?.conversationId,
          },
          outcome: error.code.includes("invalid") ? "denied" : "error",
          sessionId: context?.authInfo?.sessionId,
          toolName: tool.name,
        });
      },
      // The SDK refuses arguments that miss the tool's schema before the handler runs,
      // so this is the only place such a call can be audited. The server is built for
      // this session, so the event still names the session and conversation; the
      // arguments themselves are never recorded.
      onToolInputRejected: async (tool) => {
        if (!auditLogger) {
          return;
        }

        await auditLogger.emit({
          eventType: "tool.denied",
          metadata: {
            code: "invalid_arguments",
            entryPoint,
            conversationId: session.conversationId,
          },
          outcome: "denied",
          sessionId: session.sessionId,
          toolName: tool.name,
        });
      },
      onToolResult: async (tool, context) => {
        if (!auditLogger) {
          return;
        }

        await auditLogger.emit({
          eventType: "tool.executed",
          metadata: {
            entryPoint,
            conversationId: context.authInfo?.conversationId,
          },
          outcome: "success",
          sessionId: context.authInfo?.sessionId,
          toolName: tool.name,
        });
      },
      resolveExecutionContext: async (_tool, _rawArgs, ctx) => {
        const authInfo = getRemoteToolAuthInfo(ctx) as InternalMcpRequestAuthInfo | null;
        if (!authInfo?.accessToken || !authInfo.converseSessionToken) {
          throw new AuthServiceError("MCP request is missing authenticated session context.", "invalid_access_token");
        }

        const converseSessionToken = authInfo.converseSessionToken;

        return {
          authInfo,
          converseAdapter,
          converseSessionToken,
          serverContext: ctx,
        };
      },
      routineTools: toolCatalog.tools,
      serverName: config.serverName,
    });

  return {
    async handleRequest(session, request, { authInfo }) {
      const serverHandle = createServer(session, session.toolCatalog ?? STATIC_TOOL_CATALOG);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        // Stateless transport lets Cloud Run replace an idle instance without leaving
        // clients with an MCP protocol session identifier tied to that process.
        sessionIdGenerator: undefined,
      });

      await serverHandle.server.connect(transport);
      try {
        return await transport.handleRequest(request, { authInfo });
      } finally {
        // The JSON response is complete once `handleRequest` resolves; closing releases
        // the transport's stream bookkeeping (and the keep-alive timer a GET stream would
        // hold) so nothing about this request outlives its response.
        await serverHandle.server.close();
      }
    },
  };
};

export { toInternalAuthInfo };
