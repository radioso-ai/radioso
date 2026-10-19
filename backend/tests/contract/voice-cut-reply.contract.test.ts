import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import type { CutReplyStore } from "../../src/modules/chat/services/chatTurnLifecycle.js";
import { InMemoryCutReplyStore } from "../support/fakes.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

type HistoryMessage = {
  id: string;
  role: string;
  content: string;
  interruption?: { heardCharacterCount: number; spokenCharacterCount: number; partial: boolean };
  debug?: { eventStatus: string };
};

const FIRST_SENTENCES = ["We open at **nine** on weekdays. ", "Saturdays we open at ten. "];
const NEXT_ANSWER = "Sure, any time.";

/**
 * The model behind the call: its first answer says two sentences, then holds its third until the
 * turn is cut off, when the turn's signal aborts it; every later answer comes at once. It keeps
 * what each answer was asked with.
 */
const stallingModel = () => {
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const asked: ChatGatewayInput[] = [];
  const gateway: ChatGateway = {
    answer: async () => NEXT_ANSWER,
    async *streamAnswer(input) {
      asked.push(input);
      if (asked.length > 1) {
        yield NEXT_ANSWER;
        return;
      }
      yield* FIRST_SENTENCES;
      held();
      await new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      yield "Sundays we rest.";
    },
  };
  return { gateway, holding, asked };
};

/** A call on the workspace's default agent, its runtime's requests for one session key, and the call as the Inbox reads it. */
const call = async (model: ReturnType<typeof stallingModel>, cutReplyStore?: (inner: CutReplyStore) => CutReplyStore) => {
  let store: CutReplyStore | undefined;
  const { app, dependencies, repositories } = createTestApp({
    chatGateway: model.gateway,
    ...(cutReplyStore ? { cutReplyStore: { storeCutReply: (input) => store!.storeCutReply(input) } } : {}),
  });
  if (cutReplyStore) {
    store = cutReplyStore(new InMemoryCutReplyStore(repositories.messageRepository, repositories.conversationRepository, repositories.auditEventRepository));
  }
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

  /**
   * One request as ElevenLabs sends it: the history, then the caller's utterance. A streamed one
   * resolves the text the runtime received; `received` resolves once that text holds `until`.
   */
  const runtimeSends = (messages: Array<{ role: "user" | "assistant"; content: string }>, options: { stream: boolean; until?: string }) => {
    let reached!: () => void;
    const received = new Promise<void>((resolve) => { reached = resolve; });
    const heard = request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({ messages, stream: options.stream, elevenlabs_extra_body: { session_key: sessionKey } })
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (options.until && body.includes(options.until)) reached();
        });
        res.on("end", () => done(null, body));
      })
      .expect(200)
      .then((response) => {
        const body = response.body as string;
        if (!options.stream) {
          return (JSON.parse(body) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
        }
        const frames = body.split("\n\n").map((frame) => frame.replace(/^data: /u, "")).filter((frame) => frame.length > 0);
        expect(frames.at(-1)).toBe("[DONE]");
        return frames.slice(0, -1).flatMap((frame) => {
          const content = (JSON.parse(frame) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content;
          // The elevenlabs dialect's flush delta (a space and a zero-width space) is wire-level, not speech.
          return content ? [content.replace(/ ?\u200B/gu, "")] : [];
        }).join("");
      });
    return { heard, received };
  };
  const conversation = async () => {
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const id = (history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>)
      .find((item) => item.channelContext?.sessionKey === sessionKey)!.id;
    const detail = (await request(app).get(`/api/v1/history/chat/${id}`).set(dashboard).expect(200)).body as { messages: HistoryMessage[] };
    return { id, messages: detail.messages };
  };
  return { session, repositories, runtimeSends, conversation };
};

