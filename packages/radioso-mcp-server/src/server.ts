import type { ServerContext } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";

import { toStructuredToolError } from "./errors.js";
import { toCallToolResult, toErrorCallToolResult } from "./toolResult.js";
import { createConverseToolDefinitions } from "./tools/converseTools.js";
import type { RemoteToolAuthInfo, ToolDefinition, ToolExecutionContext } from "./types.js";

export interface RadiosoMcpServerContext {
  onToolError?: (
    tool: ToolDefinition,
    context: ToolExecutionContext | null,
    error: ReturnType<typeof toStructuredToolError>,
  ) => Promise<void>;
  onToolResult?: (tool: ToolDefinition, context: ToolExecutionContext, result: Awaited<ReturnType<ToolDefinition["execute"]>>) => Promise<void>;
  serverName: string;
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

export const createRadiosoMcpServer = ({
  onToolError,
  onToolResult,
  resolveExecutionContext,
  serverName,
}: RadiosoMcpServerContext): RadiosoMcpServerHandle => {
  const server = new McpServer({
    name: serverName,
    version: "0.1.0",
  });

  const converseToolDefinitions = createConverseToolDefinitions();
  const toolDefinitions = converseToolDefinitions;
  const executionResolver = resolveExecutionContext;

  if (!executionResolver) {
    throw new Error("MCP server requires an execution-context resolver.");
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
