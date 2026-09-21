import { describe, expect, it, vi } from "vitest";

import { createConverseToolDefinitions } from "../src/tools/converseTools.js";
import { createRadiosoMcpServer } from "../src/server.js";
import type { ConverseApiAdapter, ConverseAskResponse } from "../src/converseApiAdapter.js";
import { toCallToolResult } from "../src/toolResult.js";
import type { ToolExecutionContext } from "../src/types.js";

describe("converse MCP tools", () => {
  it("exposes only ask_agent for the public converse surface", () => {
    expect(createConverseToolDefinitions().map((tool) => tool.name)).toEqual(["ask_agent"]);

    const server = createRadiosoMcpServer({
      resolveExecutionContext: async () => ({
        authInfo: null,
        converseAdapter: {} as ConverseApiAdapter,
        converseSessionToken: "session-token",
        serverContext: {} as ToolExecutionContext["serverContext"],
      }),
      serverName: "radioso-converse-test",
    });

    // Radioso's own documentation joins the converse tool on this surface; the workspace's
    // documents stay behind ask_agent.
    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "ask_agent",
      "radioso_docs",
      "radioso_doc_page",
    ]);
    expect(server.toolDefinitions.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "list_documents",
      "get_document",
      "search_documents",
      "create_document",
    ]));
  });

  it("forwards the agent reply envelope unchanged as data and keeps answer.text as the summary", async () => {
    const envelope: ConverseAskResponse = {
      conversationId: "conversation-1",
      answer: {
        text: "Hello",
        citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Refund policy", sourceUrl: "https://example.com/refunds" }],
      },
      answerCoverage: {
        availability: "assessed",
        coverage: "answered",
        reason: "sufficient_evidence",
        originatingTurnId: "request-1",
        originatingRequestId: "request-1",
      },
      ownership: { state: "ai_owned", suppressed: false },
      routine: {
        name: "Book a demo",
        status: "waiting_for_input",
        pendingInput: [{ key: "email", type: "email", required: true }],
      },
      traceId: "trace-1",
    };
    const converseAdapter: ConverseApiAdapter = {
      ask: vi.fn().mockResolvedValue(envelope),
      exchange: vi.fn(),
      validate: vi.fn(),
      recordUse: vi.fn(),
    };
    const [askAgent] = createConverseToolDefinitions();

    const result = await askAgent.execute(
      { message: "Hello" },
      {
        authInfo: null,
        converseAdapter,
        converseSessionToken: "session-token",
        serverContext: {} as ToolExecutionContext["serverContext"],
      },
    );

    expect(converseAdapter.ask).toHaveBeenCalledWith("session-token", { message: "Hello" }, { sourceDigest: undefined });
    expect(result.data).toEqual(envelope);
    expect(result.summary).toBe("Hello");
    expect(toCallToolResult(result).structuredContent).toEqual(envelope);
  });
});
