import { afterEach, describe, expect, it, vi } from "vitest";

import { createRadiosoMcpServer, createStaticExecutionContextResolver } from "../src/server.js";

describe("createRadiosoMcpServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes all read and write tool definitions", () => {
    const resolveExecutionContext = vi.fn();
    const server = createRadiosoMcpServer({
      resolveExecutionContext,
      serverName: "radioso-test",
    });

    expect(server.toolDefinitions).toHaveLength(11);
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("answer_grounded");
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("update_retrieval_settings");
  });

  it("filters tool registration to the allowed session catalog", () => {
    const server = createRadiosoMcpServer({
      allowedTools: ["describe_capabilities", "list_documents"],
      resolveExecutionContext: vi.fn(),
      serverName: "radioso-test",
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
    ]);
  });

  it("refuses to boot without an execution-context seam", () => {
    expect(() =>
      createRadiosoMcpServer({
        serverName: "radioso-test",
      }),
    ).toThrow(/baseConfig or resolveExecutionContext/i);
  });

  it("routes grounded-answer requests through retrieval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: "answer", answer: "ok" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolver = createStaticExecutionContextResolver({
      apiToken: "sk_proj_stdio",
      baseUrl: "http://localhost:8080",
      requestTimeoutMs: 30_000,
      serverName: "radioso-test",
    });

    const context = await resolver(
      { name: "answer_grounded" } as any,
      {},
      {} as any,
    );

    await context.adapter.answerGrounded({ query: "hello" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/retrieval/answer",
      expect.objectContaining({
        body: JSON.stringify({ query: "hello" }),
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_stdio",
          "content-type": "application/json",
          "x-radioso-capability-client": "mcp",
        }),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("x-radioso-source-channel");
    expect(headers).not.toHaveProperty("x-radioso-source-signature");
    expect(headers).not.toHaveProperty("x-radioso-source-timestamp");
  });
});
