import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryAbuseControlRepository } from "../support/fakes.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

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

  it("enforces a shared durable limit across expensive authenticated assistant and retrieval routes", async () => {
    const abuseControlRepository = new InMemoryAbuseControlRepository();
    const { app } = createTestApp({
      abuseControlRepository,
      envOverrides: {
        EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });
    const session = await issueTestSession(app, "expensive-route-limit@example.com");

    const first = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(session))
      .send({ query: "rate limit" });
    const second = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "What is covered?", stream: false });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it("scopes expensive authenticated route limits separately for workspace API tokens", async () => {
    const abuseControlRepository = new InMemoryAbuseControlRepository();
    const { app } = createTestApp({
      abuseControlRepository,
      envOverrides: {
        EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });
    const tokenSession = await issueTestToken(app, "expensive-token-limit@example.com");

    const sessionRequest = await request(app)
      .post("/api/v1/retrieval/search")
      .set(adminSessionHeaders(tokenSession))
      .send({ query: "rate limit" });
    const tokenRequest = await request(app)
      .post("/api/v1/retrieval/answer")
      .set("Authorization", `Bearer ${tokenSession.token}`)
      .send({ query: "rate limit" });
    const blockedTokenRequest = await request(app)
      .post("/api/v1/retrieval/answer")
      .set("Authorization", `Bearer ${tokenSession.token}`)
      .send({ query: "rate limit" });

    expect(sessionRequest.status).toBe(200);
    expect(tokenRequest.status).toBe(200);
    expect(blockedTokenRequest.status).toBe(429);
  });
});
