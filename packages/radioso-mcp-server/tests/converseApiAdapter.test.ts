import { describe, expect, it, vi } from "vitest";

import { createConverseApiAdapter } from "../src/converseApiAdapter.js";

describe("converse backend API adapter", () => {
  it("calls exchange, validate, ask, and internal use endpoints without a workspace API bearer", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = createConverseApiAdapter({
      baseUrl: "https://radioso.example",
      signingSecret: "0123456789abcdef0123456789abcdef",
      requestTimeoutMs: 1000,
    }, fetchImpl);

    const source = { sourceDigest: "D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g" };
    await adapter.exchange({ launchToken: "launch", client: { name: "vitest" } }, source);
    await adapter.validate("session", source);
    await adapter.ask("session", { message: "Hello" }, source);
    await adapter.recordUse("session", source);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://radioso.example/api/v1/mcp/converse/session",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-radioso-mcp-source-digest": source.sourceDigest,
          "x-radioso-mcp-source-signature": expect.any(String),
          "x-radioso-mcp-source-timestamp": expect.any(String),
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://radioso.example/api/v1/mcp/converse/session/validate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://radioso.example/api/v1/mcp/converse/ask",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer session",
          "x-radioso-mcp-source-digest": source.sourceDigest,
        }),
      }),
    );
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "https://radioso.example/api/v1/mcp/converse/session/use",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer session",
          "x-radioso-mcp-source-digest": source.sourceDigest,
          "x-radioso-mcp-source-signature": expect.any(String),
        }),
      }),
    );
  });
});
