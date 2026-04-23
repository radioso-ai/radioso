import { describe, expect, it } from "vitest";

import { loadConfig, loadStdioConfig, STDIO_COMPAT_SIGNING_SECRET } from "../src/config.js";
import {
  DEFAULT_ALLOWED_READ_TOOLS,
  DEFAULT_ALLOWED_WRITE_TOOLS,
  DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS,
} from "../src/policy/capabilityPolicy.js";

describe("loadConfig", () => {
  it("reads the remote runtime env vars and applies defaults", () => {
    const config = loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS: "900",
      RADIOSO_MCP_ALLOWED_READ_TOOLS: "describe_capabilities,search_documents",
      RADIOSO_MCP_ALLOWED_WRITE_TOOLS: "create_document,update_document",
      RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: "create_document,update_document",
      RADIOSO_MCP_APPROVAL_TTL_SECONDS: "300",
      RADIOSO_MCP_AUDIT_LOG_PATH: "/tmp/radioso-mcp-audit.jsonl",
      RADIOSO_MCP_BIND_HOST: "0.0.0.0",
      RADIOSO_MCP_BIND_PORT: "8787",
      RADIOSO_MCP_REQUEST_TIMEOUT_MS: "15000",
      RADIOSO_MCP_SERVER_NAME: "radioso-test",
      RADIOSO_MCP_SIGNING_SECRET: "dev-signing-secret",
    });

    expect(config).toEqual({
      baseUrl: "http://localhost:8080",
      accessTokenTtlSeconds: 900,
      allowedReadTools: ["describe_capabilities", "search_documents"],
      allowedWriteTools: ["create_document", "update_document"],
      approvalRequiredWriteTools: ["create_document", "update_document"],
      approvalTtlSeconds: 300,
      auditLogPath: "/tmp/radioso-mcp-audit.jsonl",
      bindHost: "0.0.0.0",
      bindPort: 8787,
      redisKeyPrefix: "radioso-mcp",
      redisUrl: undefined,
      requestTimeoutMs: 15000,
      serverName: "radioso-test",
      signingSecret: "dev-signing-secret",
      workspacePoliciesPath: undefined,
    });
  });

  it("requires the MCP signing secret in remote mode", () => {
    expect(() => loadConfig({ RADIOSO_BASE_URL: "http://localhost:8080" })).toThrow(/RADIOSO_MCP_SIGNING_SECRET/i);
  });

  it("rejects the stdio compatibility signing secret in remote mode", () => {
    expect(() =>
      loadConfig({
        RADIOSO_BASE_URL: "http://localhost:8080",
        RADIOSO_MCP_SIGNING_SECRET: STDIO_COMPAT_SIGNING_SECRET,
      }),
    ).toThrow(/non-default secret/i);
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

  it("treats blank optional env vars as unset in stdio mode", () => {
    const config = loadStdioConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_MCP_ALLOWED_READ_TOOLS: "   ",
      RADIOSO_MCP_ALLOWED_WRITE_TOOLS: "",
      RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS: " ",
      RADIOSO_MCP_AUDIT_LOG_PATH: "",
      RADIOSO_MCP_SIGNING_SECRET: "  ",
      RADIOSO_API_TOKEN: "sk_proj_test",
    });

    expect(config.allowedReadTools).toEqual(DEFAULT_ALLOWED_READ_TOOLS);
    expect(config.allowedWriteTools).toEqual(DEFAULT_ALLOWED_WRITE_TOOLS);
    expect(config.approvalRequiredWriteTools).toEqual(DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS);
    expect(config.auditLogPath).toBeUndefined();
    expect(config.signingSecret).toBe(STDIO_COMPAT_SIGNING_SECRET);
  });
});
