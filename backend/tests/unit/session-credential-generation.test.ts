import type { Response } from "express";
import { describe, expect, it } from "vitest";

import { sessionCredentialGeneration } from "../../src/app/http/middleware/requireSession.js";

const responseWith = (locals: Record<string, unknown>): Response => ({ locals }) as unknown as Response;

const captureFailure = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

describe("sessionCredentialGeneration", () => {
  it("answers the generation requireSession read with the live session", () => {
    expect(sessionCredentialGeneration(responseWith({ credentialGeneration: 0 }))).toBe(0);
    expect(sessionCredentialGeneration(responseWith({ credentialGeneration: 3 }))).toBe(3);
  });

  it.each([
    ["missing", {}],
    ["not a number", { credentialGeneration: "2" }],
    ["not an integer", { credentialGeneration: 1.5 }],
  ])("fails as an internal fault, not a sign-in refusal, when the generation is %s", (_case, locals) => {
    const failure = captureFailure(() => sessionCredentialGeneration(responseWith(locals)));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: "Session credential generation is missing: mount requireSession before this route",
    });
    // A plain error reaches the error handler as a 500, never as the 401 a superseded credential gets.
    expect(failure).not.toHaveProperty("statusCode");
  });
});
