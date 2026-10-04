import type { ServerContext } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";

import type { AgentToolDescriptor } from "./converseApiAdapter.js";
import { toStructuredToolError } from "./errors.js";
import { toCallToolResult, toErrorCallToolResult } from "./toolResult.js";
import { createConversationUpdatesToolDefinitions } from "./tools/conversationUpdatesTools.js";
import { createConverseToolDefinitions } from "./tools/converseTools.js";
import { createProductDocsToolDefinitions } from "./tools/productDocsTools.js";
import { createRoutineToolDefinitions } from "./tools/routineTools.js";
import type { RemoteToolAuthInfo, ToolDefinition, ToolExecutionContext } from "./types.js";

export interface RadiosoMcpServerContext {
  onToolError?: (
    tool: ToolDefinition,
    context: ToolExecutionContext | null,
    error: ReturnType<typeof toStructuredToolError>,
  ) => Promise<void>;
  onToolResult?: (tool: ToolDefinition, context: ToolExecutionContext, result: Awaited<ReturnType<ToolDefinition["execute"]>>) => Promise<void>;
  /**
   * A routine tool call whose arguments missed the descriptor's schema. The SDK answers
   * it as a tool error before the handler runs, so this is the only hook that sees it.
   */
  onToolInputRejected?: (tool: ToolDefinition) => Promise<void>;
  serverName: string;
  resolveExecutionContext?: (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ServerContext,
  ) => Promise<ToolExecutionContext>;
  /** The session's exposed routines, one tool each, listed after the static tools. */
  routineTools?: AgentToolDescriptor[];
  /**
   * The `ask_agent` description this agent's catalog composed. Absent when the catalog could not be
   * read, in which case the tool keeps a generic description rather than describing nothing.
   */
  askAgentDescription?: string;
  warn?: (message: string) => void;
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

/**
 * The backend refuses reserved tool names at publish time, so a collision here means the
 * two sides disagree about that list. The static tool wins and the routine is left out of
 * this server rather than failing every session that shares the catalog.
 */
const withoutStaticNameCollisions = (
  staticTools: ToolDefinition[],
  routineTools: AgentToolDescriptor[],
  warn: (message: string) => void,
): AgentToolDescriptor[] => {
  const staticNames = new Set(staticTools.map((tool) => tool.name));
  return routineTools.filter((descriptor) => {
    if (!staticNames.has(descriptor.toolName)) {
      return true;
    }
    warn(`Skipping routine tool "${descriptor.toolName}": the name belongs to a static MCP tool.`);
    return false;
  });
};

export const createRadiosoMcpServer = ({
  onToolError,
  onToolInputRejected,
  onToolResult,
  resolveExecutionContext,
  routineTools = [],
  askAgentDescription,
  serverName,
  warn = console.warn,
}: RadiosoMcpServerContext): RadiosoMcpServerHandle => {
  const server = new McpServer({
    name: serverName,
    version: "0.1.0",
  });

  const converseToolDefinitions = [
    ...createConverseToolDefinitions(askAgentDescription),
    // Resumption sits beside ask_agent: the same session, read instead of written.
    ...createConversationUpdatesToolDefinitions(),
  ];
  // Documentation tools sit beside the converse tool rather than behind a flag: a client that
  // can reach this server is already authorized for the workspace, and the corpus is the same
  // public documentation for every one of them.
  const staticToolDefinitions = [...converseToolDefinitions, ...createProductDocsToolDefinitions()];
  const toolDefinitions = [
    ...staticToolDefinitions,
    ...createRoutineToolDefinitions(withoutStaticNameCollisions(staticToolDefinitions, routineTools, warn), {
      onInputRejected: onToolInputRejected,
    }),
  ];
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
