import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import { TurnPlanCoordinator } from "../../src/modules/chat/services/turnPlanCoordinator.js";
import { TurnPlanService } from "../../src/modules/chat/services/turnPlanService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import type { TurnPlanGatewayFactory } from "../../src/shared/infra/llm/turnPlanGateway.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const UTTERANCE = "A che ora aprite domani?";
const ANSWER = "Domani apriamo alle nove.";

const voice = {
  enabled: true,
  languageSwitching: true,
  bridgeLines: {
    en: { acknowledge: ["Got it, thank you, just give me a second to note that down."], check: ["Let me check that for you, it only takes a moment."] },
    it: { acknowledge: ["Perfetto, ho preso nota e ora passo al punto successivo."], check: ["Controllo subito per te, ci vorrà solo un momento."] },
  },
  fallbackLine: { en: "Sorry, this is taking much longer than it should, could you ask me again?" },
};

/** `language_detection` as ElevenLabs offers it in every request's `tools` (probe, 2026-10-18). */
const languageDetectionTool = {
  type: "function",
  function: {
    name: "language_detection",
    description: "Switch the conversation language when the user speaks another language.",
    parameters: { type: "object", properties: { reason: { type: "string" }, language: { type: "string" } }, required: ["reason", "language"] },
  },
};

/** The planner: every turn is a direct answer in Italian, tagged `it`. */
const plannerInItalian: TurnPlanGatewayFactory = {
  create: async () => ({
    complete: async () => ({
      text: JSON.stringify({
        route: "direct",
        isIdentityQuestion: false,
        intentTopic: null,
        rewrite: null,
        responseLanguage: "Italian",
        responseLanguageTag: "it",
        requestPresent: true,
        openQuestion: false,
        quickReply: { kind: "none", language: null, text: "" },
      }),
    }),
  }),
};

const answeringModel: ChatGateway = {
  answer: async () => ANSWER,
  async *streamAnswer() {
    yield ANSWER;
  },
};

type Frame = { choices: Array<{ delta: { role?: string; content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string | null }> };

const framesOf = (body: string): Array<Frame | "[DONE]"> =>
  body.split("\n\n").filter(Boolean).map((frame) => frame.replace(/^data: /u, "")).map((data) => (data === "[DONE]" ? data : JSON.parse(data) as Frame));

const spokenOf = (frames: Array<Frame | "[DONE]">): string =>
  frames.flatMap((frame) => (frame === "[DONE]" ? [] : [frame.choices[0]?.delta.content ?? ""]))
    // The elevenlabs dialect's flush delta (a space and a zero-width space) is wire-level, not speech.
    .join("").replace(/ ?\u200B/gu, "").trim();

/** A model whose first answer waits until the test lets it go; every later one answers at once. */
const modelHeldOnce = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const answerFor = async (): Promise<string> => {
    calls += 1;
    if (calls === 1) await released;
    return calls === 1 ? ANSWER : LATER_ANSWER;
  };
  const gateway: ChatGateway = {
    answer: answerFor,
    async *streamAnswer() {
      yield await answerFor();
    },
  };
  return { gateway, release: () => release() };
};

const LATER_ANSWER = "La domenica siamo chiusi.";

const call = async (chatGateway: ChatGateway = answeringModel) => {
  const logger = createLogger("silent");
  const info = vi.spyOn(logger, "info");
  const { app, dependencies } = createTestApp({
    chatGateway,
    logger,
    turnPlanCoordinator: new TurnPlanCoordinator(new TurnPlanService(plannerInItalian)),
  });
  const session = await issueTestSession(app, `voice-switch-${randomUUID()}@example.com`);
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

  /** One streamed request as ElevenLabs sends it, for a session the page started in English. */
  const runtimeSends = async (messages: unknown[]) => {
    const response = await request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({ messages, stream: true, tools: [languageDetectionTool], elevenlabs_extra_body: { session_key: sessionKey, locale: "en" } })
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => done(null, body));
      })
      .expect(200);
    return framesOf(response.body as string);
  };
  const conversationMessages = async () => {
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const id = (history.body.conversations as Array<{ id: string; channelContext?: { sessionKey?: string } | null }>)
      .find((item) => item.channelContext?.sessionKey === sessionKey)!.id;
    return ((await request(app).get(`/api/v1/history/chat/${id}`).set(dashboard).expect(200)).body as { messages: Array<{ role: string; content: string }> }).messages;
  };
  const turnLogs = () => info.mock.calls
    .filter(([, message]) => message === "Voice turn finished")
    .map(([fields]) => fields as Record<string, unknown>);
  return { runtimeSends, conversationMessages, turnLogs, chatTurnCount: () => chatTurns.mock.calls.length, info };
};

