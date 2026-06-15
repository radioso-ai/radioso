import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

describe("customer email OAuth routes", () => {
  it("starts authorization for a configured Gmail provider and returns non-secret status", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
      },
    });
    const session = await issueTestSession(app, "customer-email-oauth@example.com");
    const headers = adminSessionHeaders(session);

    const started = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers)
      .send({
        provider: "google_mail",
        displayName: "Support Gmail",
        requestedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      });

    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      connectionId: expect.any(String),
      authorizationUrl: expect.stringContaining("https://accounts.google.com/o/oauth2/v2/auth"),
      status: "pending",
    });
    expect(started.body.authorizationUrl).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send");
    expect(started.body.authorizationUrl).toContain(
      encodeURIComponent("https://app.test.example.com/api/v1/oauth/callback/google_mail"),
    );

    const status = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections/${started.body.connectionId}`)
      .set(headers);

    expect(status.status).toBe(200);
    expect(status.body.connection).toMatchObject({
      provider: "google_mail",
      displayName: "Support Gmail",
      status: "pending",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      providerAccountId: null,
    });
    expect(JSON.stringify(status.body)).not.toContain("test-google-secret");
  });

  it("rejects mail scopes outside the provider allowlist", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
      },
    });
    const session = await issueTestSession(app, "customer-email-oauth-scopes@example.com");

    const response = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(adminSessionHeaders(session))
      .send({
        provider: "google_mail",
        displayName: "Support Gmail",
        requestedScopes: ["https://mail.google.com/"],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Unsupported OAuth scopes");
  });
});
