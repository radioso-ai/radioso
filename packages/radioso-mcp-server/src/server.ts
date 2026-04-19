import { McpServer } from "@modelcontextprotocol/server";

import { toStructuredToolError } from "./errors.js";
import type { RadiosoApiAdapter } from "./radiosoApiAdapter.js";
import { toCallToolResult, toErrorCallToolResult } from "./toolResult.js";
import { createReadToolDefinitions } from "./tools/readTools.js";
import { createWriteToolDefinitions } from "./tools/writeTools.js";
import type { ToolDefinition } from "./types.js";

export interface RadiosoMcpServerContext {
  adapter: RadiosoApiAdapter;
  serverName: string;
}

export interface RadiosoMcpServerHandle {
  server: McpServer;
  toolDefinitions: ToolDefinition[];
}

export const createRadiosoMcpServer = ({ adapter, serverName }: RadiosoMcpServerContext): RadiosoMcpServerHandle => {
  const server = new McpServer({
    name: serverName,
    version: "0.1.0",
  });

  const toolDefinitions = [...createReadToolDefinitions(adapter), ...createWriteToolDefinitions(adapter)];

  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        try {
          const result = await tool.execute(args as Record<string, unknown>);
          return toCallToolResult(result);
        } catch (error) {
          return toErrorCallToolResult(toStructuredToolError(error));
        }
      },
    );
  }

  return {
    server,
    toolDefinitions,
  };
};
