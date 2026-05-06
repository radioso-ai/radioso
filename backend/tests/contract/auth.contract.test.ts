import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

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
    expect(response.body.accountId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.organizationName).toBe("Alice Organization");
    expect(response.body.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.body.token).toBeUndefined();
    expect(response.body.requiresEmailVerification).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("logs in an existing user, returns workspace bootstrap data, and sets a session cookie", async () => {
    const { app } = createTestApp();

    const registration = await issueTestSession(app, "bob@example.com");

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeDefined();
    expect(response.body.accountId).toBe(registration.accountId);
    expect(response.body.organizationName).toBe("Bob Organization");
    expect(response.body.workspaceId).toBe(registration.workspaceId);
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("accepts JSON auth requests when the content type includes charset UTF-8", async () => {
    const { app } = createTestApp();

    await issueTestSession(app, "charset-login@example.com");

    const response = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json; charset=UTF-8")
      .send(JSON.stringify({
        email: "charset-login@example.com",
        password: "verysecurepassword",
      }));

    expect(response.status).toBe(200);
    expect(response.body.workspaceId).toBeDefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("honors a preferred workspace on login when it belongs to the account", async () => {
    const { app } = createTestApp();

    const registration = await issueTestSession(app, "preferred@example.com");
    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", registration.cookie)
      .send({ name: "Research" });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "preferred@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.organizationName).toBe("Preferred Organization");
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.body.token).toBeUndefined();
  });

  it("requires a session workspace selection for cookie auth and still accepts valid bearer tokens", async () => {
    const { app } = createTestApp();
    const registration = await issueTestSession(app, "session-workspace@example.com");
    const cookie = registration.cookie;
    const workspaceId = registration.workspaceId;
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
    const registration = await issueTestSession(app, "stale-cookie@example.com");
    const workspaceId = registration.workspaceId;
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

    const registration = await issueTestSession(app, "token-route-restored@example.com");
    const cookie = registration.cookie;

    const response = await request(app)
      .get(`/api/v1/account/workspaces/${registration.workspaceId}/token`)
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.token).toMatch(/^radioso_[a-f0-9]+$/);
  });

  it("rotates a workspace token through an explicit session-authenticated account route", async () => {
    const { app } = createTestApp();

    const registration = await issueTestSession(app, "rotate-token-route@example.com");
    const cookie = registration.cookie;

    const revealed = await request(app)
      .get(`/api/v1/account/workspaces/${registration.workspaceId}/token`)
      .set("Cookie", cookie);

    const rotated = await request(app)
      .post(`/api/v1/account/workspaces/${registration.workspaceId}/token/rotate`)
      .set("Cookie", cookie);

    expect(revealed.status).toBe(200);
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).toMatch(/^radioso_[a-f0-9]+$/);
    expect(rotated.body.token).not.toBe(revealed.body.token);
  });

  it("creates and accepts account invitations", async () => {
    const { app } = createTestApp();

    const owner = await issueTestSession(app, "owner-invite@example.com");
    const ownerCookie = owner.cookie;

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "invitee@example.com" });

    expect(invitation.status).toBe(201);
    expect(invitation.body.acceptanceUrl).toMatch(/^\/invite\/[a-f0-9]+$/);

    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);
    const invitationLookup = await request(app)
      .get(`/api/v1/auth/invitations/${invitationToken}`);

    expect(invitationLookup.status).toBe(200);
    expect(invitationLookup.body.email).toBe("invitee@example.com");
    expect(invitationLookup.body.status).toBe("pending");

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "invitee@example.com",
        password: "verysecurepassword",
      });

    expect(accepted.status).toBe(200);
    expect(accepted.body.accountId).toBe(owner.accountId);
    expect(accepted.body.organizationName).toBe("Owner Invite Organization");
    expect(accepted.body.userId).not.toBe(owner.userId);
  });

  it("rate limits repeated workspace token reveal requests", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    const registration = await issueTestSession(app, "token-route-rate-limit@example.com");
    const cookie = registration.cookie;
    const tokenRoute = `/api/v1/account/workspaces/${registration.workspaceId}/token`;

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
