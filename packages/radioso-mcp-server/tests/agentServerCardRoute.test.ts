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

const authService = {
  getRequestAuthInfo: vi.fn(),
  getSession: vi.fn(),
  resolveBearerSession: vi.fn(),
  recordSuccessfulUse: vi.fn(),
};

const withServer = async (
  agentServerCard: { read: (publicId: string) => Promise<{ status: number; body: unknown }> },
  run: (origin: string) => Promise<void>,
) => {
  const server = createHttpServer({ authService, config, agentServerCard });
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

describe("resolveMcpRoute", () => {
  it("routes the endpoint-relative server card and leaves every other path alone", () => {
    expect(resolveMcpRoute({ method: "GET", pathname: "/mcp/a/ag_Public12345/server-card" }))
      .toEqual({ kind: "agent_server_card", publicId: "ag_Public12345" });
    expect(resolveMcpRoute({ method: "GET", pathname: "/healthz" })).toEqual({ kind: "health" });
    expect(resolveMcpRoute({ method: "POST", pathname: "/mcp" })).toEqual({ kind: "agent_mcp" });
    expect(resolveMcpRoute({ method: "POST", pathname: "/operator/mcp" })).toEqual({ kind: "operator_mcp" });
    // The per-agent endpoint itself is not a route yet; walk-in access opens it.
    expect(resolveMcpRoute({ method: "POST", pathname: "/mcp/a/ag_Public12345" })).toEqual({ kind: "not_found" });
    expect(resolveMcpRoute({ method: "POST", pathname: "/mcp/a/ag_Public12345/server-card" })).toEqual({ kind: "not_found" });
    expect(resolveMcpRoute({ method: "GET", pathname: "/mcp/a/../secret/server-card" })).toEqual({ kind: "not_found" });
  });

  it("matches the operator metadata path only when the operator surface declares one", () => {
    const pathname = "/.well-known/oauth-protected-resource/operator/mcp";
    expect(resolveMcpRoute({ method: "GET", pathname, operatorResourceMetadataPath: pathname }))
      .toEqual({ kind: "operator_resource_metadata" });
    expect(resolveMcpRoute({ method: "GET", pathname, operatorResourceMetadataPath: null }))
      .toEqual({ kind: "not_found" });
  });
});

describe("agent server card route", () => {
  it("serves the backend's card at the path the endpoint reserves", async () => {
    const card = { name: "ai.radioso/ag_Public12345", description: "Support", version: "3" };
    await withServer({ read: async () => ({ status: 200, body: card }) }, async (origin) => {
      const response = await fetch(`${origin}/mcp/a/ag_Public12345/server-card`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await response.json()).toEqual(card);
    });
  });

  it("passes the backend's refusal through unchanged", async () => {
    const body = { error: { code: "not_found", message: "Route not found." } };
    await withServer({ read: async () => ({ status: 404, body }) }, async (origin) => {
      const response = await fetch(`${origin}/mcp/a/ag_Unknown00000/server-card`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("cache-control")).toBeNull();
    });
  });
});