const opening = [
  { role: "system", content: "You are the booking line." },
  { role: "user", content: UTTERANCE },
];

/** The follow-up ElevenLabs sends once it ran the switch: the call replayed under `fc_<id>`, then its result. */
const followUpAfter = (switchId: string, result: string) => [
  ...opening,
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `fc_${switchId}`, type: "function", function: { name: "language_detection", arguments: JSON.stringify({ reason: "response_language", language: "it" }) } }],
  },
  { role: "tool", tool_call_id: `fc_${switchId}`, content: result },
];

describe("a call whose caller changes language, on an agent that switches with them", () => {
  it("asks ElevenLabs to switch with the tool call alone, then speaks the answer on its follow-up, and stores the exchange once", async () => {
    const voiceCall = await call();

    const switching = await voiceCall.runtimeSends(opening);

    expect(switching.at(-1)).toBe("[DONE]");
    const [toolCallFrame, closingFrame] = switching as Frame[];
    expect(switching).toHaveLength(3);
    const toolCall = toolCallFrame?.choices[0]?.delta.tool_calls?.[0];
    expect(toolCall).toMatchObject({ type: "function", function: { name: "language_detection" } });
    expect(JSON.parse(toolCall!.function.arguments)).toEqual({ reason: "response_language", language: "it" });
    expect(toolCallFrame?.choices[0]?.delta).not.toHaveProperty("content");
    expect(closingFrame?.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "tool_calls" });

    const answered = await voiceCall.runtimeSends(followUpAfter(toolCall!.id, JSON.stringify({
      result_type: "language_detection_success",
      status: "success",
      reason: "response_language",
      language: "it",
    })));

    expect(answered.at(-1)).toBe("[DONE]");
    expect(spokenOf(answered)).toContain(ANSWER);
    expect(JSON.stringify(answered)).not.toContain("tool_calls");
    // One chat turn answered the utterance; the conversation keeps its user message and answer once.
    expect(voiceCall.chatTurnCount()).toBe(1);
    expect((await voiceCall.conversationMessages()).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: UTTERANCE },
      { role: "assistant", content: ANSWER },
    ]);
    await vi.waitFor(() => expect(voiceCall.turnLogs()).toHaveLength(2));
    expect(voiceCall.turnLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ languageSwitch: "emitted", speechPieceCount: 0, result: "completed" }),
      expect.objectContaining({ languageSwitch: "confirmed", reportedTurnLanguage: "it", result: "completed" }),
    ]));
  });

  it("speaks the answer anyway when ElevenLabs refuses the language, and logs the refusal", async () => {
    const voiceCall = await call();

    const switching = await voiceCall.runtimeSends(opening);
    const switchId = (switching[0] as Frame).choices[0]?.delta.tool_calls?.[0]?.id ?? "";
    const answered = await voiceCall.runtimeSends(followUpAfter(switchId, "Invalid language. Keep speaking English."));

    expect(spokenOf(answered)).toContain(ANSWER);
    expect(voiceCall.chatTurnCount()).toBe(1);
    await vi.waitFor(() => expect(voiceCall.turnLogs()).toHaveLength(2));
    expect(voiceCall.turnLogs()).toContainEqual(expect.objectContaining({ languageSwitch: "refused", languageReport: "blocked" }));
  });

  it("stores no answer for a switched turn the caller talked over while it was still writing, and answers the newer utterance", async () => {
    const model = modelHeldOnce();
    const voiceCall = await call(model.gateway);

    const switching = await voiceCall.runtimeSends(opening);
    const switchId = (switching[0] as Frame).choices[0]?.delta.tool_calls?.[0]?.id ?? "";
    // The caller speaks again before the follow-up comes: ElevenLabs sends the new utterance with
    // the switch it ran in the history.
    const newer = voiceCall.runtimeSends([
      ...followUpAfter(switchId, JSON.stringify({ result_type: "language_detection_success", status: "success", reason: "response_language", language: "it" })),
      { role: "user", content: "E la domenica?" },
    ]);
    setTimeout(() => model.release(), 200);
    const answered = await newer;

    // The call is Italian now, so the newer turn answers without another switch.
    expect(JSON.stringify(answered)).not.toContain("tool_calls");
    expect(spokenOf(answered)).toContain(LATER_ANSWER);
    // The newer utterance cancelled the switched turn before it replied: it keeps neither its
    // user message nor an answer, and the newer turn's exchange is the conversation's.
    expect((await voiceCall.conversationMessages()).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "E la domenica?" },
      { role: "assistant", content: LATER_ANSWER },
    ]);
    await vi.waitFor(() => expect(voiceCall.info).toHaveBeenCalledWith(
      expect.objectContaining({ languageSwitch: "unanswered" }),
      "Voice language switch was not followed up",
    ));
  });
});
