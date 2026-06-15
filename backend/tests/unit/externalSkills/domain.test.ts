import { describe, expect, it } from "vitest";

import {
  mcpConnectionInputSchema,
  skillDefinitionInputSchema,
  validateParamCoverage,
} from "../../../src/modules/externalSkills/domain.js";

describe("mcpConnectionInputSchema", () => {
  const base = {
    displayName: "Support Slack",
    serverUrl: "https://mcp.example.com",
    authMethod: "access_token" as const,
    accessToken: "tok_123",
  };

  it("accepts a valid access-token connection", () => {
    const parsed = mcpConnectionInputSchema.parse(base);
    expect(parsed.serverUrl).toBe("https://mcp.example.com");
    expect(parsed.authMethod).toBe("access_token");
  });

  it("rejects a non-https server URL", () => {
    expect(() => mcpConnectionInputSchema.parse({ ...base, serverUrl: "http://mcp.example.com" })).toThrow();
  });

  it("rejects an invalid URL", () => {
    expect(() => mcpConnectionInputSchema.parse({ ...base, serverUrl: "not-a-url" })).toThrow();
  });

  it("rejects a server URL with embedded credentials (userinfo)", () => {
    expect(() =>
      mcpConnectionInputSchema.parse({ ...base, serverUrl: "https://user:secret@mcp.example.com" }),
    ).toThrow();
  });

  it("requires an access token when authMethod is access_token", () => {
    expect(() => mcpConnectionInputSchema.parse({ ...base, accessToken: undefined })).toThrow();
  });

  it("requires oauth config (not an access token) for oauth connections", () => {
    const parsed = mcpConnectionInputSchema.parse({
      displayName: "Cal",
      serverUrl: "https://mcp.cal.com",
      authMethod: "oauth",
      oauth: {
        authorizationEndpoint: "https://auth.cal.com/authorize",
        tokenEndpoint: "https://auth.cal.com/token",
        clientId: "cal-client",
      },
    });
    expect(parsed.authMethod).toBe("oauth");
    expect(parsed.accessToken).toBeUndefined();
  });

  it("rejects an unknown auth method", () => {
    expect(() => mcpConnectionInputSchema.parse({ ...base, authMethod: "basic" })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => mcpConnectionInputSchema.parse({ ...base, extra: true })).toThrow();
  });
});

describe("skillDefinitionInputSchema", () => {
  const base = {
    skillName: "handoff_slack",
    connectionId: "11111111-1111-1111-1111-111111111111",
    toolName: "post_message",
    boundParams: { channel: "#support" },
    exposedParams: { message: {} },
  };

  it("accepts a valid skill definition and defaults enabled=true", () => {
    const parsed = skillDefinitionInputSchema.parse(base);
    expect(parsed.skillName).toBe("handoff_slack");
    expect(parsed.enabled).toBe(true);
  });

  it("rejects a skill name that is not a lower-case identifier", () => {
    expect(() => skillDefinitionInputSchema.parse({ ...base, skillName: "Handoff Slack" })).toThrow();
    expect(() => skillDefinitionInputSchema.parse({ ...base, skillName: "1bad" })).toThrow();
  });

  it("rejects a non-uuid connection reference", () => {
    expect(() => skillDefinitionInputSchema.parse({ ...base, connectionId: "abc" })).toThrow();
  });

  it("rejects bound and exposed params that overlap", () => {
    expect(() =>
      skillDefinitionInputSchema.parse({
        ...base,
        boundParams: { channel: "#support", message: "hi" },
        exposedParams: { message: {} },
      }),
    ).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => skillDefinitionInputSchema.parse({ ...base, surprise: 1 })).toThrow();
  });

  it("rejects bound params with prototype-polluting keys", () => {
    expect(() => skillDefinitionInputSchema.parse({ ...base, boundParams: { constructor: "x" } })).toThrow();
  });
});

describe("validateParamCoverage", () => {
  const toolInputSchema = {
    type: "object",
    properties: { channel: { type: "string" }, message: { type: "string" }, thread: { type: "string" } },
    required: ["channel", "message"],
  };

  it("passes when all required inputs are bound or exposed", () => {
    const result = validateParamCoverage(toolInputSchema, ["channel"], ["message"]);
    expect(result.ok).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("reports required inputs that are neither bound nor exposed", () => {
    const result = validateParamCoverage(toolInputSchema, ["channel"], []);
    expect(result.ok).toBe(false);
    expect(result.missingRequired).toContain("message");
  });

  it("reports bound/exposed keys that do not exist on the tool", () => {
    const result = validateParamCoverage(toolInputSchema, ["channel"], ["message", "ghost"]);
    expect(result.ok).toBe(false);
    expect(result.unknownParams).toContain("ghost");
  });
});
