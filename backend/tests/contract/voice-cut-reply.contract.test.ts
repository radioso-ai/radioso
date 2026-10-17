import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

type HistoryMessage = {
  id: string;
  role: string;
  content: string;
  interruption?: { heardCharacterCount: number; spokenCharacterCount: number; partial: boolean };
  debug?: { eventStatus: string };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The model behind the call: its first answer says two sentences and then stalls on its third
 * until the turn is cut off (the turn's signal aborts it); every later answer comes at once.
 */
const stallingModel = () => {
  let stalled!: () => void;
  const stalling = new Promise<void>((resolve) => { stalled = resolve; });
  let answers = 0;
  const gateway: ChatGateway = {
    answer: async () => "Sure, any time.",
    async *streamAnswer(input) {
      answers += 1;
      if (answers > 1) {
        yield "Sure, any time.";
        return;
      }
      yield "We open at **nine** on weekdays. ";
      yield "Saturdays we open at ten. ";
      stalled();
      await Promise.race([
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        delay(5_000),
      ]);
      yield "Sundays we rest.";
    },
  };
  return { gateway, stalling };
};

describe("a reply the caller speaks over while it is still being said", () => {
  it("is stored as far as the caller heard it, marked cut short, ahead of the caller's next message", async () => {
    const model = stallingModel();
    const { app, dependencies, repositories } = createTestApp({ chatGateway: model.gateway });
    const session = await issueTestSession(app, `voice-cut-${randomUUID()}@example.com`);
    const dashboard = adminSessionHeaders(session);
    const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
    const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
    const runtimeCredential = await dependencies.accessGrantService.issueGrant({
      agentId,
      workspaceId: session.workspaceId,
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 600_000),
    });
    const sessionKey = randomUUID();
    /** One caller utterance on a stream: every content delta the runtime received, in order, up to `[DONE]`. */
    const callerSays = async (utterance: string) => {
      const response = await request(app)
        .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
        .set("Authorization", `Bearer ${runtimeCredential.token}`)
        .send({ messages: [{ role: "user", content: utterance }], stream: true, elevenlabs_extra_body: { session_key: sessionKey } })
        .buffer(true)
        .parse((res, done) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { body += chunk; });
          res.on("end", () => done(null, body));
        })
        .expect(200);
      const frames = (response.body as string).split("\n\n").map((frame) => frame.replace(/^data: /u, "")).filter((frame) => frame.length > 0);
      expect(frames.at(-1)).toBe("[DONE]");
      return frames.slice(0, -1).flatMap((frame) => {
        const content = (JSON.parse(frame) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content;
        return content ? [content.replace(/\u200B/gu, "")] : [];
      }).join("");
    };

    const cut = callerSays("hello");
    await model.stalling;
    // The two sentences reach the runtime before the caller speaks again.
    await delay(50);
    const next = await callerSays("thanks");
    const heard = await cut;

    expect(heard).toContain("We open at nine on weekdays. ");
    expect(heard).toContain("Saturdays we open at ten. ");
    expect(heard).not.toContain("Sundays");
    expect(next).toContain("Sure, any time.");

    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const conversationId = (history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>)
      .find((conversation) => conversation.channelContext?.sessionKey === sessionKey)!.id;
    const detail = (await request(app).get(`/api/v1/history/chat/${conversationId}`).set(dashboard).expect(200)).body as { messages: HistoryMessage[] };
    expect(detail.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", "We open at **nine** on weekdays. Saturdays we open at ten."],
      ["user", "thanks"],
      ["assistant", "Sure, any time."],
    ]);
    const cutReply = detail.messages[1];
    expect(cutReply.interruption).toEqual({ heardCharacterCount: 54, spokenCharacterCount: 54, partial: true });
    // The turn was cut off, not answered: its debug says so, and the caller's message carries no turn failure.
    expect(cutReply.debug?.eventStatus).toBe("cancelled");
    expect(detail.messages[0]).not.toHaveProperty("turnFailure");
    expect(detail.messages[3]).not.toHaveProperty("interruption");

    const audits = repositories.auditEventRepository.items;
    await expect.poll(() => audits.filter((event) => event.eventType === "voice.reply_interrupted")).toEqual([
      expect.objectContaining({
        workspaceId: session.workspaceId,
        metadata: { conversationId, assistantMessageId: cutReply.id, heardCharacterCount: 54, spokenCharacterCount: 54, partial: true },
      }),
    ]);
    expect(audits.filter((event) => event.eventType === "chat.answer" && event.eventStatus === "cancelled")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ assistantMessageId: cutReply.id, partialReplyStored: true }) }),
    ]);
    expect(JSON.stringify(audits.filter((event) => event.eventType === "voice.reply_interrupted"))).not.toMatch(/nine|Saturdays/u);
  });
});
