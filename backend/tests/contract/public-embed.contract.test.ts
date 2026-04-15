import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("public embed contract", () => {
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

  const signEmbedLaunch = (token: string, origin: string) =>
    createHmac("sha256", "0123456789abcdef0123456789abcdef").update(`${token}:${origin}`).digest("hex");

  it("bootstraps an embedded session for an approved origin", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-approved@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const response = await request(app)
      .post(`/api/v1/public/embed/${token}/session`)
      .set("x-radioso-embed-origin", origin)
      .set("x-radioso-embed-signature", signEmbedLaunch(token, origin));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceName: expect.any(String),
      publicChatToken: expect.any(String),
      assistantBootstrapActive: false,
    });
    expect(response.body.expiresAt).toEqual(expect.any(String));
  });

  it("rejects an unapproved origin", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-embed-denied@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://not-approved.example.com";

    const response = await request(app)
      .post(`/api/v1/public/embed/${token}/session`)
      .set("x-radioso-embed-origin", origin)
      .set("x-radioso-embed-signature", signEmbedLaunch(token, origin));

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
    });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "website_embed.launch_denied",
        metadata: expect.objectContaining({ origin }),
      }),
    );
  });

  it("rejects an invalid embed signature even for an approved origin", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-signature@example.com");

    const token = await enableWebsiteEmbed(app, session);

    const response = await request(app)
      .post(`/api/v1/public/embed/${token}/session`)
      .set("x-radioso-embed-origin", "https://example.com")
      .set("x-radioso-embed-signature", "bad-signature");

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
      message: "This embedded chat launch could not be verified.",
    });
  });

  it("works when website embed is enabled and anonymous chat remains disabled", async () => {
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

    const embedSession = await request(app)
      .post(`/api/v1/public/embed/${token}/session`)
      .set("x-radioso-embed-origin", origin)
      .set("x-radioso-embed-signature", signEmbedLaunch(token, origin));

    expect(response.body.anonymousChatEnabled).toBe(false);
    expect(embedSession.status).toBe(200);
    expect(embedSession.body.publicChatToken).toEqual(expect.any(String));
    expect(embedSession.body.publicChatToken).not.toBe(token);
  });
});
