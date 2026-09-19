import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("visitor conversations history contract", () => {
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

  const sendVisitorMessage = (app: any, publicChatToken: string, publicSessionToken: string, message: string) =>
    request(app)
      .post(`/api/v1/public/chat/${publicChatToken}`)
      .set("Origin", "https://example.com")
      .set("x-radioso-public-session", publicSessionToken)
      .send({ message, stream: false });

  it("lists a visitor's other conversations, honours ?exclude=, paginates, and 404s across workspaces", async () => {
    // Visitor resolution itself (turning a message into a `visitors` row) is exercised end to
    // end against real Postgres in tests/integration/visitor-resolver.integration.test.ts; the
    // contract harness wires only a seedable visitor-profile read fake (spec 1277, FR-040/041),
    // so this test seeds the visitor and its conversations directly and asserts the HTTP surface.
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "visitor-conversations-contract@example.com");

    const visitorId = randomUUID();
    repositories.visitorRepository.visitors.set(visitorId, {
      id: visitorId,
      workspaceId: session.workspaceId,
      visitorKey: "visitor-key-1",
      verifiedCustomerId: null,
      firstSeenAt: new Date("2026-05-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-05-02T00:00:00.000Z"),
      conversationCount: 2,
      lastCountry: null,
      lastLanguage: null,
      lastUserAgent: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    const first = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      visitorId,
    });
    const second = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      visitorId,
    });

    const withoutExclude = await request(app)
      .get(`/api/v1/history/visitors/${visitorId}/conversations`)
      .set(adminSessionHeaders(session));
    expect(withoutExclude.status).toBe(200);
    expect(withoutExclude.body.total).toBe(2);
    expect(withoutExclude.body.conversations.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    const withExclude = await request(app)
      .get(`/api/v1/history/visitors/${visitorId}/conversations`)
      .query({ exclude: second.id })
      .set(adminSessionHeaders(session));
    expect(withExclude.status).toBe(200);
    expect(withExclude.body.total).toBe(1);
    expect(withExclude.body.conversations).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);

    const paged = await request(app)
      .get(`/api/v1/history/visitors/${visitorId}/conversations`)
      .query({ limit: 1 })
      .set(adminSessionHeaders(session));
    expect(paged.status).toBe(200);
    expect(paged.body.conversations).toHaveLength(1);
    expect(paged.body.hasMore).toBe(true);
    expect(paged.body.nextCursor).toEqual(expect.any(String));

    const otherWorkspaceSession = await issueTestSession(app, "visitor-conversations-contract-other@example.com");
    const crossWorkspace = await request(app)
      .get(`/api/v1/history/visitors/${visitorId}/conversations`)
      .set(adminSessionHeaders(otherWorkspaceSession));
    expect(crossWorkspace.status).toBe(404);

    const missingVisitor = await request(app)
      .get(`/api/v1/history/visitors/${randomUUID()}/conversations`)
      .set(adminSessionHeaders(session));
    expect(missingVisitor.status).toBe(404);
  });

  it("attaches the seeded visitor profile to the conversation detail an operator opens", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "visitor-conversations-detail@example.com");

    const visitorId = randomUUID();
    repositories.visitorRepository.visitors.set(visitorId, {
      id: visitorId,
      workspaceId: session.workspaceId,
      visitorKey: "visitor-key-2",
      verifiedCustomerId: "customer-9",
      firstSeenAt: new Date("2026-05-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-05-02T00:00:00.000Z"),
      conversationCount: 1,
      lastCountry: "DE",
      lastLanguage: "de",
      lastUserAgent: "Mozilla/5.0",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    const conversation = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      visitorId,
      entryReferrer: "https://example.com/pricing",
      requestContext: {
        clientIp: "203.0.113.9",
        country: "DE",
        region: "BE",
        city: "Berlin",
        userAgent: "Mozilla/5.0",
        acceptLanguage: "de-DE,de;q=0.9",
        observedVia: "edge_proof",
      },
    });

    const detail = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}`)
      .set(adminSessionHeaders(session));

    expect(detail.status).toBe(200);
    expect(detail.body.visitor).toMatchObject({ id: visitorId, conversationCount: 1, verified: true });
    expect(detail.body.requestContext).toMatchObject({ clientIp: "203.0.113.9", country: "DE" });
    expect(detail.body.entryReferrer).toBe("https://example.com/pricing");
  });

  it("rejects an invalid visitor id and an invalid exclude id with a validation error", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "visitor-conversations-contract-invalid@example.com");

    const invalidVisitorId = await request(app)
      .get("/api/v1/history/visitors/not-a-uuid/conversations")
      .set(adminSessionHeaders(session));
    expect(invalidVisitorId.status).toBe(400);

    const invalidExclude = await request(app)
      .get(`/api/v1/history/visitors/${randomUUID()}/conversations`)
      .query({ exclude: "not-a-uuid" })
      .set(adminSessionHeaders(session));
    expect(invalidExclude.status).toBe(400);
  });

  it("never exposes visitor, requestContext, or entryReferrer on the public/embed conversation detail (FR-044)", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "visitor-conversations-fr044@example.com");
    const origin = "https://example.com";
    const token = await enableWebsiteEmbed(app, session);

    const publicSession = await createWebsiteEmbedPublicSession(app, token, origin);
    const chat = await sendVisitorMessage(app, token, publicSession.body.publicSessionToken, "Hello there");
    expect(chat.status).toBe(200);

    const publicDetail = await request(app)
      .get(`/api/v1/public/chat/${token}/history/${chat.body.conversationId}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken);

    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body).not.toHaveProperty("visitor");
    expect(publicDetail.body).not.toHaveProperty("requestContext");
    expect(publicDetail.body).not.toHaveProperty("entryReferrer");
    expect(publicDetail.body).not.toHaveProperty("agentInternalName");
    expect(publicDetail.body).not.toHaveProperty("entryPageUrl");
  });
});
