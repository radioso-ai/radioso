import { describe, expect, it, vi } from "vitest";

import { createConverseApiAdapter } from "../src/converseApiAdapter.js";

describe("converse backend API adapter", () => {
  it("calls exchange, validate, and ask endpoints without a workspace API bearer", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = createConverseApiAdapter({
      baseUrl: "https://radioso.example",
      requestTimeoutMs: 1000,
    }, fetchImpl as typeof fetch);

    await adapter.exchange({ launchToken: "launch", client: { name: "vitest" } });
    await adapter.validate("session");
    await adapter.ask("session", { message: "Hello" });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://radioso.example/api/v1/mcp/converse/session",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
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
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
  });
});
