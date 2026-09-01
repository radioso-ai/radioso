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
      RADIOSO_MCP_SIGNING_SECRET: "dev-signing-secret",
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
      signingSecret: "dev-signing-secret",
    });
  });

  it("requires the MCP signing secret in remote mode", () => {
    expect(() => loadConfig({ RADIOSO_BASE_URL: "http://localhost:8080" })).toThrow(/RADIOSO_MCP_SIGNING_SECRET/i);
  });

  it("normalizes the upstream base url and rejects invalid bind ports", () => {
    expect(() =>
      loadConfig({
        RADIOSO_BASE_URL: "http://localhost:8080///",
        RADIOSO_MCP_BIND_PORT: "70000",
        RADIOSO_MCP_SIGNING_SECRET: "dev-signing-secret",
      }),
    ).toThrow(/RADIOSO_MCP_BIND_PORT/i);

    const config = loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080///",
      RADIOSO_MCP_SIGNING_SECRET: "dev-signing-secret",
    });

    expect(config.baseUrl).toBe("http://localhost:8080");
  });

});
