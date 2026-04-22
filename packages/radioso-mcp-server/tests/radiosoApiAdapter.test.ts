import { afterEach, describe, expect, it, vi } from "vitest";

import { RadiosoApiError, createRadiosoApiAdapter } from "../src/radiosoApiAdapter.js";

describe("createRadiosoApiAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends bearer auth and JSON bodies to Radioso", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "sk_proj_test",
        baseUrl: "http://localhost:8080",
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await adapter.searchDocuments({ query: "faq" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/document/search",
      expect.objectContaining({
        body: JSON.stringify({ query: "faq" }),
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_test",
          "content-type": "application/json",
        }),
        method: "POST",
      }),
    );
  });

  it("maps error responses to RadiosoApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "Bad token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "bad",
        baseUrl: "http://localhost:8080",
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await expect(adapter.listDocuments()).rejects.toBeInstanceOf(RadiosoApiError);
  });

  it("maps missing capability routes to unsupported_capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "Missing route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "sk_proj_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await expect(adapter.getRetrievalSettings()).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 404,
    });
  });

  it("maps request timeouts to upstream_timeout", async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "sk_proj_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 10,
        serverName: "radioso-test",
      },
      fetchMock as typeof fetch,
    );

    await expect(adapter.listDocuments()).rejects.toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
  });

  it("calls the workspace MCP context route for capability negotiation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        apiVersion: "0.1.0",
        mcpContextVersion: "2026-04-22",
        supportedTools: ["describe_capabilities", "create_document"],
        workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
        workspaceName: "Default",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "sk_proj_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await expect(adapter.getWorkspaceMcpContext()).resolves.toMatchObject({
      workspaceName: "Default",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/workspace/mcp/context",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_test",
        }),
      }),
    );
  });

  it("marks grounded answers as MCP-originated chat traffic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ conversationId: "conv_123", answer: "Hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "sk_proj_test",
        baseUrl: "http://localhost:8080",
        mcpSourceSigningSecret: "dev-signing-secret",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await adapter.answerGrounded({ query: "hello" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/chat",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_test",
          "x-radioso-source-channel": "mcp",
          "x-radioso-source-signature": expect.stringMatching(/^[0-9a-f]{64}$/),
          "x-radioso-source-timestamp": expect.stringMatching(/^\d{13}$/),
        }),
      }),
    );
  });
});
