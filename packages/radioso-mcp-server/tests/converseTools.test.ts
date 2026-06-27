import { describe, expect, it, vi } from "vitest";

import { createConverseToolDefinitions } from "../src/tools/converseTools.js";
import { createRadiosoMcpServer } from "../src/server.js";
import type { ConverseApiAdapter } from "../src/converseApiAdapter.js";
import type { ToolExecutionContext } from "../src/types.js";

describe("converse MCP tools", () => {
  it("exposes only ask_agent for the public converse surface", () => {
    expect(createConverseToolDefinitions().map((tool) => tool.name)).toEqual(["ask_agent"]);

    const server = createRadiosoMcpServer({
      allowedTools: ["ask_agent"],
      resolveExecutionContext: async () => ({
        adapter: {} as ToolExecutionContext["adapter"],
        authInfo: null,
        converseAdapter: {} as ConverseApiAdapter,
        converseSessionToken: "session-token",
        serverContext: {} as ToolExecutionContext["serverContext"],
      }),
      serverName: "radioso-converse-test",
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual(["ask_agent"]);
    expect(server.toolDefinitions.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "list_documents",
      "get_document",
      "search_documents",
      "create_document",
      "update_document",
      "delete_document",
      "reprocess_document",
    ]));
  });

  it("calls the converse backend adapter for ask_agent", async () => {
    const converseAdapter: ConverseApiAdapter = {
      ask: vi.fn().mockResolvedValue({
        conversationId: "conversation-1",
        answer: { text: "Hello", citations: [] },
      }),
      exchange: vi.fn(),
      validate: vi.fn(),
    };
    const [askAgent] = createConverseToolDefinitions();

    const result = await askAgent.execute(
      { message: "Hello" },
      {
        adapter: {} as ToolExecutionContext["adapter"],
        authInfo: null,
        converseAdapter,
        converseSessionToken: "session-token",
        serverContext: {} as ToolExecutionContext["serverContext"],
      },
    );

    expect(converseAdapter.ask).toHaveBeenCalledWith("session-token", { message: "Hello" });
    expect(result).toMatchObject({
      data: { conversationId: "conversation-1" },
      summary: "Hello",
    });
  });
});
