import { describe, expect, it, vi } from "vitest";

import {
  createHttpMcpToolService,
  createMcpToolService,
  type McpJsonRpcTransport,
  type ToolFetch,
  type ToolFetchResponse,
} from "../src/index.js";

describe("MCP adapter", () => {
  it("lists and calls MCP tools through an injected transport", async () => {
    const transport: McpJsonRpcTransport = {
      async request(method, params) {
        if (method === "tools/list") {
          return {
            tools: [{
              name: "lookup",
              description: "Looks up data",
              inputSchema: { type: "object" },
            }],
          } as never;
        }
        expect(method).toBe("tools/call");
        expect(params).toEqual({ name: "lookup", arguments: { id: "1" } });
        return {
          content: [{ type: "text", text: "Found it" }],
          structuredContent: { id: "1" },
        } as never;
      },
    };
    const service = createMcpToolService(transport);

    await expect(service.listTools()).resolves.toEqual([expect.objectContaining({
      name: "lookup",
      metadata: { transport: "mcp" },
    })]);
    await expect(service.callTool({ toolName: "lookup", input: { id: "1" } })).resolves.toMatchObject({
      status: "completed",
      answer: "Found it",
      outputs: { id: "1" },
    });
  });

  it("posts JSON-RPC requests through the HTTP transport", async () => {
    const fetchMock = vi.fn<ToolFetch>(async (_url, init): Promise<ToolFetchResponse> => {
      expect(init?.body).toContain("\"method\":\"tools/list\"");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { jsonrpc: "2.0", id: "1", result: { tools: [] } };
        },
        async text() {
          return "";
        },
      };
    });

    const service = createHttpMcpToolService({
      endpoint: "http://mcp.test/mcp",
      headers: { authorization: "Bearer test" },
      fetch: fetchMock,
    });

    await expect(service.listTools()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("http://mcp.test/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer test",
        "content-type": "application/json",
      }),
    }));
  });
});
