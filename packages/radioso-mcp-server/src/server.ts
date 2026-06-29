import type { ServerContext } from "@modelcontextprotocol/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

import { toStructuredToolError } from "./errors.js";
import { createRadiosoApiAdapter, type RadiosoApiAdapter } from "./radiosoApiAdapter.js";
import { createConverseApiAdapter } from "./converseApiAdapter.js";
import { toCallToolResult, toErrorCallToolResult } from "./toolResult.js";
import {
  createConverseReadToolDefinitions,
  listConverseResources,
  readConverseResource,
} from "./tools/converseReadTools.js";
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
  const converseToolDefinitions = [
    ...createConverseToolDefinitions(),
    ...createConverseReadToolDefinitions(),
  ];
  // A session is either the workspace document surface or the per-agent converse surface,
  // never both — they use different credentials. Pick exactly one catalog so the two surfaces
  // never merge into one server. `ask_agent` is unique to the converse surface; the converse
  // `answer_grounded` shares its name with the legacy workspace tool, so it cannot be the
  // discriminator (and merging both catalogs would double-register that name and 500).
  const isConverseSurface = allowedTools?.includes("ask_agent") ?? false;
  const activeToolDefinitions = isConverseSurface ? converseToolDefinitions : legacyToolDefinitions;
  const toolDefinitions = typeof allowedTools === "undefined"
    ? activeToolDefinitions
    : activeToolDefinitions.filter((tool) => allowedTools.includes(tool.name));
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

  // Agent resources belong only to the converse surface.
  const resourcesEnabled = isConverseSurface;

  if (resourcesEnabled) {
    const resourceDefinition: ToolDefinition = {
      accessMode: "read",
      description:
        "Read-only access to the documents this Radioso agent can see, exposed as resources to list and fetch. Content is sanitized for sharing (no internal document or chunk IDs). Cannot create, modify, or delete documents.",
      execute: async () => ({ data: null, summary: "" }),
      inputSchema: {},
      name: "agent_resources",
    };
    server.registerResource(
      "agent_resources",
      new ResourceTemplate("radioso://agent-resource/{resourceId}", {
        list: async (ctx) => {
          const executionContext = await executionResolver(resourceDefinition, {}, ctx);
          const response = await listConverseResources(executionContext);
          return {
            resources: response.resources.map((resource) => ({
              uri: resource.uri,
              name: resource.name,
              title: resource.name,
              mimeType: resource.mimeType,
            })),
          };
        },
      }),
      {
        title: "Radioso Agent Resources",
        description:
          "Documents this Radioso agent can see, available read-only. Sanitized for sharing; use to read source material, not to manage documents.",
        mimeType: "text/markdown",
      },
      async (uri, _variables, ctx) => {
        const executionContext = await executionResolver(resourceDefinition, { uri: uri.href }, ctx);
        const resource = await readConverseResource(executionContext, uri.href);
        return {
          contents: [{
            uri: resource.uri,
            name: resource.name,
            title: resource.name,
            mimeType: resource.mimeType,
            text: resource.text,
          }],
        };
      },
    );
  }

  return {
    server,
    toolDefinitions,
  };
};
