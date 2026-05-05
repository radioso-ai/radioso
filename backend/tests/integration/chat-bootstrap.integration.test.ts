import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { ProductAnalyticsEvent } from "../../src/shared/analytics/productAnalyticsTypes.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const getAnalyticsPayload = (metadata: Record<string, unknown>): ProductAnalyticsEvent | null => {
  const candidate = metadata.analytics;
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { eventName?: unknown }).eventName !== "string") {
    return null;
  }

  return candidate as ProductAnalyticsEvent;
};

describe("chat bootstrap integration", () => {
  it("returns an ephemeral greeting and starts persistence on the first follow-up turn", async () => {
    const bootstrapGateway: ChatGateway = {
      async answer(input) {
        if (input.query.length === 0) {
          return "Ciao! Sono Marta e posso aiutarti con i tuoi documenti.";
        }
        if (input.query.toLowerCase().includes("come ti chiami")) {
          return "Mi chiamo Marta e sono l'assistente dei documenti.";
        }
        return "Risposta di follow-up con contesto.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app, repositories } = createTestApp({ chatGateway: bootstrapGateway });
    const session = await issueTestSession(app, "chat-bootstrap-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .put("/api/v1/settings/general")
      .set(headers)
      .send({
        assistantName: "Marta",
        greetingInstruction: "Warm and concise",
        proactiveGreetingEnabled: true,
      })
      .expect(200);

    const bootstrap = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ startConversation: true, stream: false, userExpectedLocale: "it-IT" });

    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).not.toHaveProperty("conversationId");
    expect(repositories.conversationRepository.items.size).toBe(0);

    const analyticsEvent = [...repositories.auditEventRepository.items]
      .reverse()
      .find((event) => event.eventType === "product.analytics" && getAnalyticsPayload(event.metadata)?.eventName === "chat.started");
    const analyticsPayload = analyticsEvent ? getAnalyticsPayload(analyticsEvent.metadata) : null;

    expect(analyticsPayload).toEqual(expect.objectContaining({
      eventName: "chat.started",
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      actorType: "authenticated_user",
      subjectType: "workspace",
      subjectId: session.workspaceId,
      source: "backend",
      properties: expect.objectContaining({
        sourceChannel: null,
        sourceOrigin: null,
        localeUsed: "it-IT",
        cacheHit: false,
        proactiveGreetingEnabled: true,
      }),
    }));

    const followUp = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({
        message: "Come ti chiami?",
        stream: false,
      });

    expect(followUp.status).toBe(200);
    expect(followUp.body.conversationId).toEqual(expect.any(String));

    const history = await request(app)
      .get(`/api/v1/history/chat/${followUp.body.conversationId}`)
      .set(headers);

    expect(history.status).toBe(200);
    expect(history.body.messageCount).toBe(2);
    expect(history.body.userMessageCount).toBe(1);
    expect(history.body.assistantMessageCount).toBe(1);
    expect(history.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Come ti chiami?",
        }),
      ]),
    );
    const assistantMessages = history.body.messages.filter((message: { role: string }) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages.every((message: { content: string }) => typeof message.content === "string" && message.content.length > 0)).toBe(
      true,
    );
  });
});
