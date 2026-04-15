import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const findAnonymousCookie = (cookies: string[] | string | undefined) =>
  (Array.isArray(cookies) ? cookies : [cookies]).find((cookie: string | undefined) =>
    typeof cookie === "string" && cookie.startsWith("anon_session_"),
  );

describe("anonymous chat bootstrap integration", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("creates one assistant-first public conversation and reuses it for follow-up turns", async () => {
    const bootstrapGateway: ChatGateway = {
      async answer(input) {
        if (input.query.length === 0) {
          return "Hello! I'm Marta and I can help with your documents.";
        }
        return "Follow-up answer for the public chat.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({ chatGateway: bootstrapGateway });
    const session = await issueTestSession(app, "anon-chat-bootstrap-integration@example.com");
    const headers = adminSessionHeaders(session);

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(headers)
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        assistantRole: "Document assistant",
        proactiveGreetingEnabled: true,
      });

    expect(settings.status).toBe(200);
    const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];

    const bootstrap = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .send({ bootstrapGreeting: true, stream: false, userExpectedLocale: "en-US" });

    expect(bootstrap.status).toBe(200);
    const anonCookie = findAnonymousCookie(bootstrap.headers["set-cookie"]);
    expect(anonCookie).toBeDefined();

    const followUp = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("Cookie", anonCookie!)
      .send({
        conversationId: bootstrap.body.conversationId,
        query: "Can you help me?",
        stream: false,
      });

    expect(followUp.status).toBe(200);
    expect(followUp.body.conversationId).toBe(bootstrap.body.conversationId);

    const history = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${bootstrap.body.conversationId}`)
      .set("Cookie", anonCookie!);

    expect(history.status).toBe(200);
    expect(history.body.messageCount).toBe(3);
    expect(history.body.userMessageCount).toBe(1);
    expect(history.body.assistantMessageCount).toBe(2);
    expect(history.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Hello! I'm Marta and I can help with your documents.",
        }),
        expect.objectContaining({
          role: "user",
          content: "Can you help me?",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "I could not find relevant information in your documents.",
        }),
      ]),
    );
    expect(
      history.body.messages.filter(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Hello! I'm Marta and I can help with your documents.",
      ),
    ).toHaveLength(1);
  });
});
