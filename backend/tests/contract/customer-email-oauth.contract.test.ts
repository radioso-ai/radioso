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

describe("workspace OAuth connections contract", () => {
  it("starts, reports, reauthorizes, and completes a workspace OAuth connection", async () => {
    const { app } = createTestApp({
      envOverrides: { APP_BASE_URL: "https://app.test.example.com" },
    });
    const session = await issueTestSession(app, "workspace-oauth@example.com");
    const headers = adminSessionHeaders(session);

    const created = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(headers)
      .send({
        provider: "test_mail",
        displayName: "Support Mailbox",
        requestedScopes: ["mail.send"],
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      connectionId: expect.any(String),
      authorizationUrl: expect.stringContaining("https://oauth.test.example.com/authorize"),
      status: "pending",
    });
    expect(created.body.authorizationUrl).toContain(
      encodeURIComponent("https://app.test.example.com/api/v1/oauth/callback/test_mail"),
    );
    const connectionId = created.body.connectionId as string;

    const pending = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections/${connectionId}`)
      .set(headers);
    expect(pending.status).toBe(200);
    expect(pending.body.connection).toMatchObject({
      id: connectionId,
      provider: "test_mail",
      displayName: "Support Mailbox",
      status: "pending",
      grantedScopes: ["mail.send"],
      providerAccountId: null,
    });
    expect(JSON.stringify(pending.body)).not.toContain("test-access-token");

    const reauthorized = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections/${connectionId}/reauthorize`)
      .set(headers);
    expect(reauthorized.status).toBe(200);
    expect(reauthorized.body).toMatchObject({
      connectionId,
      authorizationUrl: expect.stringContaining("https://oauth.test.example.com/authorize"),
      status: "pending",
    });

    const callback = await request(app)
      .get(`/api/v1/oauth/callback/test_mail`)
      .query({ code: "provider-code", state: extractState(reauthorized.body.authorizationUrl as string) });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("status=authorized");
    expect(callback.headers.location).toContain(`connectionId=${connectionId}`);

    const authorized = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections/${connectionId}`)
      .set(headers);
    expect(authorized.status).toBe(200);
    expect(authorized.body.connection).toMatchObject({
      id: connectionId,
      status: "authorized",
      grantedScopes: ["mail.send"],
    });
    expect(JSON.stringify(authorized.body)).not.toContain("test-access-token");
  });

  it("rejects unsupported providers and unauthenticated status reads", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "workspace-oauth-invalid@example.com");

    const unsupported = await request(app)
      .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
      .set(adminSessionHeaders(session))
      .send({
        provider: "missing_provider",
        displayName: "Missing",
        requestedScopes: ["mail.send"],
      });
    expect(unsupported.status).toBe(400);

    const unauthenticated = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/oauth-connections/00000000-0000-0000-0000-000000000001`);
    expect(unauthenticated.status).toBe(401);
  });
});
