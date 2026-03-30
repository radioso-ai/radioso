import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryAbuseControlRepository } from "../support/fakes.js";
import { createTestApp } from "../support/testApp.js";

describe("abuse controls integration", () => {
  it("enforces auth throttling across separate app instances that share abuse-control persistence", async () => {
    const abuseControlRepository = new InMemoryAbuseControlRepository();
    const envOverrides = {
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
    };

    const firstApp = createTestApp({ abuseControlRepository, envOverrides }).app;
    const secondApp = createTestApp({ abuseControlRepository, envOverrides }).app;

    await request(firstApp).post("/api/v1/auth/register").send({
      email: "shared-limit@example.com",
      password: "verysecurepassword",
    });

    const firstFailure = await request(firstApp).post("/api/v1/auth/login").send({
      email: "shared-limit@example.com",
      password: "wrong-password",
    });
    const secondFailure = await request(secondApp).post("/api/v1/auth/login").send({
      email: "shared-limit@example.com",
      password: "wrong-password",
    });

    expect(firstFailure.status).toBe(401);
    expect(secondFailure.status).toBe(429);
    expect(secondFailure.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });
});
