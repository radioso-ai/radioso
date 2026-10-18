import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const ENGLISH_BRIDGE = "Let me check that for you, it only takes a moment.";
const ITALIAN_BRIDGE = "Controllo subito per te, ci vorrà solo un momento.";
const ANSWER = "Siamo aperti dalle nove.";

const voice = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ["Got it, thank you, just give me a second to note that down."], check: [ENGLISH_BRIDGE] },
    it: { acknowledge: ["Perfetto, ho preso nota e ora passo al punto successivo."], check: [ITALIAN_BRIDGE] },
  },
  fallbackLine: {
    en: "Sorry, this is taking much longer than it should, could you ask me again?",
    it: "Scusa, ci sto mettendo troppo, puoi ripetere la domanda per favore?",
  },
};

/**
 * The model behind the call: every call it gets waits until the runtime has received a bridge line
 * (at most 5 s), so the turn always reaches its bridge before it speaks.
 */
const modelThatWaitsForTheBridge = () => {
  let bridgeHeard: () => void = () => undefined;
  let heard = Promise.resolve();
  const waitForBridge = async (): Promise<void> => {
    await Promise.race([heard, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  };
  const gateway: ChatGateway = {
    answer: async () => {
      await waitForBridge();
      return ANSWER;
    },
    async *streamAnswer() {
      await waitForBridge();
      yield ANSWER;
    },
  };
  return {
    gateway,
    /** Arms the wait for the next request's bridge line; returns what resolves it. */
    nextBridge: () => {
      heard = new Promise<void>((resolve) => { bridgeHeard = resolve; });
      return () => bridgeHeard();
    },
  };
};

/** The language the vendor's `language_detection` tool switched the call to, as ElevenLabs replays it. */
const languageSwitch = (language: string) => [
  {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_language",
      type: "function",
      function: { name: "language_detection", arguments: JSON.stringify({ reason: "The caller speaks Italian", language }) },
    }],
  },
  { role: "tool", tool_call_id: "call_language", content: `Language switched to ${language}` },
];

const call = async () => {
  const model = modelThatWaitsForTheBridge();
  const { app, dependencies } = createTestApp({ chatGateway: model.gateway });
  const session = await issueTestSession(app, `voice-language-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(session);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ assistantDefaultLocale: "en", voice }).expect(200);
  const runtimeCredential = await dependencies.accessGrantService.issueGrant({
    agentId,
    workspaceId: session.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 600_000),
  });
  const chatTurns = vi.spyOn(dependencies.assistantChatService, "streamAnswer");
  const sessionKey = randomUUID();

  /** One streamed turn as ElevenLabs sends it, for a session the page started in English; resolves the text the runtime received. */
  const runtimeSends = async (messages: unknown[], expectedBridge: string): Promise<string> => {
    const bridgeHeard = model.nextBridge();
    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({ messages, stream: true, elevenlabs_extra_body: { session_key: sessionKey, locale: "en" } })
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.includes(expectedBridge)) bridgeHeard();
        });
        res.on("end", () => done(null, body));
      })
      .expect(200);
    const frames = (response.body as string).split("\n\n").map((frame) => frame.replace(/^data: /u, "")).filter((frame) => frame.length > 0);
    expect(frames.at(-1)).toBe("[DONE]");
    return frames.slice(0, -1).flatMap((frame) => {
      const content = (JSON.parse(frame) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content;
      // The elevenlabs dialect's flush delta and keep-alive (a space and a zero-width space) are wire-level, not speech.
      return content ? [content.replace(/ ?\u200B/gu, "")] : [];
    }).join("");
  };
  const userExpectedLocales = () => chatTurns.mock.calls.map(([input]) => (input as { userExpectedLocale?: string }).userExpectedLocale);
  return { runtimeSends, userExpectedLocales };
};

describe("a call whose caller changes language mid-call", () => {
  it("bridges in the session's English until ElevenLabs switches the call to Italian, then in Italian, and hands chat the switched language", async () => {
    const voiceCall = await call();

    const english = await voiceCall.runtimeSends([
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Hello, when are you open?" },
    ], ENGLISH_BRIDGE);
    expect(english.startsWith(ENGLISH_BRIDGE)).toBe(true);

    const italian = await voiceCall.runtimeSends([
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Hello, when are you open?" },
      { role: "assistant", content: english },
      { role: "user", content: "Scusi, parla italiano?" },
      ...languageSwitch("it"),
      { role: "assistant", content: "Certo, parlo italiano." },
      { role: "user", content: "Siete aperti domenica?" },
    ], ITALIAN_BRIDGE);
    expect(italian.startsWith(ITALIAN_BRIDGE)).toBe(true);
    // The answer follows the bridge line on the same turn.
    expect(italian.slice(ITALIAN_BRIDGE.length).trim()).not.toBe("");

    // The session's own locale is how the call started, not a language for chat to answer in.
    expect(voiceCall.userExpectedLocales()).toEqual([undefined, "it"]);
  });
});
