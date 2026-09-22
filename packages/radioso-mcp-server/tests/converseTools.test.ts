import { describe, expect, it, vi } from "vitest";

import { createConverseToolDefinitions } from "../src/tools/converseTools.js";
import { createRoutineToolDefinitions } from "../src/tools/routineTools.js";
import { createRadiosoMcpServer } from "../src/server.js";
import type { AgentToolDescriptor, ConverseApiAdapter, ConverseAskResponse } from "../src/converseApiAdapter.js";
import { toCallToolResult } from "../src/toolResult.js";
import type { ToolExecutionContext } from "../src/types.js";

const startReturnDescriptor: AgentToolDescriptor = {
  toolName: "start_return",
  description: "Start a return for an order.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order number" },
      reason: { type: "string" },
    },
    required: ["orderId"],
    additionalProperties: false,
  },
  routineLineageId: "lineage-start-return",
};

const requestCallbackDescriptor: AgentToolDescriptor = {
  toolName: "request_callback",
  description: "Ask for a callback.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  routineLineageId: "lineage-request-callback",
};

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

const createConverseAdapter = (): ConverseApiAdapter => ({
  ask: vi.fn().mockResolvedValue(envelope),
  exchange: vi.fn(),
  validate: vi.fn(),
  recordUse: vi.fn(),
  tools: vi.fn(),
});

const executionContext = (converseAdapter: ConverseApiAdapter): ToolExecutionContext => ({
  authInfo: null,
  converseAdapter,
  converseSessionToken: "session-token",
  serverContext: {} as ToolExecutionContext["serverContext"],
});

describe("converse MCP tools", () => {
  it("exposes ask_agent and the documentation tools when the session's catalog has no routines", () => {
    expect(createConverseToolDefinitions().map((tool) => tool.name)).toEqual(["ask_agent"]);

    const server = createRadiosoMcpServer({
      resolveExecutionContext: async () => executionContext(createConverseAdapter()),
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

  it("adds one tool per routine descriptor after the static tools", () => {
    const server = createRadiosoMcpServer({
      resolveExecutionContext: async () => executionContext(createConverseAdapter()),
      routineTools: [startReturnDescriptor, requestCallbackDescriptor],
      serverName: "radioso-converse-test",
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "ask_agent",
      "radioso_docs",
      "radioso_doc_page",
      "start_return",
      "request_callback",
    ]);
    const startReturn = server.toolDefinitions.find((tool) => tool.name === "start_return");
    expect(startReturn?.description).toBe("Start a return for an order.");
  });

  it("skips a descriptor whose name collides with a static tool and warns instead of failing", () => {
    const warn = vi.fn();
    const server = createRadiosoMcpServer({
      resolveExecutionContext: async () => executionContext(createConverseAdapter()),
      routineTools: [
        { ...startReturnDescriptor, toolName: "ask_agent" },
        { ...requestCallbackDescriptor, toolName: "radioso_docs" },
        startReturnDescriptor,
      ],
      serverName: "radioso-converse-test",
      warn,
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "ask_agent",
      "radioso_docs",
      "radioso_doc_page",
      "start_return",
    ]);
    expect(server.toolDefinitions.filter((tool) => tool.name === "ask_agent")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("ask_agent"),
      expect.stringContaining("radioso_docs"),
    ]);
  });

  it("forwards the agent reply envelope unchanged as data and keeps answer.text as the summary", async () => {
    const converseAdapter = createConverseAdapter();
    const [askAgent] = createConverseToolDefinitions();

    const result = await askAgent.execute({ message: "Hello" }, executionContext(converseAdapter));

    expect(converseAdapter.ask).toHaveBeenCalledWith("session-token", { message: "Hello" }, { sourceDigest: undefined });
    expect(result.data).toEqual(envelope);
    expect(result.summary).toBe("Hello");
    expect(toCallToolResult(result).structuredContent).toEqual(envelope);
  });

  it("calls a routine tool as a routine invocation and forwards the envelope as structuredContent", async () => {
    const converseAdapter = createConverseAdapter();
    const [startReturn] = createRoutineToolDefinitions([startReturnDescriptor]);

    const result = await startReturn.execute(
      { orderId: "A-1001", reason: "Wrong size" },
      { ...executionContext(converseAdapter), authInfo: { sessionId: "session-1", sourceDigest: "digest-1" } },
    );

    expect(converseAdapter.ask).toHaveBeenCalledWith(
      "session-token",
      { routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } } },
      { sourceDigest: "digest-1" },
    );
    expect(result.data).toEqual(envelope);
    expect(result.summary).toBe("Hello");
    expect(toCallToolResult(result).structuredContent).toEqual(envelope);
  });

  it("refuses to run a routine tool without a bound converse session", async () => {
    const [startReturn] = createRoutineToolDefinitions([startReturnDescriptor]);

    await expect(startReturn.execute({ orderId: "A-1001" }, {
      authInfo: null,
      serverContext: {} as ToolExecutionContext["serverContext"],
    })).rejects.toThrow(/converse session/i);
  });
});
