import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const envelope = (answer: string, suggestions: unknown[]): string =>
  `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(suggestions)}`;

const findAnonymousCookie = (cookies: string[] | string | undefined) =>
  (Array.isArray(cookies) ? cookies : [cookies]).find((cookie: string | undefined) =>
    typeof cookie === "string" && cookie.startsWith("anon_session_"),
  );

const createPublicSession = async (app: any, chatToken: string) => {
  const response = await request(app)
    .post(`/api/v1/public/chat/${chatToken}/sessions`)
    .send({ channel: "anonymous_link" });
  expect(response.status).toBe(200);
  return response.body as { publicSessionToken: string };
};

describe("anonymous chat bootstrap integration", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("returns an ephemeral public greeting and starts persistence on the first follow-up turn", async () => {
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
    const { app, repositories } = createTestApp({ chatGateway: bootstrapGateway });
    const session = await issueTestSession(app, "anon-chat-bootstrap-integration@example.com");
    const headers = adminSessionHeaders(session);

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(headers)
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        proactiveGreetingEnabled: true,
      });

    expect(settings.status).toBe(200);
    const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
    const publicSession = await createPublicSession(app, chatToken);

    const bootstrap = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ startConversation: true, stream: false, userExpectedLocale: "en-US" });

    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).not.toHaveProperty("conversationId");
    expect(repositories.conversationRepository.items.size).toBe(0);
    const anonCookie = findAnonymousCookie(bootstrap.headers["set-cookie"]);
    expect(anonCookie).toBeDefined();

    const followUp = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .send({
        message: "Can you help me?",
        stream: false,
      });

    expect(followUp.status).toBe(200);
    expect(followUp.body.conversationId).toEqual(expect.any(String));

    const history = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${followUp.body.conversationId}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!);

    expect(history.status).toBe(200);
    expect(history.body.messageCount).toBe(2);
    expect(history.body.userMessageCount).toBe(1);
    expect(history.body.assistantMessageCount).toBe(1);
    expect(history.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Can you help me?",
        }),
      ]),
    );
    const assistantMessages = history.body.messages.filter((message: { role: string }) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages.every((message: { content: string }) => typeof message.content === "string" && message.content.length > 0)).toBe(
      true,
    );
    expect(history.body.messages[0]).toMatchObject({
      role: "user",
      content: "Can you help me?",
    });
  });

  it("returns typed deeper and broader suggestions for public exploratory chat", async () => {
    const publicGateway: ChatGateway = {
      async answer({ systemPrompt, query }) {
        const answerText = query.length === 0
          ? "Hello! I'm Marta and I can help with your documents."
          : "The testing guide explains testing and parsing content for users[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "Which input formats do the parser notes list?", kind: "deeper", contextIndex: 1 },
            { text: "Which onboarding topics are related?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({ chatGateway: publicGateway });
    const session = await issueTestSession(app, "anon-chat-suggestions@example.com");
    const headers = adminSessionHeaders(session);

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(headers)
      .send({
        anonymousChatEnabled: true,
        assistantName: "Marta",
        proactiveGreetingEnabled: false,
      });
    await request(app)
      .put("/api/v1/settings/retrieval")
      .set(headers)
      .send({
        queryRewriteEnabled: false,
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 4,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        citationDisplayEnabled: true,
      });
    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({ title: "Parser Notes", content: "The testing docs cover parser notes, supported input formats, and validation rules." });
    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({ title: "User FAQ", content: "The testing docs cover onboarding questions and common support issues." });

    expect(settings.status).toBe(200);
    const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
    const publicSession = await createPublicSession(app, chatToken);

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .send({ message: "What do the testing docs cover?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("route");
    expect(response.body).not.toHaveProperty("citations");
    expect(response.body.answerSegments).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({
          citationIndices: expect.any(Array),
        }),
      ]),
    );
    expect(response.body).not.toHaveProperty("activitySummary");
    expect(response.body.suggestions.length).toBeGreaterThan(0);
    expect(
      response.body.suggestions.every((suggestion: { kind: string }) =>
        suggestion.kind === "deeper" || suggestion.kind === "broader")
    ).toBe(true);
    expect(
      response.body.suggestions.some((suggestion: { kind: string }) => suggestion.kind === "broader"),
    ).toBe(true);

    const anonCookie = findAnonymousCookie(response.headers["set-cookie"]);
    const history = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${response.body.conversationId}`)
      .set("x-radioso-public-session", publicSession.publicSessionToken)
      .set("Cookie", anonCookie!)
      .expect(200);
    const assistantTurn = history.body.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistantTurn).not.toHaveProperty("citations");
    expect(assistantTurn?.answerSegments).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({
          citationIndices: expect.any(Array),
        }),
      ]),
    );
    expect(assistantTurn).not.toHaveProperty("debug");
  });
});
