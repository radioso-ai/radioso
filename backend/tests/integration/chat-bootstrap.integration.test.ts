import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("chat bootstrap integration", () => {
  it("creates an assistant-first conversation once and reuses it for follow-up turns", async () => {
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
    const { app } = createTestApp({ chatGateway: bootstrapGateway });
    const session = await issueTestSession(app, "chat-bootstrap-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .put("/api/v1/settings/general")
      .set(headers)
      .send({
        assistantName: "Marta",
        assistantRole: "Document assistant",
        greetingInstruction: "Warm and concise",
        proactiveGreetingEnabled: true,
      })
      .expect(200);

    const bootstrap = await request(app)
      .post("/api/v1/chat/")
      .set(headers)
      .send({ bootstrapGreeting: true, stream: false, userExpectedLocale: "it-IT" });

    expect(bootstrap.status).toBe(200);

    const followUp = await request(app)
      .post("/api/v1/chat/")
      .set(headers)
      .send({
        conversationId: bootstrap.body.conversationId,
        query: "Come ti chiami?",
        stream: false,
      });

    expect(followUp.status).toBe(200);
    expect(followUp.body.conversationId).toBe(bootstrap.body.conversationId);

    const history = await request(app)
      .get(`/api/v1/chat/history/${bootstrap.body.conversationId}`)
      .set(headers);

    expect(history.status).toBe(200);
    expect(history.body.messageCount).toBe(3);
    expect(history.body.userMessageCount).toBe(1);
    expect(history.body.assistantMessageCount).toBe(2);
    expect(history.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Ciao! Sono Marta e posso aiutarti con i tuoi documenti.",
        }),
        expect.objectContaining({
          role: "user",
          content: "Come ti chiami?",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "Mi chiamo Marta e sono l'assistente dei documenti.",
        }),
      ]),
    );
    expect(
      history.body.messages.filter(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Ciao! Sono Marta e posso aiutarti con i tuoi documenti.",
      ),
    ).toHaveLength(1);
  });
});
