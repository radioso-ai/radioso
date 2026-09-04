import { describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";

describe("operator route isolation", () => {
  it("returns 404 when disabled and does not require or alter the agent route", async () => {
    const server = createHttpServer({
      authService: { getRequestAuthInfo: vi.fn(), getSession: vi.fn(), resolveBearerSession: vi.fn(), recordSuccessfulUse: vi.fn() },
      config: { baseUrl: "http://app.example", bindHost: "127.0.0.1", bindPort: 0, redisKeyPrefix: "test", requestTimeoutMs: 1000, serverName: "test", trustedProxyHops: 0 },
    });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    await expect(fetch(`http://127.0.0.1:${address.port}/operator/mcp`)).resolves.toMatchObject({ status: 404 });
    await server.close();
  });

  it("mounts operator metadata and protected requests as an independent sibling", async () => {
    const readiness = { isReady: vi.fn(() => true) };
    const server = createHttpServer({
      auditLogger: { emit: vi.fn(async () => undefined) },
      authService: { getRequestAuthInfo: vi.fn(), getSession: vi.fn(), resolveBearerSession: vi.fn(), recordSuccessfulUse: vi.fn() },
      config: { baseUrl: "http://app.example", bindHost: "127.0.0.1", bindPort: 0, redisKeyPrefix: "test", requestTimeoutMs: 1000, serverName: "test", trustedProxyHops: 0 },
      operatorMcp: {
        adapter: { admit: vi.fn(), catalog: vi.fn(), invoke: vi.fn() } as never,
        readiness,
        resource: {
          authorizationServerUrl: "https://app.example",
          metadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp",
          resource: "https://mcp.example/operator/mcp",
        },
      },
    });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const metadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/operator/mcp`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({ resource: "https://mcp.example/operator/mcp", scopes_supported: ["operator:read", "operator:probe", "operator:act", "operator:propose"] });
    const protectedRequest = await fetch(`http://127.0.0.1:${address.port}/operator/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(protectedRequest.status).toBe(401);
    await server.close();
  });

  it("fails operator requests closed when its readiness is degraded", async () => {
    const server = createHttpServer({
      authService: { getRequestAuthInfo: vi.fn(), getSession: vi.fn(), resolveBearerSession: vi.fn(), recordSuccessfulUse: vi.fn() },
      config: { baseUrl: "http://app.example", bindHost: "127.0.0.1", bindPort: 0, redisKeyPrefix: "test", requestTimeoutMs: 1000, serverName: "test", trustedProxyHops: 0 },
      operatorMcp: {
        adapter: { admit: vi.fn(), catalog: vi.fn(), invoke: vi.fn() } as never,
        readiness: { isReady: () => false },
        resource: { authorizationServerUrl: "https://app.example", metadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp", resource: "https://mcp.example/operator/mcp" },
      },
    });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/operator/mcp`, { method: "POST", body: "{}", headers: { authorization: "Bearer opaque", "content-type": "application/json" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32002 } });
    await server.close();
  });

  it("uses a separate operator rate limiter and emits fixed-field outcomes", async () => {
    const emit = vi.fn(async () => undefined);
    const server = createHttpServer({
      authService: { getRequestAuthInfo: vi.fn(), getSession: vi.fn(), resolveBearerSession: vi.fn(), recordSuccessfulUse: vi.fn() },
      config: { baseUrl: "http://app.example", bindHost: "127.0.0.1", bindPort: 0, redisKeyPrefix: "test", requestTimeoutMs: 1000, serverName: "test", trustedProxyHops: 0 },
      operatorMcp: {
        adapter: { admit: vi.fn(async () => ({ proof: {} })), catalog: vi.fn(), invoke: vi.fn() } as never,
        auditLogger: { emit },
        rateLimit: { consume: () => true },
        resource: { authorizationServerUrl: "https://app.example", metadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp", resource: "https://mcp.example/operator/mcp" },
      },
    });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/operator/mcp`, {
      method: "POST",
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "ping",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      }),
      headers: {
        authorization: "Bearer opaque",
        "content-type": "application/json",
        "mcp-method": "ping",
        "mcp-protocol-version": "2026-07-28",
      },
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(emit).toHaveBeenCalledWith({ eventType: "operator_mcp_method", metadata: { method: "ping", surface: "operator_mcp" }, outcome: "success" });
    await server.close();
  });
});
