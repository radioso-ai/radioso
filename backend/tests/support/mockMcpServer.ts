import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Generic, in-process mock MCP server for tests. Integration-agnostic: callers
 * declare arbitrary tools (name, description, JSON input schema) and a response
 * function, including success (text + structuredContent), `isError`, and
 * distinct payloads for fine-grained outcome tests. No provider-specific content.
 */
export interface MockToolResult {
  content?: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  respond: (args: Record<string, unknown>) => MockToolResult | Promise<MockToolResult>;
}

export const createMockMcpServer = (tools: MockTool[]): Server => {
  const server = new Server(
    { name: "mock-mcp-server", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object" }) as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${request.params.name}` }], isError: true };
    }
    const result = await tool.respond((request.params.arguments ?? {}) as Record<string, unknown>);
    return {
      content: result.content ?? [],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {}),
    };
  });

  return server;
};

/**
 * Connect a mock server over an in-memory transport pair and return the client
 * side transport for injection into the ToolService under test.
 */
export const connectMockMcpServer = async (
  tools: MockTool[],
): Promise<{ server: Server; clientTransport: Transport }> => {
  const server = createMockMcpServer(tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
};
