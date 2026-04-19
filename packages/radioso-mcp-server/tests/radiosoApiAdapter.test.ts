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
});
