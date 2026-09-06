import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, createTestEnv } from "../support/testApp.js";

/**
 * Radioso serves more than one production stack, and they drift. `/health` is the only place
 * an operator can read which release each one is actually running without a deploy log.
 */
describe("health build identity", () => {
  it("reports the release and commit the running image was built from", async () => {
    const { app } = createTestApp({
      envOverrides: { RADIOSO_RELEASE: "1.4.0", RADIOSO_COMMIT: "a1b2c3d4e5f6" },
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", version: "1.4.0", commit: "a1b2c3d4e5f6" });
  });

  it("names an unstamped build rather than claiming a release it does not carry", async () => {
    const { app } = createTestApp({
      envOverrides: { ...createTestEnv(), RADIOSO_RELEASE: "development", RADIOSO_COMMIT: "unknown" },
    });

    const response = await request(app).get("/health");

    expect(response.body.version).toBe("development");
    expect(response.body.commit).toBe("unknown");
  });
});
