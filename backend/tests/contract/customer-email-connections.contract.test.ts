import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const extractState = (authorizationUrl: string): string => {
  const parsed = new URL(authorizationUrl);
  const state = parsed.searchParams.get("state");
  if (!state) {
    throw new Error("authorizationUrl did not include state");
  }
  return state;
};

describe("customer email connections contract", () => {
  it("creates, lists, updates, health-checks, and deletes a workspace email connection", async () => {
    const { app } = createTestApp({
      envOverrides: { APP_BASE_URL: "https://app.test.example.com" },
    });
    const session = await issueTestSession(app, "customer-email-connections@example.com");
    const headers = adminSessionHeaders(session);

    const oauth = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers)
      .send({
        provider: "google_mail",
        displayName: "Support Gmail",
        requestedScopes: [
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      });
    expect(oauth.status).toBe(201);

    const oauthList = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers);
    expect(oauthList.status).toBe(200);
    expect(oauthList.body.connections).toEqual([
      expect.objectContaining({
        id: oauth.body.connectionId,
        provider: "google_mail",
        displayName: "Support Gmail",
      }),
    ]);

    const callback = await request(app)
      .get(`/api/v1/oauth/callback/google_mail`)
      .query({ code: "provider-code", state: extractState(oauth.body.authorizationUrl as string) });
    expect(callback.status).toBe(302);

    const created = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/email-connections`)
      .set(headers)
      .send({
        oauthConnectionId: oauth.body.connectionId,
        displayName: "Support outbound",
        senderEmail: "support@example.com",
        senderName: "Example Support",
        replyToEmail: "reply@example.com",
      });

    expect(created.status).toBe(201);
    expect(created.body.connection).toMatchObject({
      id: expect.any(String),
      oauthConnectionId: oauth.body.connectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      senderName: "Example Support",
      replyToEmail: "reply@example.com",
      status: "authorized",
      lastHealthStatus: null,
    });
    expect(JSON.stringify(created.body)).not.toContain("test-google-secret");
    const connectionId = created.body.connection.id as string;

    const listed = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/email-connections`)
      .set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.connections).toEqual([
      expect.objectContaining({ id: connectionId, displayName: "Support outbound" }),
    ]);

    const disabled = await request(app)
      .patch(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}`)
      .set(headers)
      .send({ disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.body.connection.status).toBe("disabled");

    const reenabled = await request(app)
      .patch(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}`)
      .set(headers)
      .send({ disabled: false, displayName: "Support outbound live" });
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.connection).toMatchObject({
      displayName: "Support outbound live",
      status: "authorized",
    });

    const health = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}/health-check`)
      .set(headers);
    expect(health.status).toBe(200);
    expect(health.body.connection).toMatchObject({
      id: connectionId,
      lastHealthStatus: "ok",
      lastErrorCode: null,
    });

    const removed = await request(app)
      .delete(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}`)
      .set(headers);
    expect(removed.status).toBe(204);
  });

  it("validates email connection input and requires authentication", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "customer-email-invalid@example.com");

    const invalid = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/email-connections`)
      .set(adminSessionHeaders(session))
      .send({
        oauthConnectionId: "not-a-uuid",
        displayName: "",
        senderEmail: "not-email",
      });
    expect(invalid.status).toBe(400);

    const unauthenticated = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/email-connections`);
    expect(unauthenticated.status).toBe(401);
  });
});
