import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createFixedWindowPreAuthSourceBudget } from "../src/http/preAuthSourceBudget.js";
import { createMcpRequestHandler } from "../src/http/requestHandler.js";

const config = {
  baseUrl: "http://radioso.test",
  bindHost: "127.0.0.1",
  bindPort: 0,
  redisKeyPrefix: "radioso-mcp",
  requestTimeoutMs: 1_000,
  serverName: "radioso-test",
  trustedProxyHops: 0,
};

describe("standalone MCP pre-authentication controls", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
  });

  it("exhausting one digested source does not block another", () => {
    const budget = createFixedWindowPreAuthSourceBudget({ maxAttempts: 2, windowMs: 60_000 });

    expect(budget.consume({ sourceDigest: "source-a" })).toBe(true);
    expect(budget.consume({ sourceDigest: "source-a" })).toBe(true);
    expect(budget.consume({ sourceDigest: "source-a" })).toBe(false);
    expect(budget.consume({ sourceDigest: "source-b" })).toBe(true);
  });

  it("does not exchange a bearer after the source budget caps the request", async () => {
    const exchange = vi.fn();
    const server = createHttpServer({
      authService: createAuthService({
        converseApi: { ask: vi.fn(), exchange, validate: vi.fn(), recordUse: vi.fn() },
        sessionStore: createInMemorySessionStore(),
      }),
      config,
      preAuthSourceBudget: { consume: vi.fn().mockReturnValue(false) },
    });
    servers.push(server);
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(429);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("keeps hosted clients distinct using only the trusted forwarding suffix", async () => {
    const consume = vi.fn().mockReturnValue(false);
    const server = createHttpServer({
      authService: createAuthService({
        converseApi: { ask: vi.fn(), exchange: vi.fn(), validate: vi.fn(), recordUse: vi.fn() },
        sessionStore: createInMemorySessionStore(),
      }),
      config: { ...config, trustedProxyHops: 2 },
      preAuthSourceBudget: { consume },
    });
    servers.push(server);
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const call = (forwardedFor: string) => fetch(`http://127.0.0.1:${address.port}/mcp`, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      method: "POST",
    });

    await call("198.51.100.99, 203.0.113.7, 35.191.0.1");
    await call("192.0.2.44, 203.0.113.8, 35.191.0.1");

    const sourceDigests = consume.mock.calls.map(([input]) => (input as { sourceDigest: string }).sourceDigest);
    expect(new Set(sourceDigests).size).toBe(2);
    expect(sourceDigests.join(" ")).not.toContain("203.0.113.7");
  });

  it("rejects oversized bearer and client metadata before auth or server allocation", async () => {
    const verifyBearerToken = vi.fn();
    const serverManager = { evict: vi.fn(), getOrCreate: vi.fn() };
    const handler = createMcpRequestHandler({ config, serverManager, verifyBearerToken });

    const oversizedBearer = await handler(new Request("http://localhost/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      headers: { authorization: `Bearer ${"x".repeat(2049)}`, "content-type": "application/json" },
      method: "POST",
    }));
    const invalidClient = await handler(new Request("http://localhost/mcp", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "bad\nclient", version: "v" }, protocolVersion: "2025-11-25", capabilities: {} },
      }),
      headers: { authorization: "Bearer bounded", "content-type": "application/json" },
      method: "POST",
    }));
    const invalidBatchClient = await handler(new Request("http://localhost/mcp", {
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { clientInfo: { name: "x".repeat(129), version: "v" }, protocolVersion: "2025-11-25", capabilities: {} },
      }]),
      headers: { authorization: "Bearer bounded", "content-type": "application/json" },
      method: "POST",
    }));

    expect(oversizedBearer.response.status).toBe(401);
    expect(invalidClient.response.status).toBe(400);
    expect(invalidBatchClient.response.status).toBe(400);
    expect(verifyBearerToken).not.toHaveBeenCalled();
    expect(serverManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("does not record a cold-cache credential when its first MCP request is unsupported", async () => {
    const recordUse = vi.fn().mockResolvedValue(undefined);
    const exchange = vi.fn().mockResolvedValue({
      agent: { id: "agent-1", name: "Agent" },
      conversationId: "conversation-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionToken: "converse-session-token",
    });
    const server = createHttpServer({
      authService: createAuthService({
        converseApi: {
          ask: vi.fn(),
          exchange,
          validate: vi.fn().mockResolvedValue({
            valid: true,
            workspaceId: "workspace-1",
            agentId: "agent-1",
            conversationId: "conversation-1",
            permissions: [],
          }),
          recordUse,
        },
        sessionStore: createInMemorySessionStore(),
      }),
      config,
    });
    servers.push(server);
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unsupported/method", params: {} }),
      headers: { authorization: "Bearer cold-credential", "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(exchange).toHaveBeenCalledOnce();
    expect(recordUse).not.toHaveBeenCalled();
  });
});
