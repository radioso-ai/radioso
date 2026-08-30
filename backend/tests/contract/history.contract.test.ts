import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ContactHistoryDetail, ContactHistoryProviderPort } from "../../src/modules/chat/services/contactHistoryProvider.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("history contract", () => {
  it("lists and fetches assistant conversation history from the platform history routes", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "history-contract@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "History Intro", content: "History uses assistant conversation records." });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "What records does history use?", stream: false });

    const list = await request(app)
      .get("/api/v1/history/chat")
      .set(adminSessionHeaders(session));
    const itemsPage = await request(app)
      .get("/api/v1/history")
      .set(adminSessionHeaders(session));
    const detail = await request(app)
      .get(`/api/v1/history/chat/${chat.body.conversationId}`)
      .set(adminSessionHeaders(session));
    const legacyDetail = await request(app)
      .get(`/api/v1/history/${chat.body.conversationId}`)
      .set(adminSessionHeaders(session));

    expect(chat.status).toBe(200);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      conversations: [
        expect.objectContaining({
          id: chat.body.conversationId,
          agentId: chat.body.agentId,
          agentName: null,
          messageCount: 2,
          userMessageCount: 1,
          assistantMessageCount: 1,
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(itemsPage.status).toBe(200);
    expect(itemsPage.body).toMatchObject({
      items: [
        expect.objectContaining({
          kind: "chat",
          id: chat.body.conversationId,
          conversation: expect.objectContaining({
            id: chat.body.conversationId,
            agentId: chat.body.agentId,
            agentName: null,
            messageCount: 2,
          }),
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      conversationId: chat.body.conversationId,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "What records does history use?" }),
        expect.objectContaining({
          role: "assistant",
          debug: expect.objectContaining({
            route: expect.objectContaining({
              generator: "assistant",
              routeType: "retrieval",
              retrievalInvoked: true,
            }),
          }),
        }),
      ]),
    });
    expect(legacyDetail.status).toBe(200);
    expect(legacyDetail.body).toMatchObject({
      conversationId: chat.body.conversationId,
      messageCount: 2,
    });
  });

  it("documents shared history in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/history:");
    expect(spec).toContain("/api/v1/history/chat:");
    expect(spec).toContain("/api/v1/history/search:");
    expect(spec).toContain("/api/v1/history/chat/{conversationId}:");
    expect(spec).toContain("/api/v1/history/{conversationId}:");
    expect(spec).toContain("/api/v1/history/search/{searchId}:");
    expect(spec).not.toContain("/api/v1/chat/history:");
  });

  it("rejects cursor pagination on the merged history items", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "history-items-cursor@example.com");

    const response = await request(app)
      .get("/api/v1/history?cursor=opaque")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
  });

  it("rejects an unrecognized outcome filter value on the merged history items", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "history-items-bad-outcome@example.com");

    const response = await request(app)
      .get("/api/v1/history?outcome=archived")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
  });

  it("narrows the merged history items by agentId end to end through the route", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "history-items-agent-filter@example.com");
    const matching = await repositories.conversationRepository.create(session.workspaceId, "99999999-9999-4999-8999-999999999999");
    await repositories.conversationRepository.create(session.workspaceId, "88888888-8888-4888-8888-888888888888");

    const response = await request(app)
      .get("/api/v1/history?agentId=99999999-9999-4999-8999-999999999999")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ kind: "chat", conversation: { id: matching.id } });
  });

  it("keeps contact detail on the same dashboard projection as chat detail", async () => {
    const contact: ContactHistoryDetail = {
      id: "66666666-6666-4666-8666-666666666666",
      sortAt: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-placeholder",
      conversationId: "77777777-7777-4777-8777-777777777777",
      assistantMessageId: null,
      sourceChannel: "website_embed",
      sourceOrigin: "https://example.com/help",
      userEmail: "customer@example.com",
      messagePreview: "Please contact me about billing.",
      message: "Please contact me about billing.",
      triggerSource: "manual",
      triggerReason: null,
      status: "pending",
      attempts: 0,
      finalDeliveryError: null,
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    };
    const contactHistoryProvider: ContactHistoryProviderPort = {
      async listPageByWorkspaceId(workspaceId, input) {
        const contacts = contact.workspaceId === workspaceId ? [contact].slice(input.offset ?? 0, (input.offset ?? 0) + input.limit) : [];
        return {
          contacts,
          total: contact.workspaceId === workspaceId ? 1 : 0,
          nextCursor: null,
          hasMore: false,
        };
      },
      async getById(workspaceId, requestId) {
        return contact.workspaceId === workspaceId && contact.id === requestId ? contact : null;
      },
    };
    const { app, repositories } = createTestApp({ contactHistoryProvider });
    const session = await issueTestSession(app, "history-contact-detail@example.com");
    contact.workspaceId = session.workspaceId;

    const conversation = await repositories.conversationRepository.create(
      session.workspaceId,
      "88888888-8888-4888-8888-888888888888",
      "website_embed",
      null,
      "https://example.com/help",
      null,
      null,
      { entryPageUrl: "https://example.com/pricing" },
    );
    conversation.agentName = "Public support";
    conversation.agentInternalName = "Billing support";
    contact.conversationId = conversation.id;

    const chatDetail = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}`)
      .set(adminSessionHeaders(session));
    const contactDetail = await request(app)
      .get(`/api/v1/history/contact/${contact.id}`)
      .set(adminSessionHeaders(session));

    expect(chatDetail.status).toBe(200);
    expect(contactDetail.status).toBe(200);
    expect(chatDetail.body).toMatchObject({
      agentInternalName: "Billing support",
      entryPageUrl: "https://example.com/pricing",
    });
    expect(contactDetail.body.conversation).toMatchObject({
      conversationId: conversation.id,
      agentName: "Public support",
      agentInternalName: "Billing support",
      entryPageUrl: "https://example.com/pricing",
    });
  });

  it("filters chat history to human-owned conversations and returns the filtered total", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "history-human-owned@example.com");
    const humanOwned = await repositories.conversationRepository.create(session.workspaceId);
    await repositories.conversationRepository.create(session.workspaceId);
    await repositories.conversationOwnershipRepository.requestHandoff({
      conversationId: humanOwned.id,
      workspaceId: session.workspaceId,
      reason: "retrieval_miss",
    });

    const response = await request(app)
      .get("/api/v1/history/chat?limit=1&ownership=human_owned")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      conversations: [expect.objectContaining({ id: humanOwned.id })],
    });
  });

});
