import { createHmac } from "node:crypto";

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

  it("propagates stdio signing config into grounded-answer requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_713_779_200_000);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ answer: "ok", conversationId: "conv_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolver = createStaticExecutionContextResolver({
      apiToken: "sk_proj_stdio",
      baseUrl: "http://localhost:8080",
      mcpSourceSigningSecret: "dev-signing-secret",
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
      "http://localhost:8080/api/v1/chat",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_stdio",
          "x-radioso-source-channel": "mcp",
          "x-radioso-source-signature": createHmac("sha256", "dev-signing-secret")
            .update("mcp\n\n1713779200000\nsk_proj_stdio")
            .digest("hex"),
          "x-radioso-source-timestamp": "1713779200000",
        }),
      }),
    );
  });
});
