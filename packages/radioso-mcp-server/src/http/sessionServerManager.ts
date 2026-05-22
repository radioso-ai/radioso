import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { AuditLogger } from "../audit/auditLogger.js";
import { AuthServiceError } from "../auth/authService.js";
import { toMcpRequestAuthInfo } from "../auth/authInfo.js";
import type { AccessSessionRecord } from "../auth/sessionStore.js";
import type { RadiosoMcpConfig } from "../config.js";
import { CapabilityPolicyError } from "../policy/capabilityPolicy.js";
import { createRadiosoApiAdapter } from "../radiosoApiAdapter.js";
import { createRadiosoMcpServer, getRemoteToolAuthInfo } from "../server.js";
import type { ToolDefinition } from "../types.js";
import type { InternalMcpRequestAuthInfo, SessionMcpServerHandle, SessionMcpServerManager } from "./types.js";

const toInternalAuthInfo = (session: AccessSessionRecord, accessToken: string): InternalMcpRequestAuthInfo => ({
  ...toMcpRequestAuthInfo(session),
  accessToken,
  clientId: session.clientName ?? session.sessionId,
  scopes: [...session.grantedTools],
  token: accessToken,
  upstreamApiToken: session.upstreamApiToken,
});

export interface SessionServerManagerDependencies {
  auditLogger?: AuditLogger;
  config: RadiosoMcpConfig;
  entryPoint?: "merged" | "standalone";
}

export const createSessionMcpServerManager = ({
  auditLogger,
  config,
  entryPoint = "standalone",
}: SessionServerManagerDependencies): SessionMcpServerManager => {
  const sessionHandles = new Map<string, SessionMcpServerHandle>();
  const toToolCatalogKey = (grantedTools: string[]) => [...grantedTools].sort().join("\u0000");
  const requiresApproval = (toolName: string, approvalRequiredTools?: string[]) =>
    approvalRequiredTools?.includes(toolName) ?? false;

  const createSessionHandle = async (
    session: AccessSessionRecord,
  ): Promise<SessionMcpServerHandle> => {
    const toolCatalogKey = toToolCatalogKey(session.grantedTools);
    const serverHandle = createRadiosoMcpServer({
      allowedTools: session.grantedTools,
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
            requiresApproval: requiresApproval(
              tool.name,
              context?.authInfo?.approvalRequiredTools ?? session.approvalRequiredTools,
            ),
          },
          outcome:
            error.code.includes("forbidden") || error.code.includes("required") || error.code.includes("invalid")
              ? "denied"
              : "error",
          sessionId: context?.authInfo?.sessionId,
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
            requiresApproval: requiresApproval(
              tool.name,
              context.authInfo?.approvalRequiredTools ?? session.approvalRequiredTools,
            ),
          },
          outcome: "success",
          sessionId: context.authInfo?.sessionId,
          toolName: tool.name,
        });
      },
      resolveExecutionContext: async (tool: ToolDefinition, _rawArgs, ctx) => {
        const authInfo = getRemoteToolAuthInfo(ctx) as InternalMcpRequestAuthInfo | null;
        if (!authInfo?.accessToken || !authInfo.upstreamApiToken) {
          throw new AuthServiceError("MCP request is missing authenticated session context.", "invalid_access_token");
        }

        if (!authInfo.grantedTools.includes(tool.name)) {
          throw new CapabilityPolicyError("Requested tool is not granted for this session.", "capability_forbidden", {
            toolName: tool.name,
          });
        }

        return {
          adapter: createRadiosoApiAdapter({
            ...config,
            apiToken: authInfo.upstreamApiToken,
            mcpSourceSigningSecret: config.signingSecret,
          }),
          authInfo,
          serverContext: ctx,
        };
      },
      serverName: config.serverName,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    await serverHandle.server.connect(transport);

    return {
      serverHandle,
      toolCatalogKey,
      transport,
    };
  };

  return {
    async evict(toolCatalogKey) {
      sessionHandles.delete(toolCatalogKey);
    },
    async getOrCreate(session) {
      const toolCatalogKey = toToolCatalogKey(session.grantedTools);
      const existing = sessionHandles.get(toolCatalogKey);
      if (existing) {
        return existing;
      }

      const handle = await createSessionHandle(session);
      sessionHandles.set(toolCatalogKey, handle);
      return handle;
    },
  };
};

export { toInternalAuthInfo };
