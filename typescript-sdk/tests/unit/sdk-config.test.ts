import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

describe("sdk config", () => {
  it("rejects an empty api token", () => {
    expect(() => createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "   ",
    })).toThrow("apiToken");
  });

  it("uses bearer auth and trims the base url", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ workspaceId: "w1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com///",
      apiToken: "token-123",
      fetch: fetchMock as typeof fetch,
    });

    await client.settings.getRetrieval();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/settings/retrieval",
      expect.objectContaining({
        headers: expect.any(Headers),
        method: "GET",
      }),
    );

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = (firstCall as unknown[] | undefined)?.[1] as RequestInit | undefined;
    expect(init).toBeDefined();
    if (!init) {
      throw new Error("Expected fetch init to be defined.");
    }
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer token-123");
  });
});
