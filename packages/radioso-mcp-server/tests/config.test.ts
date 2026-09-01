import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads the remote runtime env vars and applies defaults", () => {
    const config = loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_MCP_AUDIT_LOG_PATH: "/tmp/radioso-mcp-audit.jsonl",
      RADIOSO_MCP_BIND_HOST: "0.0.0.0",
      RADIOSO_MCP_BIND_PORT: "8787",
      RADIOSO_MCP_REQUEST_TIMEOUT_MS: "15000",
      RADIOSO_MCP_SERVER_NAME: "radioso-test",
    });

    expect(config).toEqual({
      baseUrl: "http://localhost:8080",
      auditLogPath: "/tmp/radioso-mcp-audit.jsonl",
      bindHost: "0.0.0.0",
      bindPort: 8787,
      redisKeyPrefix: "radioso-mcp",
      redisUrl: undefined,
      requestTimeoutMs: 15000,
      serverName: "radioso-test",
      signingSecret: undefined,
      trustedProxyHops: 0,
    });
  });

  it("does not require a signing secret for one standalone process with in-memory sessions", () => {
    expect(() => loadConfig({ RADIOSO_BASE_URL: "http://localhost:8080" })).not.toThrow();
  });

  it("requires a signing secret when Redis persists encrypted backend sessions", () => {
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_MCP_REDIS_URL: "redis://localhost:6379",
    })).toThrow(/RADIOSO_MCP_SIGNING_SECRET/i);
  });

  it("requires enough signing entropy for source proofs and encrypted sessions", () => {
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_MCP_SIGNING_SECRET: "too-short",
    })).toThrow(/RADIOSO_MCP_SIGNING_SECRET/i);
  });

  it("normalizes the upstream base url and rejects invalid bind ports", () => {
    expect(() =>
      loadConfig({
        RADIOSO_BASE_URL: "http://localhost:8080///",
        RADIOSO_MCP_BIND_PORT: "70000",
      }),
    ).toThrow(/RADIOSO_MCP_BIND_PORT/i);

    const config = loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080///",
    });

    expect(config.baseUrl).toBe("http://localhost:8080");
  });

  it("keeps forwarded source resolution off unless trusted proxy hops are configured", () => {
    expect(loadConfig({ RADIOSO_BASE_URL: "http://localhost:8080" }).trustedProxyHops).toBe(0);
    expect(loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_TRUSTED_PROXY_HOPS: "2",
    }).trustedProxyHops).toBe(2);
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_TRUSTED_PROXY_HOPS: "11",
    })).toThrow(/RADIOSO_TRUSTED_PROXY_HOPS/i);
  });

});
