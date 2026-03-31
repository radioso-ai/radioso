import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("auth contract", () => {
  it("registers a user, returns workspace bootstrap data, and sets a session cookie", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "alice@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("logs in an existing user, returns workspace bootstrap data, and sets a session cookie", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeDefined();
    expect(response.body.workspaceId).toBe(registration.body.workspaceId);
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("honors a preferred workspace on login when it belongs to the account", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "preferred@example.com",
      password: "verysecurepassword",
    });

    const cookie = registration.headers["set-cookie"]?.[0];
    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Research" });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "preferred@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.token).toBeUndefined();
  });

  it("requires a session workspace selection for cookie auth and still accepts valid bearer tokens", async () => {
    const { app } = createTestApp();
    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "session-workspace@example.com",
      password: "verysecurepassword",
    });
    const cookie = registration.headers["set-cookie"]?.[0];
    const workspaceId = registration.body.workspaceId as string;
    const { token } = await issueTestToken(app, "session-workspace-token@example.com");

    const missingSelection = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", cookie);

    expect(missingSelection.status).toBe(400);
    expect(missingSelection.body.error.code).toBe("bad_request");

    const sessionSelection = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", cookie)
      .set("X-Workspace-Id", workspaceId);

    expect(sessionSelection.status).toBe(200);
    expect(sessionSelection.body.anonymousChatEnabled).toBe(false);

    const bearerRequest = await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", workspaceId);

    expect(bearerRequest.status).toBe(200);
    expect(bearerRequest.body.anonymousChatEnabled).toBe(false);
  });

  it("falls back to a valid bearer token when a stale session cookie is present", async () => {
    const { app } = createTestApp();
    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "stale-cookie@example.com",
      password: "verysecurepassword",
    });
    const workspaceId = registration.body.workspaceId as string;
    const { token } = await issueTestToken(app, "stale-cookie-token@example.com");

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", "radioso_session=stale-session-token")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", workspaceId);

    expect(response.status).toBe(200);
    expect(response.body.anonymousChatEnabled).toBe(false);
  });

  it("reveals a workspace token through an explicit session-authenticated account route", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "token-route-restored@example.com",
      password: "verysecurepassword",
    });
    const cookie = registration.headers["set-cookie"]?.[0];

    const response = await request(app)
      .get(`/api/v1/account/workspaces/${registration.body.workspaceId}/token`)
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.token).toMatch(/^sk_proj_[a-f0-9]+$/);
  });

  it("rate limits repeated workspace token reveal requests", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "token-route-rate-limit@example.com",
      password: "verysecurepassword",
    });
    const cookie = registration.headers["set-cookie"]?.[0];
    const tokenRoute = `/api/v1/account/workspaces/${registration.body.workspaceId}/token`;

    const first = await request(app)
      .get(tokenRoute)
      .set("Cookie", cookie);

    const second = await request(app)
      .get(tokenRoute)
      .set("Cookie", cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("rate limits repeated registration attempts", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    const first = await request(app).post("/api/v1/auth/register").send({
      email: "limit-register@example.com",
      password: "verysecurepassword",
    });
    const second = await request(app).post("/api/v1/auth/register").send({
      email: "limit-register@example.com",
      password: "verysecurepassword",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it("rate limits repeated login attempts", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    await request(app).post("/api/v1/auth/register").send({
      email: "limit-login@example.com",
      password: "verysecurepassword",
    });

    const first = await request(app).post("/api/v1/auth/login").send({
      email: "limit-login@example.com",
      password: "wrong-password",
    });
    const second = await request(app).post("/api/v1/auth/login").send({
      email: "limit-login@example.com",
      password: "wrong-password",
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(second.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it("rate limits repeated login attempts even when the email casing changes", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    await request(app).post("/api/v1/auth/register").send({
      email: "case-bypass@example.com",
      password: "verysecurepassword",
    });

    const first = await request(app).post("/api/v1/auth/login").send({
      email: "Case-Bypass@example.com",
      password: "wrong-password",
    });
    const second = await request(app).post("/api/v1/auth/login").send({
      email: "case-bypass@example.com",
      password: "wrong-password",
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });
});
