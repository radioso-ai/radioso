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
        apiToken: "radioso_test",
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
          authorization: "Bearer radioso_test",
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
        apiToken: "radioso_test",
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

  it("maps missing retrieval answer routes to unsupported_capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "not_found", message: "Missing route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "radioso_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await expect(adapter.answerGrounded({
      query: "hello",
    })).rejects.toMatchObject({
      code: "unsupported_capability",
      message: "Missing route",
      status: 404,
    });
  });

  it("maps request timeouts to upstream_timeout", async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "radioso_test",
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
        mcpContextVersion: "2026-05-06",
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
        apiToken: "radioso_test",
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
          authorization: "Bearer radioso_test",
        }),
      }),
    );
  });

  it("calls retrieval answer without assistant source headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: "answer", answer: "Hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "radioso_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await adapter.answerGrounded({ query: "hello" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/retrieval/answer",
      expect.objectContaining({
        body: JSON.stringify({ query: "hello" }),
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer radioso_test",
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

  it("calls assistant chat with MCP source context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          apiVersion: "0.1.0",
          mcpContextVersion: "2026-05-06",
          supportedTools: ["chat_with_assistant"],
          workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
          workspaceName: "Default",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ answer: "Hello", conversationId: "conversation-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "radioso_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await adapter.chatWithAssistant({
      conversationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      message: "hello",
      metadataFilter: { audience: "support" },
      userExpectedLocale: "en",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8080/api/v1/assistant/chat",
      expect.objectContaining({
        body: JSON.stringify({
          conversationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          message: "hello",
          metadataFilter: { audience: "support" },
          sourceContext: {
            surface: "mcp",
            sourceOrigin: "radioso-test",
          },
          stream: false,
          userExpectedLocale: "en",
        }),
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer radioso_test",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("rejects assistant chat when upstream MCP context does not support it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        apiVersion: "0.1.0",
        mcpContextVersion: "2026-05-06",
        supportedTools: ["answer_grounded"],
        workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
        workspaceName: "Default",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const adapter = createRadiosoApiAdapter(
      {
        apiToken: "radioso_test",
        baseUrl: "http://localhost:8080",
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
      fetchMock,
    );

    await expect(adapter.chatWithAssistant({ message: "hello" })).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
