import { describe, expect, it } from "vitest";
import request from "supertest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("public chat session contract", () => {
  const enableWebsiteEmbed = async (app: any, session: { cookie: string; workspaceId: string }) => {
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
        websiteEmbedLauncherLabel: "Talk to us",
      });

    return response.body.websiteEmbedToken as string;
  };

  const createWebsiteEmbedPublicSession = (app: any, token: string, origin = "https://example.com", body = {}) =>
    request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", origin)
      .send({ channel: "website_embed", ...body });

  it("creates a website embed session for an approved origin", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-approved@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceName: expect.any(String),
      publicChatToken: expect.any(String),
      publicSessionId: expect.any(String),
      publicSessionToken: expect.any(String),
      assistantBootstrapActive: false,
    });
    expect(response.body.expiresAt).toEqual(expect.any(String));
  });

  it("returns 503 when website embed secret is unset", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_SECRET: undefined,
      },
    });
    const session = await issueTestSession(app, "public-embed-missing-secret@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";
    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "service_unavailable",
      message: "Public chat sessions are not configured.",
    });
  });

  it("rejects an unapproved origin", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-embed-denied@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://not-approved.example.com";

    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
    });

    const auditEvents = (dependencies.auditService as unknown as {
      events: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
    }).events;
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "website_embed.launch_denied",
        metadata: expect.objectContaining({ origin }),
      }),
    );
  });

  it("rejects embed launches that omit the browser origin header", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-origin-header@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const response = await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .send({ channel: "website_embed" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid public chat session request",
    });
  });

  it("creates an anonymous link session", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-session@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1);
    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      publicChatToken: anonymousChatToken,
      publicSessionId: expect.any(String),
      publicSessionToken: expect.any(String),
    });
  });

  it("allows website embed launches even when anonymous chat is disabled", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-independent@example.com");

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });

    const token = response.body.websiteEmbedToken as string;
    const origin = "https://example.com";

    const publicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.body.anonymousChatEnabled).toBe(false);
    expect(publicSession.status).toBe(200);

    const chatResponse = await request(app)
      .post(`/api/v1/public/chat/${publicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(chatResponse.status).toBe(200);
  });

  it("reuses a requested anonymous session id on a later approved bootstrap", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-resume@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const firstPublicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    const firstChat = await request(app)
      .post(`/api/v1/public/chat/${firstPublicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", firstPublicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(firstChat.status).toBe(200);

    const resumedPublicSession = await createWebsiteEmbedPublicSession(app, token, origin, {
      anonymousSessionId: firstChat.headers["x-radioso-anonymous-session"],
    });

    expect(resumedPublicSession.status).toBe(200);

    const historyResponse = await request(app)
      .get(`/api/v1/public/chat/${resumedPublicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", resumedPublicSession.body.publicSessionToken);

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstChat.body.conversationId,
        }),
      ]),
    );
  });

  it("records an audit event when launch is denied because embed is disabled", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-embed-disabled-audit@example.com");

    const token = await enableWebsiteEmbed(app, session);
    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: false,
      });

    const origin = "https://example.com";
    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(404);

    const auditEvents = (dependencies.auditService as unknown as {
      events: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
    }).events;
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "website_embed.launch_denied",
        metadata: expect.objectContaining({
          origin,
          reason: "embed_disabled",
        }),
      }),
    );
  });
});
