import { describe, expect, it, vi } from "vitest";

import { createHttpServer } from "../src/http/createHttpServer.js";
import { resolveMcpRoute } from "../src/http/resolveMcpRoute.js";
import type { RadiosoMcpConfig } from "../src/config.js";

const config: RadiosoMcpConfig = {
  baseUrl: "http://app.example",
  bindHost: "127.0.0.1",
  bindPort: 0,
  redisKeyPrefix: "test",
  requestTimeoutMs: 1000,
  serverName: "test",
  trustedProxyHops: 0,
};

const PUBLIC_ID = "ag_0123456789abcdefghijkl";

const session = {
  accessTokenHash: "hash",
  expiresAt: new Date(Date.now() + 60_000),
  issuedAt: new Date(),
  conversationId: "conversation-1",
  converseSessionToken: "converse-token",
  sessionId: "walkin_1",
};

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
});

const withServer = async (
  authService: Record<string, unknown>,
  run: (origin: string) => Promise<void>,
) => {
  const server = createHttpServer({ authService: authService as never, config });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await server.close();
  }
};

const walkInAuthService = (overrides: Record<string, unknown> = {}) => ({
  getRequestAuthInfo: vi.fn(),
  getSession: vi.fn(),
  resolveBearerSession: vi.fn(),
  recordSuccessfulUse: vi.fn(),
  resolveWalkInSession: vi.fn().mockResolvedValue({ session, walkInKey: "walk-in-handle-1" }),
  ...overrides,
});

describe("resolveMcpRoute walk-in endpoint", () => {
  it("routes an agent's own endpoint, with or without a trailing slash", () => {
    expect(resolveMcpRoute({ method: "POST", pathname: `/mcp/a/${PUBLIC_ID}` }))
      .toEqual({ kind: "agent_walk_in_mcp", publicId: PUBLIC_ID });
    expect(resolveMcpRoute({ method: "POST", pathname: `/mcp/a/${PUBLIC_ID}/` }))
      .toEqual({ kind: "agent_walk_in_mcp", publicId: PUBLIC_ID });
  });

  it("keeps the reserved server-card path ahead of the endpoint itself", () => {
    expect(resolveMcpRoute({ method: "GET", pathname: `/mcp/a/${PUBLIC_ID}/server-card` }))
      .toEqual({ kind: "agent_server_card", publicId: PUBLIC_ID });
  });

  it("leaves the credential-bound endpoint unchanged", () => {
    expect(resolveMcpRoute({ method: "POST", pathname: "/mcp" })).toEqual({ kind: "agent_mcp" });
  });

  it("refuses a public id that is not a plain path segment", () => {
    expect(resolveMcpRoute({ method: "POST", pathname: "/mcp/a/not a public id" }))
      .toEqual({ kind: "not_found" });
  });
});

describe("walk-in MCP endpoint", () => {
  it("opens a session with no credential and names the handle the client should echo", async () => {
    const authService = walkInAuthService();
    await withServer(authService, async (origin) => {
      const response = await fetch(`${origin}/mcp/a/${PUBLIC_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: initializeBody,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("walk-in-handle-1");
    });

    expect(authService.resolveWalkInSession).toHaveBeenCalledWith(expect.objectContaining({
      publicId: PUBLIC_ID,
      walkInKey: null,
    }));
  });

  it("carries the caller's handle back to the session lookup", async () => {
    const authService = walkInAuthService();
    await withServer(authService, async (origin) => {
      await fetch(`${origin}/mcp/a/${PUBLIC_ID}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "walk-in-handle-1",
        },
        body: initializeBody,
      });
    });

    expect(authService.resolveWalkInSession).toHaveBeenCalledWith(expect.objectContaining({
      walkInKey: "walk-in-handle-1",
    }));
  });

  it("refuses when the agent's walk-in door is closed", async () => {
    const authService = walkInAuthService({ resolveWalkInSession: vi.fn().mockResolvedValue(null) });
    await withServer(authService, async (origin) => {
      const response = await fetch(`${origin}/mcp/a/${PUBLIC_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: initializeBody,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { data: { code: "walk_in_unavailable" } } });
    });
  });
});
