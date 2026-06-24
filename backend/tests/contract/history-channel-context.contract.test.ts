import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

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
    const slackConversation = await repositories.conversationRepository.create(
      session.workspaceId,
      null,
      "authenticated_chat",
      null,
      null,
      slackContext,
    );
    const webConversation = await repositories.conversationRepository.create(
      session.workspaceId,
      null,
      "authenticated_chat",
      null,
      null,
      null,
    );

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
});
