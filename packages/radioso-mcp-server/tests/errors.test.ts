import { describe, expect, it } from "vitest";

import { AuthServiceError } from "../src/auth/authService.js";
import { toStructuredToolError } from "../src/errors.js";
import { CapabilityPolicyError } from "../src/policy/capabilityPolicy.js";

describe("toStructuredToolError", () => {
  it("maps auth service failures to structured codes", () => {
    expect(
      toStructuredToolError(new AuthServiceError("MCP access token is invalid or expired.", "invalid_access_token")),
    ).toMatchObject({
      code: "invalid_access_token",
      message: "MCP access token is invalid or expired.",
    });
  });

  it("maps capability policy failures to structured codes", () => {
    expect(
      toStructuredToolError(new CapabilityPolicyError("Tool not granted.", "capability_forbidden", { toolName: "delete_document" })),
    ).toMatchObject({
      code: "capability_forbidden",
      details: { toolName: "delete_document" },
      message: "Tool not granted.",
    });
  });
});
