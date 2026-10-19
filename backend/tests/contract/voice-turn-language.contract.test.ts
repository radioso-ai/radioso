import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import { createTestApp } from "../support/testApp.js";
import { openVoiceRuntime } from "../support/voiceRuntime.js";

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); });
    try {
      await Promise.race([heard, limit]);
    } finally {
      clearTimeout(timer);
    }
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

/**
 * The language the vendor's `language_detection` tool switched the call to, as ElevenLabs replays
 * it: the call, then its result (the vendor's `LanguageDetectionToolResultModel`, as JSON).
 */
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
  {
    role: "tool",
    tool_call_id: "call_language",
    content: JSON.stringify({ result_type: "language_detection_success", status: "success", reason: "The caller speaks Italian", language }),
  },
];

const call = async () => {
  const model = modelThatWaitsForTheBridge();
  const testApp = createTestApp({ chatGateway: model.gateway });
  const { app, dependencies } = testApp;
  const { dashboard, agentId, runtimeToken } = await openVoiceRuntime(testApp, { emailPrefix: "voice-language", agentSettings: { assistantDefaultLocale: "en", voice } });
  const chatTurns = vi.spyOn(dependencies.assistantChatService, "streamAnswer");
  const sessionKey = randomUUID();

  /**
   * One streamed turn as ElevenLabs sends it, for a session the page started in English; resolves
   * the content frames the runtime received, in order, without the dialect's wire-only deltas.
   */
  const runtimeSends = async (messages: unknown[], expectedBridge: string): Promise<string[]> => {
    const bridgeHeard = model.nextBridge();
    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeToken}`)
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
      const spoken = content?.replace(/ ?\u200B/gu, "").trim();
      return spoken ? [spoken] : [];
    });
  };
  /** A request without the bridge wait, as the runtime sends it; resolves the raw response. */
  const runtimeSendsRaw = (messages: unknown[], stream: boolean) => request(app)
    .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
    .set("Authorization", `Bearer ${runtimeToken}`)
    .send({ messages, stream, elevenlabs_extra_body: { session_key: sessionKey, locale: "en" } })
    .expect(200);
  const conversationMessages = async () => {
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const id = (history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>)
      .find((item) => item.channelContext?.sessionKey === sessionKey)!.id;
    return ((await request(app).get(`/api/v1/history/chat/${id}`).set(dashboard).expect(200)).body as { messages: Array<{ role: string; content: string }> }).messages;
  };
  const userExpectedLocales = () => chatTurns.mock.calls.map(([input]) => (input as { userExpectedLocale?: string }).userExpectedLocale);
  return { runtimeSends, runtimeSendsRaw, conversationMessages, chatTurnCount: () => chatTurns.mock.calls.length, userExpectedLocales };
};

describe("a call whose caller changes language mid-call", () => {
  it("bridges in the session's English until ElevenLabs switches the call to Italian, then in Italian, and hands chat the language on the turn it switched", async () => {
    const voiceCall = await call();

    const english = await voiceCall.runtimeSends([
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Hello, when are you open?" },
    ], ENGLISH_BRIDGE);
    // The bridge line is the turn's first frame, and the answer follows it.
    expect(english[0]).toBe(ENGLISH_BRIDGE);
    expect(english.length).toBeGreaterThan(1);

    const italian = await voiceCall.runtimeSends([
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Hello, when are you open?" },
      { role: "assistant", content: english.join(" ") },
      { role: "user", content: "Scusi, parla italiano?" },
      ...languageSwitch("it"),
      { role: "assistant", content: "Certo, parlo italiano." },
      { role: "user", content: "Siete aperti domenica?" },
    ], ITALIAN_BRIDGE);
    expect(italian[0]).toBe(ITALIAN_BRIDGE);
    expect(italian.length).toBeGreaterThan(1);

    // The call stays in Italian: the switch is still the newest in the history, and an earlier turn made it.
    const later = await voiceCall.runtimeSends([
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Hello, when are you open?" },
      { role: "assistant", content: english.join(" ") },
      { role: "user", content: "Scusi, parla italiano?" },
      ...languageSwitch("it"),
      { role: "assistant", content: "Certo, parlo italiano." },
      { role: "user", content: "Siete aperti domenica?" },
      { role: "assistant", content: italian.join(" ") },
      { role: "user", content: "E il sabato?" },
    ], ITALIAN_BRIDGE);
    expect(later[0]).toBe(ITALIAN_BRIDGE);

    // Chat is told the language on the turn the switch is news; the session's own locale is how the
    // call started, not a language for chat to answer in, and neither is a switch an earlier turn made.
    expect(voiceCall.userExpectedLocales()).toEqual([undefined, "it", undefined]);
  });

  it("answers the runtime's request right after a tool call with an empty completion, and stores nothing for it", async () => {
    const voiceCall = await call();
    const opening = [
      { role: "system", content: "You are the booking line." },
      { role: "user", content: "Scusi, parla italiano?" },
    ];
    await voiceCall.runtimeSends(opening, ENGLISH_BRIDGE);
    const stored = await voiceCall.conversationMessages();

    // The runtime's follow-up once its tool ran: the newest message is the tool's result, so the
    // newest user message is the one the previous request already answered.
    const followUp = [...opening, ...languageSwitch("it")];
    const streamed = await voiceCall.runtimeSendsRaw(followUp, true);
    const whole = await voiceCall.runtimeSendsRaw(followUp, false);

    const frames = streamed.text.split("\n\n").filter(Boolean).map((frame) => frame.replace(/^data: /u, ""));
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.slice(0, -1).map((frame) => (JSON.parse(frame) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> }).choices[0]))
      .toEqual([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }]);
    expect(whole.headers["x-radioso-voice-outcome"]).toBe("continue");
    expect((whole.body as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("");
    expect(voiceCall.chatTurnCount()).toBe(1);
    expect(await voiceCall.conversationMessages()).toEqual(stored);
  });
});
