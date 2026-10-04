import { describe, expect, it } from "vitest";

import { isOwnerRefusal, isStale } from "../../../src/modules/operatorCopilot/proposalVersioning.js";
import { AppError, badRequest, conflict, forbidden, notFound, serviceUnavailable, tooManyRequests, unauthorized, usageLimitExceeded } from "../../../src/shared/domain/errors.js";

describe("isOwnerRefusal", () => {
  it.each([
    ["a 400 bad_request", badRequest("invalid"), true],
    ["a 401 unauthorized", unauthorized(), true],
    ["a 403 forbidden", forbidden(), true],
    ["a 404 not_found", notFound("missing"), false],
    ["a 409 conflict", conflict("moved"), false],
    ["a 422 domain-specific AppError", new AppError(422, "revision_invalid", "invalid revision"), true],
    ["a 429 tooManyRequests", tooManyRequests("slow down"), false],
    ["a 429 usageLimitExceeded", usageLimitExceeded("over quota"), false],
    ["a 503 serviceUnavailable", serviceUnavailable("down"), false],
    ["a plain Error", new Error("boom"), false],
    ["a non-Error value", "boom", false],
    ["undefined", undefined, false],
  ] as const)("classifies %s as %s", (_description, error, expected) => {
    expect(isOwnerRefusal(error)).toBe(expected);
  });

  it("never overlaps with isStale for the same error", () => {
    for (const error of [badRequest("invalid"), notFound("missing"), conflict("moved"), tooManyRequests("slow down"), new Error("boom")]) {
      expect(isOwnerRefusal(error) && isStale(error)).toBe(false);
    }
  });
});
