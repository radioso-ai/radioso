import { describe, expect, it } from "vitest";

import { getEnv } from "../../../src/app/config/env.js";

const base = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso_test",
  SESSION_COOKIE_SECRET: "session-secret-long-enough",
};

describe("operator MCP backend configuration", () => {
  it("is disabled and fail-closed by default", () => {
    const env = getEnv(base);
    expect(env.OPERATOR_MCP_ENABLED).toBe(false);
    expect(env.OPERATOR_MCP_RESOURCE_URL).toBeUndefined();
    expect(env.OPERATOR_MCP_INTERNAL_SECRET).toBeUndefined();
    expect(env.OPERATOR_MCP_CREDENTIAL_EPOCH).toBeUndefined();
    expect(env.OPERATOR_MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.OPERATOR_MCP_VERIFICATION_BUDGET_PER_MINUTE).toBe(6);
  });

  it("requires canonical origins and a dedicated secret when enabled", () => {
    expect(() => getEnv({ ...base, OPERATOR_MCP_ENABLED: "true" })).toThrow(/OPERATOR_MCP_RESOURCE_URL/);
    expect(() => getEnv({
      ...base,
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "short",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
    })).toThrow(/OPERATOR_MCP_INTERNAL_SECRET/);
    expect(() => getEnv({
      ...base,
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
    })).toThrow(/OPERATOR_MCP_CREDENTIAL_EPOCH/);
  });

  it("rejects an access lifetime above the fixed maximum", () => {
    expect(() => getEnv({ ...base, OPERATOR_MCP_ACCESS_TOKEN_TTL_SECONDS: "901" })).toThrow();
    expect(() => getEnv({ ...base, OPERATOR_MCP_CREDENTIAL_EPOCH: "01" })).toThrow();
  });

  it("requires the issuer to be an origin when enabled", () => {
    expect(() => getEnv({
      ...base,
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "https://app.example/oauth",
      OPERATOR_MCP_INTERNAL_SECRET: "a-long-enough-operator-proof-secret",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
    })).toThrow(/OPERATOR_MCP_ISSUER_URL/);
  });

  it("requires HTTPS outside loopback development and preserves secret bytes", () => {
    const operator = {
      OPERATOR_MCP_ENABLED: "true",
      OPERATOR_MCP_RESOURCE_URL: "http://mcp.example/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "http://app.example",
      OPERATOR_MCP_INTERNAL_SECRET: "  exact-operator-proof-secret-value  ",
      OPERATOR_MCP_CREDENTIAL_EPOCH: "1",
    };
    expect(() => getEnv({ ...base, ...operator, NODE_ENV: "production" })).toThrow(/https/i);
    expect(() => getEnv({ ...base, ...operator })).toThrow(/loopback/i);
    const env = getEnv({
      ...base,
      ...operator,
      OPERATOR_MCP_RESOURCE_URL: "http://127.0.0.1:8787/operator/mcp",
      OPERATOR_MCP_ISSUER_URL: "http://localhost:8080",
    });
    expect(env.OPERATOR_MCP_INTERNAL_SECRET).toBe("  exact-operator-proof-secret-value  ");
    expect(env.OPERATOR_MCP_CREDENTIAL_EPOCH).toBe("1");
  });
});
