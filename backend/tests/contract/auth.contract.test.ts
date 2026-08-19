import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";
import type {
  OrganizationCreationGuard,
  OrganizationCreationReservation,
} from "../../src/shared/domain/organizationCreationGuard.js";

class BlockingOrganizationCreationGuard implements OrganizationCreationGuard {
  async reserve(input: { intent: "signup" } | { intent: "additional"; userId: string }): Promise<OrganizationCreationReservation> {
    if (input.intent === "signup") {
      return {
        async commit() {},
        async release() {},
      };
    }
    throw {
      statusCode: 429,
      code: "rate_limit_exceeded",
      message: "Organization creation limit reached. You can create up to 1 organization per month. Try again after 2026-07-01T00:00:00.000Z.",
      details: {
        limit: 1,
        used: 1,
        periodStart: "2026-06-01",
        resetAt: "2026-07-01T00:00:00.000Z",
      },
    };
  }

  async isSignupAvailable(): Promise<boolean> {
    return true;
  }
}

class ClosedRegistrationGuard implements OrganizationCreationGuard {
  async reserve(input: { intent: "signup" } | { intent: "additional"; userId: string }): Promise<OrganizationCreationReservation> {
    if (input.intent === "signup") {
      throw {
        statusCode: 403,
        code: "forbidden",
        message: "Registration is closed. Ask an organization owner for an invitation.",
      };
    }
    return { async commit() {}, async release() {} };
  }

  async isSignupAvailable(): Promise<boolean> {
    return false;
  }
}

describe("auth contract", () => {
  it("reports public registration availability without caching initialization state", async () => {
    const { app } = createTestApp({ organizationCreationGuard: new ClosedRegistrationGuard() });

    const response = await request(app).get("/api/v1/auth/registration");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("returns a stable invitation-required 403 for initialized OSS registration", async () => {
    const { app } = createTestApp({ organizationCreationGuard: new ClosedRegistrationGuard() });

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "closed@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "forbidden",
        message: "Registration is closed. Ask an organization owner for an invitation.",
      },
    });
  });

  it("registers a user, returns workspace bootstrap data, and requires email verification", async () => {
    const { app, repositories } = createTestApp();

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
    expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(repositories.auditEventRepository.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "auth.register",
        eventStatus: "success",
        metadata: expect.objectContaining({ verificationMode: "email_verification" }),
      }),
    ]));
  });

  it("auto-verifies new password registrations and creates a session in development", async () => {
    const { app, repositories } = createTestApp({
      envOverrides: {
        NODE_ENV: "development",
        AUTH_AUTO_VERIFY_EMAIL: true,
      },
    });

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "local-dev@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.requiresEmailVerification).toBe(false);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
    expect((await repositories.userRepository.findByEmail("local-dev@example.com"))?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(repositories.auditEventRepository.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "auth.register",
        eventStatus: "success",
        metadata: expect.objectContaining({ verificationMode: "development_auto_verify" }),
      }),
    ]));
    expect(repositories.auditEventRepository.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "auth.email_verification.resend" }),
    ]));
  });

  it("returns a documented 429 envelope when additional organization creation is capped", async () => {
    const { app } = createTestApp({
      organizationCreationGuard: new BlockingOrganizationCreationGuard(),
    });
    const registration = await issueTestSession(app, "org-cap-contract@example.com");

    const response = await request(app)
      .post("/api/v1/account/accounts")
      .set("Cookie", registration.cookie)
      .send({ organizationName: "Blocked Additional Org" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Organization creation limit reached. You can create up to 1 organization per month. Try again after 2026-07-01T00:00:00.000Z.",
        details: {
          limit: 1,
          used: 1,
          periodStart: "2026-06-01",
          resetAt: "2026-07-01T00:00:00.000Z",
        },
      },
    });
  });

  it("rejects login for users who have not verified their email", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "unverified@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "unverified@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
      message: "Email verification required",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
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

  it("accepts password reset requests without revealing whether the email exists", async () => {
    const { app } = createTestApp();
    await issueTestSession(app, "reset-known@example.com");

    const known = await request(app).post("/api/v1/auth/password-reset/request").send({
      email: "reset-known@example.com",
    });
    const unknown = await request(app).post("/api/v1/auth/password-reset/request").send({
      email: "reset-unknown@example.com",
    });

    expect(known.status).toBe(202);
    expect(known.body).toEqual({ accepted: true });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ accepted: true });
  });

  it("rejects invalid password reset confirmation tokens", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/password-reset/confirm").send({
      token: "not-valid",
      password: "newsecurepassword",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("accepts email verification resends without revealing whether the email exists", async () => {
    const { app } = createTestApp();
    await issueTestSession(app, "verify-known@example.com");

    const known = await request(app).post("/api/v1/auth/email-verification/resend").send({
      email: "verify-known@example.com",
    });
    const unknown = await request(app).post("/api/v1/auth/email-verification/resend").send({
      email: "verify-unknown@example.com",
    });

    expect(known.status).toBe(202);
    expect(known.body).toEqual({ accepted: true });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ accepted: true });
  });

  it("rejects invalid email verification tokens", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/email-verification/verify").send({
      token: "not-valid",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
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

  it("does not share the brute-force auth limit for repeated workspace token reveal requests", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    const registration = await issueTestSession(app, "token-route-rate-limit@example.com");
    const cookie = registration.cookie;
    const tokenRoute = `/api/v1/account/workspaces/${registration.workspaceId}/token`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app)
        .get(tokenRoute)
        .set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body.token).toMatch(/^radioso_[a-f0-9]+$/);
    }
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