describe("a reply the caller speaks over while it is still being said", () => {
  it("is stored as far as ElevenLabs played it, marked cut short, and the next turn answers with it in its history", async () => {
    const model = stallingModel();
    const voice = await call(model);

    const cut = voice.runtimeSends([{ role: "user", content: "hello" }], { stream: true, until: "Saturdays we open at ten." });
    await cut.received;
    // ElevenLabs had played the first sentence and two words of the second when the caller spoke.
    const next = voice.runtimeSends([
      { role: "user", content: "hello" },
      { role: "assistant", content: "We open at nine on weekdays. Saturdays we..." },
      { role: "user", content: "thanks" },
    ], { stream: true });

    expect(await next.heard).toContain(NEXT_ANSWER);
    const heard = await cut.heard;
    expect(heard).toContain("We open at nine on weekdays. Saturdays we open at ten. ");
    expect(heard).not.toContain("Sundays");

    const { id, messages } = await voice.conversation();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", "We open at **nine** on weekdays."],
      ["user", "thanks"],
      ["assistant", NEXT_ANSWER],
    ]);
    const cutReply = messages[1];
    expect(cutReply.interruption).toEqual({ heardCharacterCount: 41, spokenCharacterCount: 54, partial: true });
    // The turn was cut off, not answered: its debug says so, and the caller's message carries no turn failure.
    expect(cutReply.debug?.eventStatus).toBe("cancelled");
    expect(messages[0]).not.toHaveProperty("turnFailure");
    expect(messages[3]).not.toHaveProperty("interruption");
    // The next answer was written knowing what the agent had said.
    expect(model.asked[1]?.history.map((message) => [message.role, message.content])).toContainEqual(["assistant", "We open at **nine** on weekdays."]);

    const audits = voice.repositories.auditEventRepository.items;
    expect(audits.filter((event) => event.eventType === "voice.reply_interrupted")).toEqual([
      expect.objectContaining({
        workspaceId: voice.session.workspaceId,
        metadata: { conversationId: id, assistantMessageId: cutReply.id, heardCharacterCount: 41, spokenCharacterCount: 54, partial: true },
      }),
    ]);
    expect(audits.filter((event) => event.eventType === "chat.answer" && event.eventStatus === "cancelled")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ assistantMessageId: cutReply.id, partialReplyStored: true }) }),
    ]);
    expect(JSON.stringify(audits.filter((event) => event.eventType === "voice.reply_interrupted"))).not.toMatch(/nine|Saturdays/u);
  });

  it("keeps the newer turn waiting until the cut reply's part is stored", async () => {
    const model = stallingModel();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let storing!: () => void;
    const reachedStore = new Promise<void>((resolve) => { storing = resolve; });
    const voice = await call(model, (inner) => ({
      storeCutReply: async (input) => {
        storing();
        await released;
        await inner.storeCutReply(input);
      },
    }));

    const cut = voice.runtimeSends([{ role: "user", content: "hello" }], { stream: true, until: "Saturdays we open at ten." });
    await cut.received;
    const next = voice.runtimeSends([{ role: "user", content: "thanks" }], { stream: true });
    await reachedStore;
    // Still storing: the newer turn has not asked the model yet.
    await new Promise((resolve) => setImmediate(resolve));
    expect(model.asked).toHaveLength(1);

    release();
    expect(await next.heard).toContain(NEXT_ANSWER);
    await cut.heard;
    expect(model.asked).toHaveLength(2);
    expect((await voice.conversation()).messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stores nothing for a request that is not streamed, which the runtime gets only at its outcome", async () => {
    const model = stallingModel();
    const voice = await call(model);

    const cut = voice.runtimeSends([{ role: "user", content: "hello" }], { stream: false });
    await model.holding;
    const next = voice.runtimeSends([{ role: "user", content: "thanks" }], { stream: false });

    expect(await next.heard).toBe(NEXT_ANSWER);
    await cut.heard;
    const { messages } = await voice.conversation();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["user", "thanks"],
      ["assistant", NEXT_ANSWER],
    ]);
    expect(voice.repositories.auditEventRepository.items.filter((event) => event.eventType === "voice.reply_interrupted")).toEqual([]);
  });
});
