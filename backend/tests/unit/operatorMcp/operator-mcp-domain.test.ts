import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  canonicalInputDigest,
  hashOpaqueCredential,
  parseOperatorMcpScopes,
  scopeForToolShape,
  validateAuthorizationResource,
  validatePkceS256,
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

  it("maps every descriptor shape to one fixed scope", () => {
    expect(scopeForToolShape("read")).toBe("operator:read");
    expect(scopeForToolShape("probe")).toBe("operator:probe");
    expect(scopeForToolShape("act")).toBe("operator:act");
    expect(scopeForToolShape("propose")).toBe("operator:propose");
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

  it("validates S256 without storing the verifier", () => {
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(validatePkceS256(verifier, challenge)).toBe(true);
    expect(validatePkceS256(`${verifier}x`, challenge)).toBe(false);
  });

  it("uses bounded lifetimes and one-way digests", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBe(300);
    expect(hashOpaqueCredential("secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueCredential("secret")).not.toContain("secret");
  });

  it("uses a versioned keyed digest over canonical input", () => {
    const left = canonicalInputDigest({ b: 2, a: { y: 1, x: true } }, "k".repeat(32));
    const right = canonicalInputDigest({ a: { x: true, y: 1 }, b: 2 }, "k".repeat(32));
    expect(left).toBe(right);
    expect(left).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(canonicalInputDigest({ a: 2 }, "k".repeat(32))).not.toBe(left);
  });
});
