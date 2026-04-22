import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

describe("password reset integration", () => {
  it("returns the same accepted response for known and unknown emails", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "known-reset@example.com",
      password: "verysecurepassword",
    });

    const known = await request(app).post("/api/v1/auth/password-reset/request").send({
      email: "known-reset@example.com",
    });
    const unknown = await request(app).post("/api/v1/auth/password-reset/request").send({
      email: "unknown-reset@example.com",
    });

    expect(known.status).toBe(202);
    expect(known.body).toEqual({ accepted: true });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ accepted: true });
  });

  it("rate limits repeated password reset requests", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    const payload = { email: "repeat-reset@example.com" };
    const first = await request(app).post("/api/v1/auth/password-reset/request").send(payload);
    const second = await request(app).post("/api/v1/auth/password-reset/request").send(payload);

    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
  });

  it("resets the password and revokes previous sessions", async () => {
    const { app, dependencies } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "http://localhost:3000",
      },
    });

    const register = await issueTestSession(app, "recover@example.com");
    const oldCookie = register.cookie;

    const requestReset = await request(app).post("/api/v1/auth/password-reset/request").send({
      email: "recover@example.com",
    });

    expect(requestReset.status).toBe(202);

    const latestUrl = dependencies.emailService.sentMessages.at(-1)?.metadata?.resetUrl;
    const token = latestUrl ? new URL(latestUrl).searchParams.get("token") : null;

    const confirm = await request(app).post("/api/v1/auth/password-reset/confirm").send({
      token,
      password: "newsecurepassword",
    });

    expect(confirm.status).toBe(200);
    expect(confirm.headers["set-cookie"]?.[0]).toContain("radioso_session=");

    const oldSessionResponse = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", oldCookie);
    expect(oldSessionResponse.status).toBe(401);

    const login = await request(app).post("/api/v1/auth/login").send({
      email: "recover@example.com",
      password: "newsecurepassword",
    });
    expect(login.status).toBe(200);
  });
});
