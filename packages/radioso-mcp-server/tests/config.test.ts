import { describe, expect, it } from "vitest";

import { loadConfig, type RadiosoMcpConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps operatorMcp optional for programmatic legacy configurations", () => {
    const config: RadiosoMcpConfig = {
      baseUrl: "http://localhost:8080",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      redisKeyPrefix: "radioso-mcp",
      requestTimeoutMs: 30_000,
      serverName: "radioso-context",
      trustedProxyHops: 0,
    };

    expect(config.operatorMcp).toBeUndefined();
  });

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
      operatorMcp: { enabled: false },
      trustedProxyHops: 0,
    });
  });

  it("requires one complete externally-versioned operator configuration when enabled", () => {
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
    })).toThrow(/OPERATOR_MCP_CREDENTIAL_EPOCH/i);

    expect(loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "7",
      OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS: "00000000-0000-4000-8000-000000000001",
    }).operatorMcp).toEqual({
      credentialEpoch: "7",
      enabled: true,
      internalSecret: "a-long-enough-operator-proof-secret",
      issuerUrl: "https://app.example",
      resourceUrl: "https://mcp.example/operator/mcp",
      rolloutWorkspaceIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example/oauth",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
    })).toThrow(/OPERATOR_MCP_ISSUER_URL/i);
    expect(() => loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
      OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS: "not-a-uuid",
    })).toThrow(/OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS/i);
  });

  it("requires HTTPS issuer/resource in production but permits loopback HTTP in development", () => {
    const common = {
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
    };
    expect(() => loadConfig({
      ...common,
      NODE_ENV: "production",
      OPERATOR_MCP_ISSUER_URL: "http://127.0.0.1:8080",
      OPERATOR_MCP_RESOURCE_URL: "http://127.0.0.1:8787/operator/mcp",
      RADIOSO_BASE_URL: "http://localhost:8080",
    })).toThrow(/HTTPS/i);
    expect(loadConfig({
      ...common,
      NODE_ENV: "development",
      OPERATOR_MCP_ISSUER_URL: "http://127.0.0.1:8080",
      OPERATOR_MCP_RESOURCE_URL: "http://127.0.0.1:8787/operator/mcp",
      RADIOSO_BASE_URL: "http://localhost:8080",
    }).operatorMcp.enabled).toBe(true);
    expect(() => loadConfig({
      ...common,
      NODE_ENV: "development",
      OPERATOR_MCP_ISSUER_URL: "http://app.example",
      OPERATOR_MCP_RESOURCE_URL: "http://mcp.example/operator/mcp",
      RADIOSO_BASE_URL: "http://localhost:8080",
    })).toThrow(/loopback|HTTPS/i);
  });

  it("preserves operator secret bytes exactly", () => {
    const internalSecret = `  ${"x".repeat(32)}  `;
    expect(loadConfig({
      NODE_ENV: "development",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_INTERNAL_SECRET: internalSecret,
      OPERATOR_MCP_ISSUER_URL: "http://127.0.0.1:8080",
      OPERATOR_MCP_RESOURCE_URL: "http://127.0.0.1:8787/operator/mcp",
      RADIOSO_BASE_URL: "http://localhost:8080",
    }).operatorMcp).toMatchObject({ internalSecret });
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
