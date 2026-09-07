import { describe, expect, it } from "vitest";
import { OPERATOR_MCP_SCOPES } from "@radioso/operator-mcp-contract";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  hashOpaqueCredential,
  parseOperatorMcpScopes,
  validateAuthorizationResource,
  validateRedirectUri,
} from "../../../src/modules/operatorMcpAuthorization/domain.js";

describe("operator MCP authorization domain", () => {
  it("parses a non-empty tool-scope subset and independent offline access", () => {
    expect(parseOperatorMcpScopes("operator:read offline_access operator:propose")).toEqual({
      offlineAccess: true,
      toolScopes: ["operator:read", "operator:propose"],
    });
    expect(() => parseOperatorMcpScopes("offline_access")).toThrow(/tool scope/i);
    expect(() => parseOperatorMcpScopes("operator:read unknown")).toThrow(/invalid_scope/i);
  });

  it("accepts every tool scope declared by the shared contract", () => {
    expect(parseOperatorMcpScopes(OPERATOR_MCP_SCOPES.join(" ")).toolScopes).toEqual([...OPERATOR_MCP_SCOPES]);
  });

  it("requires the exact canonical resource", () => {
    const canonical = "https://mcp.example/operator/mcp";
    expect(validateAuthorizationResource(canonical, canonical)).toBe(canonical);
    expect(() => validateAuthorizationResource(`${canonical}/`, canonical)).toThrow(/resource/i);
    expect(() => validateAuthorizationResource("https://mcp.example/mcp", canonical)).toThrow(/resource/i);
  });

  it("accepts exact HTTPS redirects and literal loopback with variable ports", () => {
    expect(validateRedirectUri({
      applicationType: "web",
      requested: "https://client.example/oauth/callback",
      registered: ["https://client.example/oauth/callback"],
    })).toBe("https://client.example/oauth/callback");
    expect(validateRedirectUri({
      applicationType: "native",
      requested: "http://127.0.0.1:53192/callback",
      registered: ["http://127.0.0.1/callback"],
    })).toBe("http://127.0.0.1:53192/callback");
    expect(() => validateRedirectUri({
      applicationType: "native",
      requested: "http://localhost:53192/callback",
      registered: ["http://127.0.0.1/callback"],
    })).toThrow(/redirect/i);
  });

  it("uses bounded lifetimes and one-way digests", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBe(300);
    expect(hashOpaqueCredential("secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueCredential("secret")).not.toContain("secret");
  });

});
