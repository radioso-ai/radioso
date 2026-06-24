import { describe, expect, it } from "vitest";

import { shouldCaptureRequestBody } from "../../src/app/server/createApp.js";

// Guards the body-capture content-type gate. Slack interactivity callbacks arrive as
// `application/x-www-form-urlencoded`; if the gate is narrowed back to JSON-only, the
// interactivity endpoint loses its rawBody and 400s before signature verification.
describe("shouldCaptureRequestBody", () => {
  it("captures JSON and Slack form-urlencoded bodies (with or without charset)", () => {
    expect(shouldCaptureRequestBody("application/json")).toBe(true);
    expect(shouldCaptureRequestBody("application/json; charset=utf-8")).toBe(true);
    expect(shouldCaptureRequestBody("application/x-www-form-urlencoded")).toBe(true);
    expect(shouldCaptureRequestBody("application/x-www-form-urlencoded; charset=utf-8")).toBe(true);
  });

  it("skips content types Radioso does not parse", () => {
    expect(shouldCaptureRequestBody("text/plain")).toBe(false);
    expect(shouldCaptureRequestBody("multipart/form-data; boundary=x")).toBe(false);
    expect(shouldCaptureRequestBody("")).toBe(false);
    expect(shouldCaptureRequestBody(undefined)).toBe(false);
  });
});
