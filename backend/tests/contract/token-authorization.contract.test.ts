import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const extractPublicChatToken = (anonymousChatUrl: string): string => {
  const token = anonymousChatUrl.split("/").at(-1);
  if (!token) {
    throw new Error(`Could not extract public chat token from ${anonymousChatUrl}`);
  }
  return token;
};

describe("token authorization contract", () => {
  it("rejects public chat launch credentials on the workspace API bearer path", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-launch-bearer@example.com");
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true });
    expect(settings.status).toBe(200);
    const publicLaunchCredential = extractPublicChatToken(settings.body.anonymousChatUrl);

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${publicLaunchCredential}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("rejects website embed launch credentials on the workspace API bearer path", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "embed-launch-bearer@example.com");
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });
    expect(settings.status).toBe(200);
    const publicLaunchCredential = settings.body.websiteEmbedToken as string;

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("Authorization", `Bearer ${publicLaunchCredential}`);

    expect(response.status).toBe(404);
  });

  it("uses a valid session principal before bearer auth when both are present", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "mixed-auth-session@example.com");

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .set("Authorization", "Bearer not-a-valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      anonymousChatEnabled: false,
    });
  });

  it("does not fall back to a valid bearer principal on public-launch-bearing settings", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "mixed-auth-bearer@example.com");

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", "radioso_session=stale-session-token")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("keeps public-launch settings session-only for both credential kinds", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-launch-session-only@example.com");
    const personal = await dependencies.personalCredentialService.issue({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      label: "Contract personal",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const service = await dependencies.serviceAccountService.createWithCredential({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      displayName: "Contract service",
      role: "member",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const requests = [
      { method: "get" as const, path: "/api/v1/settings" },
      { method: "get" as const, path: "/api/v1/settings/general" },
      { method: "put" as const, path: "/api/v1/settings/general", body: { anonymousChatEnabled: true } },
    ];

    for (const token of [personal.secret, service.secret]) {
      for (const item of requests) {
        let requestBuilder = request(app)[item.method](item.path).set("Authorization", `Bearer ${token}`);
        if (item.body) requestBuilder = requestBuilder.send(item.body);
        const response = await requestBuilder;
        expect(response.status, `${item.method.toUpperCase()} ${item.path}`).toBe(401);
        expect(response.body).toMatchObject({ error: { code: "unauthorized" } });
        expect(JSON.stringify(response.body)).not.toContain(token);
      }
    }
  });

  it("allows bearer agent authoring while redacting and blocking public-launch surfaces", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "bearer-safe-agent-authoring@example.com");
    const headers = adminSessionHeaders(session);
    const personal = await dependencies.personalCredentialService.issue({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      label: "Agent personal",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const service = await dependencies.serviceAccountService.createWithCredential({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      displayName: "Agent service",
      role: "member",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const initial = await request(app).get("/api/v1/agents").set(headers).expect(200);
    const launched = await request(app)
      .put(`/api/v1/agents/${initial.body.agents[0].id}`)
      .set(headers)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
          websiteEmbed: { enabled: true, allowedOrigins: ["https://example.com"] },
        },
      })
      .expect(200);
    const launchSecrets = [
      launched.body.surfaceSettings.anonymousChat.token,
      launched.body.surfaceSettings.websiteEmbed.token,
    ];
    expect(launchSecrets.every(Boolean)).toBe(true);

    for (const token of [personal.secret, service.secret]) {
      const bearer = { Authorization: `Bearer ${token}` };
      const listed = await request(app).get("/api/v1/agents").set(bearer).expect(200);
      const detail = await request(app).get(`/api/v1/agents/${initial.body.agents[0].id}`).set(bearer).expect(200);
      const created = await request(app).post("/api/v1/agents").set(bearer).send({ name: "Bearer-authored" }).expect(201);
      const updated = await request(app).put(`/api/v1/agents/${created.body.id}`).set(bearer).send({ name: "Bearer updated" }).expect(200);
      for (const response of [listed, detail, created, updated]) {
        const body = JSON.stringify(response.body);
        expect(body).not.toContain(launchSecrets[0]);
        expect(body).not.toContain(launchSecrets[1]);
        expect(body).not.toContain('"token"');
      }

      await request(app)
        .put(`/api/v1/agents/${created.body.id}`)
        .set(bearer)
        .send({ surfaceSettings: { anonymousChat: { enabled: true } } })
        .expect(403);
      await request(app)
        .put(`/api/v1/agents/${created.body.id}`)
        .set(bearer)
        .send({ surfaceSettings: { websiteEmbed: { enabled: true, allowedOrigins: ["https://example.com"] } } })
        .expect(403);
      const unchanged = await request(app).get(`/api/v1/agents/${created.body.id}`).set(headers).expect(200);
      expect(unchanged.body.surfaceSettings.anonymousChat.token).toBeNull();
      expect(unchanged.body.surfaceSettings.websiteEmbed.token).toBeNull();
    }
  });
});
