import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";

describe("remote MCP HTTP error boundary", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }

    vi.doUnmock("../src/http/mcpRoutes.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns a JSON-RPC internal error when the MCP route throws unexpectedly", async () => {
    vi.doMock("../src/http/mcpRoutes.js", () => ({
      createMcpRouteHandler: () => async () => {
        throw new Error("route exploded");
      },
    }));

    const { createHttpServer } = await import("../src/http/createHttpServer.js");
    const authService = createAuthService({
      converseApi: {
        ask: vi.fn(),
        exchange: vi.fn(),
        validate: vi.fn(),
      },
      sessionStore: createInMemorySessionStore(),
    });
    const server = createHttpServer({
      authService,
      config: {
        baseUrl: "http://radioso.test",
        bindHost: "127.0.0.1",
        bindPort: 0,
        requestTimeoutMs: 30_000,
        serverName: "radioso-test",
      },
    });
    servers.push(server);

    await server.listen();

    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      body: JSON.stringify({
        id: "1",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32603,
        data: {
          code: "internal_error",
        },
        message: "Internal error",
      },
      id: null,
      jsonrpc: "2.0",
    });
  });
});
