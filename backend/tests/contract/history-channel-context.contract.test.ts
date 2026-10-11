import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

// Stable identity only (FR-012): the thread's reply token is a routing secret and never rides the context.
const emailContextKeys = ["mailbox", "participant", "provider", "threadKey"];

describe("history channel context contract", () => {
  it("returns persisted Slack channel context in history list and detail while web conversations stay null", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "history-channel-context@example.com");
    const slackContext = {
      provider: "slack",
      team: { id: "T123", name: "Ausalt" },
      channel: { id: "D123", type: "im" },
      threadTs: "1712345678.000100",
      user: { id: "U123", displayName: "Dana" },
    } satisfies ConversationChannelContext;
    const slackConversation = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      sourceChannel: "authenticated_chat",
      channelContext: slackContext,
    });
    const webConversation = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      sourceChannel: "authenticated_chat",
    });

    const list = await request(app)
      .get("/api/v1/history/chat")
      .set(adminSessionHeaders(session));
    const activity = await request(app)
      .get("/api/v1/history")
      .set(adminSessionHeaders(session));
    const slackDetail = await request(app)
      .get(`/api/v1/history/chat/${slackConversation.id}`)
      .set(adminSessionHeaders(session));
    const webDetail = await request(app)
      .get(`/api/v1/history/chat/${webConversation.id}`)
      .set(adminSessionHeaders(session));

    expect(list.status).toBe(200);
    expect(list.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: slackConversation.id,
          channelContext: slackContext,
        }),
        expect.objectContaining({
          id: webConversation.id,
          channelContext: null,
        }),
      ]),
    );
    expect(activity.status).toBe(200);
    expect(activity.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "chat",
          id: slackConversation.id,
          conversation: expect.objectContaining({
            id: slackConversation.id,
            channelContext: slackContext,
          }),
        }),
      ]),
    );
    expect(slackDetail.status).toBe(200);
    expect(slackDetail.body).toMatchObject({
      conversationId: slackConversation.id,
      channelContext: slackContext,
    });
    expect(webDetail.status).toBe(200);
    expect(webDetail.body).toMatchObject({
      conversationId: webConversation.id,
      channelContext: null,
    });
  });

  it("round-trips an email channel context in history list and detail, with no thread token", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "history-email-channel-context@example.com");
    const emailContext = {
      provider: "email",
      mailbox: { id: "8a6c1f0e-3f7e-4d55-9a7a-0f6c1e2b3d4a", address: "support@customer.example" },
      threadKey: "5b0e7d2c-91a4-4b8e-8f3e-2c7d6a1b9e05",
      participant: { address: "person@example.org" },
    } satisfies ConversationChannelContext;
    const emailConversation = await repositories.conversationRepository.create({
      workspaceId: session.workspaceId,
      sourceChannel: "email",
      channelContext: emailContext,
    });

    const list = await request(app)
      .get("/api/v1/history/chat")
      .set(adminSessionHeaders(session));
    const detail = await request(app)
      .get(`/api/v1/history/chat/${emailConversation.id}`)
      .set(adminSessionHeaders(session));

    expect(list.status).toBe(200);
    const listed = (list.body.conversations as Array<{ id: string; channelContext: Record<string, unknown> }>)
      .find((conversation) => conversation.id === emailConversation.id);
    expect(listed?.channelContext).toEqual(emailContext);
    expect(Object.keys(listed?.channelContext ?? {}).sort()).toEqual(emailContextKeys);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ conversationId: emailConversation.id, channelContext: emailContext });
    expect(Object.keys(detail.body.channelContext as Record<string, unknown>).sort()).toEqual(emailContextKeys);
  });

  it("publishes the email channel context variant with stable identity only", () => {
    const document = createOpenApiDocument();
    const channelContext = document.components?.schemas?.ConversationChannelContext as {
      oneOf?: Array<{ properties?: Record<string, { enum?: unknown[] }>; required?: string[] }>;
    };
    const emailVariant = channelContext.oneOf?.find((variant) =>
      variant.properties?.provider?.enum?.includes("email"));

    expect(emailVariant).toBeDefined();
    expect(Object.keys(emailVariant?.properties ?? {}).sort()).toEqual(emailContextKeys);
    expect([...(emailVariant?.required ?? [])].sort()).toEqual(emailContextKeys);
  });
});
