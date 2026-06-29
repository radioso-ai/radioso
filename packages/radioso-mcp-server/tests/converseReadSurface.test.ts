import { describe, expect, it, vi } from "vitest";

import { createConverseApiAdapter, type ConverseApiAdapter } from "../src/converseApiAdapter.js";
import {
  createConverseReadToolDefinitions,
  listConverseResources,
  readConverseResource,
} from "../src/tools/converseReadTools.js";
import type { ToolExecutionContext } from "../src/types.js";

const contextWith = (converseAdapter: ConverseApiAdapter): ToolExecutionContext => ({
  adapter: {} as ToolExecutionContext["adapter"],
  authInfo: null,
  converseAdapter,
  converseSessionToken: "session-token",
  serverContext: {} as ToolExecutionContext["serverContext"],
});

describe("converse read MCP surface", () => {
  it("calls the converse backend endpoint for answer_grounded", async () => {
    const converseAdapter: ConverseApiAdapter = {
      answerGrounded: vi.fn().mockResolvedValue({
        answer: "Grounded answer",
        citations: [],
        retrieval: { agentScoped: true },
      }),
      ask: vi.fn(),
      exchange: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      validate: vi.fn(),
    };
    const [answerGrounded] = createConverseReadToolDefinitions();

    const result = await answerGrounded.execute(
      { query: "Which policy applies?", maxResults: 4 },
      contextWith(converseAdapter),
    );

    expect(converseAdapter.answerGrounded).toHaveBeenCalledWith("session-token", {
      query: "Which policy applies?",
      maxResults: 4,
    });
    expect(result).toMatchObject({
      summary: "Grounded answer",
      data: { retrieval: { agentScoped: true } },
    });
  });

  it("calls converse backend list/read resource endpoints", async () => {
    const converseAdapter: ConverseApiAdapter = {
      answerGrounded: vi.fn(),
      ask: vi.fn(),
      exchange: vi.fn(),
      listResources: vi.fn().mockResolvedValue({
        resources: [{ uri: "radioso://agent-resource/opaque", name: "Policy", mimeType: "text/markdown" }],
      }),
      readResource: vi.fn().mockResolvedValue({
        uri: "radioso://agent-resource/opaque",
        name: "Policy",
        mimeType: "text/markdown",
        text: "Policy body",
      }),
      validate: vi.fn(),
    };

    await expect(listConverseResources(contextWith(converseAdapter))).resolves.toMatchObject({
      resources: [{ uri: "radioso://agent-resource/opaque" }],
    });
    await expect(readConverseResource(contextWith(converseAdapter), "radioso://agent-resource/opaque"))
      .resolves.toMatchObject({ text: "Policy body" });

    expect(converseAdapter.listResources).toHaveBeenCalledWith("session-token");
    expect(converseAdapter.readResource).toHaveBeenCalledWith("session-token", "opaque");
  });

  it("adds grounded answer and resource HTTP methods without workspace API bearer", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        answer: "ok",
        citations: [],
        retrieval: { agentScoped: true },
        resources: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = createConverseApiAdapter({
      baseUrl: "https://radioso.example",
      requestTimeoutMs: 1000,
    }, fetchImpl as typeof fetch);

    await adapter.answerGrounded("session", { query: "Hello" });
    await adapter.listResources("session");
    await adapter.readResource("session", "opaque");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://radioso.example/api/v1/mcp/converse/grounded-answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://radioso.example/api/v1/mcp/converse/resources",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://radioso.example/api/v1/mcp/converse/resources/opaque",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
  });
});
