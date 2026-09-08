import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient, RadiosoError } from "../../src/index.js";

describe("sdk errors", () => {
  it("normalizes structured backend errors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "No token",
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock,
    });

    await expect(client.settings.getGeneral()).rejects.toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      status: 401,
    } satisfies Partial<RadiosoError>));
  });

  it("falls back to a generic HTTP error for non-json failures", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("bad gateway", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock,
    });

    await expect(client.documents.list()).rejects.toEqual(expect.objectContaining({
      code: "HTTP_ERROR",
      status: 502,
    } satisfies Partial<RadiosoError>));
  });
});
