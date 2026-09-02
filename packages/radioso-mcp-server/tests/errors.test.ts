import { describe, expect, it } from "vitest";

import { AuthServiceError } from "../src/auth/authService.js";
import { toStructuredToolError } from "../src/errors.js";

describe("toStructuredToolError", () => {
  it("maps auth service failures to structured codes", () => {
    expect(
      toStructuredToolError(new AuthServiceError("MCP access token is invalid or expired.", "invalid_access_token")),
    ).toMatchObject({
      code: "invalid_access_token",
      message: "MCP access token is invalid or expired.",
    });
  });
});
