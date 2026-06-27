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

  it("lists only email-eligible OAuth connections, excluding other integrations", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
      },
    });
    const session = await issueTestSession(app, "customer-email-oauth-filter@example.com");
    const headers = adminSessionHeaders(session);

    const mail = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers)
      .send({
        provider: "google_mail",
        displayName: "Support Gmail",
        requestedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      });
    expect(mail.status).toBe(201);

    // A non-email connection on the shared OAuth spine must not leak into the
    // customer email surface.
    const slack = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers)
      .send({ provider: "slack", displayName: "Workspace Slack" });
    expect(slack.status).toBe(201);

    // The generic spine still returns everything for the workspace.
    const spine = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers);
    expect(spine.status).toBe(200);
    expect(spine.body.connections).toHaveLength(2);

    // The email surface owns its provider scope and excludes Slack.
    const emailScoped = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/email-oauth-connections`)
      .set(headers);
    expect(emailScoped.status).toBe(200);
    expect(emailScoped.body.connections).toHaveLength(1);
    expect(emailScoped.body.connections[0]).toMatchObject({ provider: "google_mail" });
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
