import type { ServerContext } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";

import { toStructuredToolError } from "./errors.js";
import { createRadiosoApiAdapter, type RadiosoApiAdapter } from "./radiosoApiAdapter.js";
import { createConverseApiAdapter } from "./converseApiAdapter.js";
import { toCallToolResult, toErrorCallToolResult } from "./toolResult.js";
import { createConverseToolDefinitions } from "./tools/converseTools.js";
import { createReadToolDefinitions } from "./tools/readTools.js";
import { createWriteToolDefinitions } from "./tools/writeTools.js";
import type {
  RadiosoMcpConfig,
} from "./config.js";
import type { RemoteToolAuthInfo, ToolDefinition, ToolExecutionContext } from "./types.js";

export interface RadiosoMcpServerContext {
  allowedTools?: string[];
  onToolError?: (
    tool: ToolDefinition,
    context: ToolExecutionContext | null,
    error: ReturnType<typeof toStructuredToolError>,
  ) => Promise<void>;
  onToolResult?: (tool: ToolDefinition, context: ToolExecutionContext, result: Awaited<ReturnType<ToolDefinition["execute"]>>) => Promise<void>;
  serverName: string;
  baseConfig?: Pick<RadiosoMcpConfig, "apiToken" | "baseUrl" | "requestTimeoutMs" | "serverName"> & {
    mcpSourceSigningSecret?: string;
  };
  resolveExecutionContext?: (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ServerContext,
  ) => Promise<ToolExecutionContext>;
}

export interface RadiosoMcpServerHandle {
  server: McpServer;
  toolDefinitions: ToolDefinition[];
}

export const getRemoteToolAuthInfo = (ctx: ServerContext): RemoteToolAuthInfo | null => {
  const authInfo = ctx.http?.authInfo;
  if (authInfo && typeof authInfo === "object" && !Array.isArray(authInfo)) {
    return authInfo as unknown as RemoteToolAuthInfo;
  }

  return null;
};

export const createStaticExecutionContextResolver = (
  baseConfig: Pick<RadiosoMcpConfig, "apiToken" | "baseUrl" | "requestTimeoutMs" | "serverName"> & {
    mcpSourceSigningSecret?: string;
  },
) => {
  return async (_tool: ToolDefinition, _args: Record<string, unknown>, ctx: ServerContext): Promise<ToolExecutionContext> => {
    const authInfo = getRemoteToolAuthInfo(ctx);
    const apiToken = typeof authInfo?.upstreamApiToken === "string" && authInfo.upstreamApiToken.length > 0
      ? authInfo.upstreamApiToken
      : baseConfig.apiToken;

    if (!apiToken) {
      throw new Error("No upstream Radioso API token is bound to the current MCP request.");
    }

    const adapter = createRadiosoApiAdapter({
      ...baseConfig,
      apiToken,
    });
    const converseSessionToken = typeof authInfo?.converseSessionToken === "string" && authInfo.converseSessionToken.length > 0
      ? authInfo.converseSessionToken
      : undefined;

    return {
      adapter,
      authInfo,
      converseAdapter: converseSessionToken
        ? createConverseApiAdapter({
            baseUrl: baseConfig.baseUrl,
            requestTimeoutMs: baseConfig.requestTimeoutMs,
          })
        : undefined,
      converseSessionToken,
      serverContext: ctx,
    };
  };
};

export const createRadiosoMcpServer = ({
  allowedTools,
  baseConfig,
  onToolError,
  onToolResult,
  resolveExecutionContext,
  serverName,
}: RadiosoMcpServerContext): RadiosoMcpServerHandle => {
  const server = new McpServer({
    name: serverName,
    version: "0.1.0",
  });

  const legacyToolDefinitions = [...createReadToolDefinitions(), ...createWriteToolDefinitions()];
  const allToolDefinitions = allowedTools?.includes("ask_agent")
    ? [...legacyToolDefinitions, ...createConverseToolDefinitions()]
    : legacyToolDefinitions;
  const toolDefinitions = typeof allowedTools === "undefined"
    ? allToolDefinitions
    : allToolDefinitions.filter((tool) => allowedTools.includes(tool.name));
  const executionResolver = resolveExecutionContext ?? (baseConfig ? createStaticExecutionContextResolver(baseConfig) : null);

  if (executionResolver === null) {
    throw new Error("MCP server requires either baseConfig or resolveExecutionContext.");
  }

  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, ctx: ServerContext) => {
        let executionContext: ToolExecutionContext | null = null;
        try {
          executionContext = await executionResolver(tool, args as Record<string, unknown>, ctx);
          const result = await tool.execute(args as Record<string, unknown>, executionContext);
          if (onToolResult) {
            await onToolResult(tool, executionContext, result);
          }
          return toCallToolResult(result);
        } catch (error) {
          const structuredError = toStructuredToolError(error);
          if (onToolError) {
            await onToolError(tool, executionContext, structuredError);
          }
          return toErrorCallToolResult(structuredError);
        }
      },
    );
  }

  return {
    server,
    toolDefinitions,
  };
};
