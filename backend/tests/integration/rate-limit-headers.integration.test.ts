import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryAbuseControlRepository } from "../support/fakes.js";
import { createTestApp } from "../support/testApp.js";

describe("rate limit headers integration", () => {
  it("advertises the remaining budget on an admitted request and the wait on a throttled one", async () => {
    const abuseControlRepository = new InMemoryAbuseControlRepository();
    const { app } = createTestApp({
      abuseControlRepository,
      envOverrides: { AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1 },
    });

    await request(app).post("/api/v1/auth/register").send({
      email: "header-limit@example.com",
      password: "verysecurepassword",
    });

    const admitted = await request(app).post("/api/v1/auth/login").send({
      email: "header-limit@example.com",
      password: "wrong-password",
    });
    const throttled = await request(app).post("/api/v1/auth/login").send({
      email: "header-limit@example.com",
      password: "wrong-password",
    });

    expect(admitted.status).toBe(401);
    expect(admitted.headers["ratelimit-limit"]).toBe("1");
    expect(admitted.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(admitted.headers["ratelimit-reset"])).toBeGreaterThan(0);
    expect(admitted.headers["retry-after"]).toBeUndefined();

    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.headers["ratelimit-limit"]).toBe("1");
    expect(throttled.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(throttled.headers["ratelimit-reset"])).toBeGreaterThan(0);
    expect(throttled.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({ retryAfterSeconds: expect.any(Number) }),
    });
  });

});
