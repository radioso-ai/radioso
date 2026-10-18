import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatStreamEvent, DeliveredReplyPart } from "../../src/modules/chat/contracts/index.js";
import {
  defaultAgentVoiceSettings,
  type AgentVoiceSettings,
} from "../../src/modules/agents/public.js";
import { VoiceTurnIncompleteError, type VoiceTurnEvent, type VoiceTurnInput } from "../../src/modules/voiceChannel/domain.js";
import {
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceSessionStore,
} from "../../src/modules/voiceChannel/services/voiceTurnService.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const conversationId = "55555555-5555-4555-8555-555555555555";

const input = (overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput => ({
  session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey: "conv_abc" },
  transport: "web",
  utterance: "When do you open?",
  streamsSpeech: true,
  ...overrides,
});

const done = (id = conversationId): ChatStreamEvent => ({
  type: "done",
  conversationId: id,
  assistantMessageId: "66666666-6666-4666-8666-666666666666",
  answer: "We open at nine. See you!",
  activitySummary: { stages: [] },
  activityTrace: { events: [] },
  route: { type: "direct", reason: "social_only" },
} as unknown as ChatStreamEvent);

interface FakeChat {
  requests: VoiceChatTurnRequest[];
  returned: () => boolean;
  streamTurn: (request: VoiceChatTurnRequest) => AsyncIterable<ChatStreamEvent>;
}

const fakeChat = (events: ChatStreamEvent[]): FakeChat => {
  const requests: VoiceChatTurnRequest[] = [];
  let finished = false;
  let exhausted = false;
  return {
    requests,
    returned: () => finished && !exhausted,
    streamTurn: (request) => {
      requests.push(request);
      return (async function* () {
        try {
          for (const event of events) yield event;
          exhausted = true;
        } finally {
          finished = true;
        }
      })();
    },
  };
};

const fakeSessions = (existing: string | null, boundTo?: string): VoiceSessionStore & {
  findConversationId: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
} => ({
  findConversationId: vi.fn().mockResolvedValue(existing),
  bind: vi.fn().mockImplementation(async (_ref, id: string) => boundTo ?? id),
});

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

const voiceProfiles = (voice: AgentVoiceSettings, defaultLocale: string | null = null) => ({
  findVoiceProfile: vi.fn().mockResolvedValue({ voice, defaultLocale }),
});

const routineStates = (active: boolean) => ({ isRoutineActive: vi.fn().mockResolvedValue(active) });

const conversationOwnership = (humanOwned: boolean) => ({ isHumanOwned: vi.fn().mockResolvedValue(humanOwned) });

/** Chat's teammate replies on a conversation that holds none for the caller. */
const noOperatorReplies = () => ({
  claims: {
    claimPendingOperatorReplies: vi.fn(async () => []),
    markOperatorRepliesSpoken: vi.fn(async () => []),
    skipOperatorReplies: vi.fn(async () => []),
    releaseOperatorReplies: vi.fn(async () => []),
  },
  newClaimTurnId: () => "turn-0",
});

/** The agent has voice turned off, so turns run as plain chat turns. */
const voiceOff = {
  agents: voiceProfiles(defaultAgentVoiceSettings()),
  routines: routineStates(false),
  ownership: conversationOwnership(false),
  operatorReplies: noOperatorReplies(),
};

const collect = async (events: AsyncIterable<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> => {
  const collected: VoiceTurnEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

/** Everything the caller heard of the reply, joined. */
const spokenText = (events: VoiceTurnEvent[]): string =>
  events.flatMap((event) => (event.type === "speech" ? [event.text] : [])).join("");

/** Chat's answer on a turn that found the conversation already in a person's hands. */
const waitingDone = (waiting: string): ChatStreamEvent => ({
  ...done(),
  assistantMessageId: "",
  answer: waiting,
  ownership: { state: "human_owned", suppressed: true },
} as ChatStreamEvent);

describe("VoiceTurnService", () => {
  it("starts a conversation for a new session, binds it, and speaks the reply sentence by sentence", async () => {
    const chat = fakeChat([
      { type: "status", stage: "interpreting" },
      { type: "conversation", conversationId },
      { type: "chunk", text: "We open at" },
      { type: "chunk", text: " nine. See" },
      { type: "chunk", text: " you!" },
      done(),
    ]);
    const sessions = fakeSessions(null);
    const service = new VoiceTurnService({ ...voiceOff, sessions, chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events).toEqual([
      { type: "conversation", conversationId },
      { type: "speech", text: "We open at nine. ", last: false },
      { type: "speech", text: "See you!", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ]);
    expect(sessions.bind).toHaveBeenCalledWith(input().session, conversationId);
    expect(chat.requests).toEqual([{
      workspaceId,
      agentId,
      message: "When do you open?",
      sourceChannel: "voice",
      channelContext: { provider: "voice", vendor: "elevenlabs", sessionKey: "conv_abc", transport: "web" },
      supersession: "latest_input_wins",
      deliveredReply: expect.any(Function),
      signal: expect.any(AbortSignal),
    }]);
    expect(chat.requests[0]).not.toHaveProperty("conversationId");
  });

  it("hands chat the language the request reports as new on the turn, and logs it, with voice off too", async () => {
    const chat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Sì." }, done()]);
    const logger = fakeLogger();
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger });

    await collect(service.runTurn(
      input({ utterance: "Siete aperti?", locale: "en", turnLanguage: { tag: "it", source: "vendor_detected", isNew: true } }),
      new AbortController().signal,
    ));

    expect(chat.requests[0]).toMatchObject({ userExpectedLocale: "it" });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ reportedTurnLanguage: "it" }), "Voice turn finished");
    // No lines were picked with voice off, so no language of theirs is named.
    expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("turnLanguage");
    expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("languageSource");
  });

  it("gives chat no hint for a switch an earlier turn made, so a caller who moved on is answered in what they speak", async () => {
    const chat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Yes." }, done()]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });

    await collect(service.runTurn(
      input({ utterance: "Sorry, are you open?", locale: "en", turnLanguage: { tag: "it", source: "vendor_detected", isNew: false } }),
      new AbortController().signal,
    ));

    expect(chat.requests[0]).not.toHaveProperty("userExpectedLocale");
  });

  it("names a newest language switch it could not take on the turn's log, and nothing of it", async () => {
    const logger = fakeLogger();
    const service = new VoiceTurnService({
      ...voiceOff,
      sessions: fakeSessions(conversationId),
      chat: fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Yes." }, done()]),
      logger,
    });

    await collect(service.runTurn(input({ locale: "en", languageReport: "unreadable" }), new AbortController().signal));

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ languageReport: "unreadable" }), "Voice turn finished");
    expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("turnLanguage");
    expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("reportedTurnLanguage");
  });

  it("continues the bound conversation of a known session and names it before the turn runs", async () => {
    const chat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Yes." }, done()]);
    const sessions = fakeSessions(conversationId);
    const service = new VoiceTurnService({ ...voiceOff, sessions, chat, logger: fakeLogger() });

    const iterator = service.runTurn(input(), new AbortController().signal)[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value).toEqual({ type: "conversation", conversationId });
    expect(chat.requests).toHaveLength(0);

    const rest: VoiceTurnEvent[] = [];
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) rest.push(step.value);

    expect(rest).toEqual([
      { type: "speech", text: "Yes.", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ]);
    expect(chat.requests[0]).toMatchObject({ conversationId });
    expect(sessions.findConversationId).toHaveBeenCalledWith(input().session);
    expect(sessions.bind).not.toHaveBeenCalled();
  });

  it("joins the website visitor who started the session on its first turn, and reads the start no more once bound", async () => {
    const visitor = { publicSessionId: "77777777-7777-4777-8777-777777777777", visitorKey: "88888888-8888-4888-8888-888888888888" };
    const starts = { findStartedVisitor: vi.fn().mockResolvedValue(visitor) };
    const firstChat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Hi." }, done()]);
    const first = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(null), chat: firstChat, starts, logger: fakeLogger() });

    await collect(first.runTurn(input(), new AbortController().signal));

    expect(starts.findStartedVisitor).toHaveBeenCalledWith(input().session);
    expect(firstChat.requests[0]).toMatchObject({ visitorKey: visitor.visitorKey });
    expect(firstChat.requests[0]).not.toHaveProperty("conversationId");

    const laterChat = fakeChat([{ type: "chunk", text: "Yes." }, done()]);
    const later = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat: laterChat, starts, logger: fakeLogger() });
    await collect(later.runTurn(input(), new AbortController().signal));

    expect(starts.findStartedVisitor).toHaveBeenCalledTimes(1);
    expect(laterChat.requests[0]).not.toHaveProperty("visitorKey");
  });

  it("groups a started session's visitor by the public session when the page sent no visitor key, as the embed's chat does", async () => {
    const starts = { findStartedVisitor: vi.fn().mockResolvedValue({ publicSessionId: "77777777-7777-4777-8777-777777777777", visitorKey: null }) };
    const chat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Hi." }, done()]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(null), chat, starts, logger: fakeLogger() });

    await collect(service.runTurn(input(), new AbortController().signal));

    expect(chat.requests[0]).toMatchObject({ visitorKey: "77777777-7777-4777-8777-777777777777" });
  });

  it("runs a first turn whose page minted its own key, or whose start cannot be read, with no visitor", async () => {
    const unread = { findStartedVisitor: vi.fn().mockRejectedValue(new Error("connection terminated")) };
    const logger = fakeLogger();
    const chat = fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "Hi." }, done()]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(null), chat, starts: unread, logger });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
    expect(chat.requests[0]).not.toHaveProperty("visitorKey");
    expect(logger.warn).toHaveBeenCalledWith(
      { agentId, vendor: "elevenlabs", errorClass: "Error" },
      "Voice session start could not be read; the turn runs without its visitor",
    );
  });

  it("speaks a reply whose citation markers leaked without them, even split across chunks", async () => {
    const chat = fakeChat([
      { type: "conversation", conversationId },
      { type: "chunk", text: "I can't confirm the cost from this information.[" },
      { type: "chunk", text: "?] If you mean the monthly plan, ask me about that instead.[?]" },
      done(),
    ]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events.filter((event) => event.type === "speech")).toEqual([
      { type: "speech", text: "I can't confirm the cost from this information. ", last: false },
      { type: "speech", text: "If you mean the monthly plan, ask me about that instead.", last: true },
    ]);
  });

  it("closes an emphasis left open at the end of the reply once the reply is whole", async () => {
    const chat = fakeChat([
      { type: "conversation", conversationId },
      { type: "chunk", text: "È *davvero" },
      { type: "chunk", text: "*" },
      done(),
    ]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events.filter((event) => event.type === "speech")).toEqual([{ type: "speech", text: "È davvero", last: true }]);
  });

  it("hands the caller's abort signal to the chat turn", async () => {
    const chat = fakeChat([{ type: "conversation", conversationId }, done()]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });
    const abort = new AbortController();

    await collect(service.runTurn(input(), abort.signal));
    abort.abort();

    expect(chat.requests[0]?.signal).toBe(abort.signal);
    expect(chat.requests[0]?.signal.aborted).toBe(true);
  });

  it("ends the turn at done, closing the chat stream before its suggestion events", async () => {
    const chat = fakeChat([
      { type: "conversation", conversationId },
      { type: "chunk", text: "Done." },
      done(),
      { type: "suggestions", conversationId, suggestions: [] },
    ]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
    expect(events.filter((event) => event.type === "outcome")).toHaveLength(1);
    expect(chat.returned()).toBe(true);
  });

  it("closes a superseded turn with an outcome and leaves its unfinished sentence unspoken", async () => {
    const chat = fakeChat([
      { type: "conversation", conversationId },
      { type: "chunk", text: "Let me look that" },
      { type: "cancelled", conversationId, reason: "superseded", stage: "rendering" },
    ]);
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events).toEqual([
      { type: "conversation", conversationId },
      { type: "outcome", outcome: { kind: "continue" } },
    ]);
  });

  it("binds a human-owned first turn from the done event when no conversation event came first", async () => {
    const chat = fakeChat([done()]);
    const sessions = fakeSessions(null);
    const service = new VoiceTurnService({ ...voiceOff, sessions, chat, logger: fakeLogger() });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(sessions.bind).toHaveBeenCalledWith(input().session, conversationId);
    expect(events[0]).toEqual({ type: "conversation", conversationId });
  });

  it("warns when a concurrent first turn bound the session to another conversation", async () => {
    const otherConversationId = "77777777-7777-4777-8777-777777777777";
    const chat = fakeChat([{ type: "conversation", conversationId }, done()]);
    const logger = fakeLogger();
    const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(null, otherConversationId), chat, logger });

    const events = await collect(service.runTurn(input(), new AbortController().signal));

    expect(events[0]).toEqual({ type: "conversation", conversationId });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, vendor: "elevenlabs", conversationId, boundConversationId: otherConversationId }),
      expect.any(String),
    );
  });

  it("logs one completion record per turn without the utterance or the reply text", async () => {
    const chat = fakeChat([
      { type: "conversation", conversationId },
      { type: "chunk", text: "We open at nine. See you!" },
      done(),
    ]);
    const logger = fakeLogger();
    // The turn starts at 1,000 and everything after happens at 1,250.
    let clockReads = 0;
    const service = new VoiceTurnService({ ...voiceOff,
      sessions: fakeSessions(conversationId),
      chat,
      logger,
      now: () => (clockReads++ === 0 ? 1_000 : 1_250),
    });

    await collect(service.runTurn(input(), new AbortController().signal));

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields] = logger.info.mock.calls[0];
    expect(fields).toEqual({
      agentId,
      vendor: "elevenlabs",
      transport: "web",
      conversationId,
      result: "completed",
      durationMs: 250,
      speechPieceCount: 2,
      outcome: "continue",
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/open|nine/u);
  });

  it("records a failed turn at warn with the error class and rethrows the chat error", async () => {
    class ProviderDownError extends Error {}
    const logger = fakeLogger();
    const service = new VoiceTurnService({ ...voiceOff,
      sessions: fakeSessions(conversationId),
      chat: {
        streamTurn: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: "conversation", conversationId };
          throw new ProviderDownError("provider down: secret detail");
        })(),
      },
      logger,
    });

    await expect(collect(service.runTurn(input(), new AbortController().signal))).rejects.toThrow("provider down");
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({ result: "failed", conversationId, errorClass: "ProviderDownError" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret detail");
  });

  it.each([
    ["off", defaultAgentVoiceSettings()],
    ["on", { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: null }],
  ])("fails a turn whose chat stream ends without done or cancelled, with voice %s", async (_label, voice) => {
    const logger = fakeLogger();
    const service = new VoiceTurnService({ ...voiceOff,
      agents: voiceProfiles(voice),
      sessions: fakeSessions(conversationId),
      chat: fakeChat([{ type: "conversation", conversationId }, { type: "chunk", text: "We open at nine. See" }]),
      logger,
    });
    const events: VoiceTurnEvent[] = [];

    await expect((async () => {
      for await (const event of service.runTurn(input(), new AbortController().signal)) events.push(event);
    })()).rejects.toBeInstanceOf(VoiceTurnIncompleteError);
    // The sentence that was whole went out; the outcome never does.
    expect(events).toEqual([
      { type: "conversation", conversationId },
      { type: "speech", text: "We open at nine. ", last: false },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failed", conversationId, errorClass: "VoiceTurnIncompleteError" }),
      "Voice turn failed",
    );
  });

  describe("the outcome a turn ends with", () => {
    const fakeMetrics = () => ({ observeHistogram: vi.fn(), incrementCounter: vi.fn() });
    const outcomeLabels = (metrics: ReturnType<typeof fakeMetrics>) =>
      metrics.incrementCounter.mock.calls
        .filter(([name]) => name === "voice_turn_outcome_total")
        .map(([, options]) => (options as { labels: unknown }).labels);
    const reply = "Thanks, Ada. A teammate will call you back.";
    /** Chat's answer on a turn that handed the conversation to a person. */
    const handedOff = (handoff: { reason: "routine_handoff" | "routine_stuck" | "retrieval_miss"; collectedSlotCount: number }, answer = reply): ChatStreamEvent => ({
      ...done(),
      answer,
      ownership: { state: "human_owned", suppressed: false },
      handoff,
    } as ChatStreamEvent);
    const runOutcome = async (events: ChatStreamEvent[]) => {
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const service = new VoiceTurnService({ ...voiceOff, sessions: fakeSessions(conversationId), chat: fakeChat(events), logger, metrics });
      const turn = await collect(service.runTurn(input(), new AbortController().signal));
      return { turn, metrics, logger };
    };

    it.each(["routine_handoff", "routine_stuck"] as const)(
      "requests a callback when the turn's routine handed the caller to a person holding slot values (%s)",
      async (reason) => {
        const { turn, metrics, logger } = await runOutcome([
          { type: "conversation", conversationId },
          { type: "chunk", text: reply },
          handedOff({ reason, collectedSlotCount: 2 }),
        ]);

        expect(spokenText(turn)).toBe(reply);
        expect(turn.at(-1)).toEqual({ type: "outcome", outcome: { kind: "callback_requested", handoffReason: reason } });
        expect(outcomeLabels(metrics)).toEqual([{ kind: "callback_requested", handoff_reason: reason }]);
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ result: "completed", outcome: "callback_requested", handoffReason: reason }),
          "Voice turn finished",
        );
      },
    );

    it("continues when the hand-off held no slot value, and still records why the turn handed off", async () => {
      const { turn, metrics, logger } = await runOutcome([
        { type: "conversation", conversationId },
        { type: "chunk", text: "Let me find a teammate for this." },
        handedOff({ reason: "retrieval_miss", collectedSlotCount: 0 }, "Let me find a teammate for this."),
      ]);

      expect(turn.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
      expect(outcomeLabels(metrics)).toEqual([{ kind: "continue", handoff_reason: "retrieval_miss" }]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "continue", handoffReason: "retrieval_miss" }),
        "Voice turn finished",
      );
    });

    it("continues with chat's waiting message, word for word, when a person already owned the conversation", async () => {
      const waiting = "Thanks for waiting. A teammate has your message and will reply here.";
      const { turn, metrics, logger } = await runOutcome([
        { type: "status", stage: "interpreting" },
        { type: "status", stage: "composing" },
        { type: "chunk", text: waiting },
        waitingDone(waiting),
      ]);

      expect(spokenText(turn)).toBe(waiting);
      expect(turn.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
      expect(outcomeLabels(metrics)).toEqual([{ kind: "continue", handoff_reason: "none" }]);
      const [fields] = logger.info.mock.calls[0];
      expect(fields).toMatchObject({ outcome: "continue" });
      expect(fields).not.toHaveProperty("handoffReason");
    });

    it("continues a turn the agent answered and kept", async () => {
      const { turn, metrics } = await runOutcome([
        { type: "conversation", conversationId },
        { type: "chunk", text: "We open at nine." },
        done(),
      ]);

      expect(turn.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
      expect(outcomeLabels(metrics)).toEqual([{ kind: "continue", handoff_reason: "none" }]);
    });
  });

  describe("concurrent first turns of one session", () => {
    const firstConversationId = "88888888-8888-4888-8888-888888888888";

    const memorySessions = (): VoiceSessionStore & { bind: ReturnType<typeof vi.fn> } => {
      const bound = new Map<string, string>();
      return {
        findConversationId: async (session) => bound.get(session.sessionKey) ?? null,
        bind: vi.fn(async (session: VoiceTurnInput["session"], id: string) => {
          if (!bound.has(session.sessionKey)) bound.set(session.sessionKey, id);
          return bound.get(session.sessionKey) ?? id;
        }),
      };
    };

    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { opened, open };
    };

    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

    it("runs the second turn in the conversation the first one binds, once it is bound", async () => {
      const named = gate();
      const finished = gate();
      const requests: VoiceChatTurnRequest[] = [];
      const sessions = memorySessions();
      const service = new VoiceTurnService({ ...voiceOff,
        sessions,
        logger: fakeLogger(),
        chat: {
          streamTurn: (request) => {
            requests.push(request);
            const isFirst = requests.length === 1;
            return (async function* (): AsyncGenerator<ChatStreamEvent> {
              if (isFirst) {
                await named.opened;
                yield { type: "conversation", conversationId: firstConversationId };
                await finished.opened;
                yield done(firstConversationId);
                return;
              }
              yield { type: "conversation", conversationId: request.conversationId ?? "unexpected" };
              yield done(request.conversationId ?? "unexpected");
            })();
          },
        },
      });

      const first = collect(service.runTurn(input(), new AbortController().signal));
      // The first turn's chat turn is running when the second request arrives.
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const second = collect(service.runTurn(input(), new AbortController().signal));
      await tick();
      expect(requests).toHaveLength(1);
      named.open();
      // The second turn waits only for the binding, not for the first reply.
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      finished.open();
      await Promise.all([first, second]);

      expect(requests[0]).not.toHaveProperty("conversationId");
      expect(requests[1]).toMatchObject({ conversationId: firstConversationId });
      expect(sessions.bind).toHaveBeenCalledTimes(1);
    });

    it("lets a waiting turn start the conversation when the first one fails before naming it", async () => {
      const failure = gate();
      const requests: VoiceChatTurnRequest[] = [];
      const service = new VoiceTurnService({ ...voiceOff,
        sessions: memorySessions(),
        logger: fakeLogger(),
        chat: {
          streamTurn: (request) => {
            requests.push(request);
            const isFirst = requests.length === 1;
            return (async function* (): AsyncGenerator<ChatStreamEvent> {
              if (isFirst) {
                await failure.opened;
                throw new Error("prepare failed");
              }
              yield { type: "conversation", conversationId };
              yield done();
            })();
          },
        },
      });

      const first = collect(service.runTurn(input(), new AbortController().signal));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const second = collect(service.runTurn(input(), new AbortController().signal));
      failure.open();

      await expect(first).rejects.toThrow("prepare failed");
      await expect(second).resolves.toContainEqual({ type: "conversation", conversationId });
      expect(requests[1]).not.toHaveProperty("conversationId");
    });
  });
  describe("with the agent's voice settings", () => {
    const voiceOn: AgentVoiceSettings = {
      enabled: true,
      bridgeLines: {
        en: { acknowledge: ["Got it."], check: ["Let me check."] },
        it: { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
      },
      fallbackLine: { en: "Sorry, could you ask me again?" },
      runtime: null,
    };

    /** A chat turn whose events arrive at the given times on the fake clock. */
    const timedChat = (steps: Array<{ atMs: number; event: ChatStreamEvent }>) => {
      const requests: VoiceChatTurnRequest[] = [];
      let yielded = 0;
      return {
        requests,
        /** How many of the steps the turn pulled. */
        yielded: () => yielded,
        streamTurn: (request: VoiceChatTurnRequest) => {
          requests.push(request);
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            const startedAt = Date.now();
            for (const step of steps) {
              const wait = startedAt + step.atMs - Date.now();
              if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
              yielded += 1;
              yield step.event;
            }
          })();
        },
      };
    };

    const slowReply = (atMs: number) => [
      { atMs: 0, event: { type: "conversation", conversationId } as ChatStreamEvent },
      { atMs, event: { type: "chunk", text: "We open at nine." } as ChatStreamEvent },
      { atMs, event: done() },
    ];

    const fakeMetrics = () => ({ observeHistogram: vi.fn(), incrementCounter: vi.fn() });

    const runWithClock = async (service: VoiceTurnService, turn: VoiceTurnInput = input()) => {
      const collected = collect(service.runTurn(turn, new AbortController().signal));
      await vi.runAllTimersAsync();
      return collected;
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("bridges when chat reports a search, and lets a quick composed reply through without one", async () => {
      const turn = (steps: Array<{ atMs: number; event: ChatStreamEvent }>) => new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(steps),
        logger: fakeLogger(),
      });
      const status = (stage: "interpreting" | "searching" | "composing"): ChatStreamEvent => ({ type: "status", stage });

      const retrieval = await runWithClock(turn([
        { atMs: 0, event: status("interpreting") },
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 1_100, event: status("searching") },
        { atMs: 3_000, event: { type: "chunk", text: "We open at nine." } },
        { atMs: 3_000, event: done() },
      ]));
      const quick = await runWithClock(turn([
        { atMs: 0, event: status("interpreting") },
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 1_100, event: status("composing") },
        { atMs: 1_150, event: { type: "chunk", text: "Hi!" } },
        { atMs: 1_150, event: done() },
      ]));

      expect(retrieval.map((event) => event.type)).toEqual(["conversation", "bridge", "speech", "outcome"]);
      expect(quick).toEqual([
        { type: "conversation", conversationId },
        { type: "speech", text: "Hi!", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
    });

    it("still speaks a bridge line shorter than the runtime speaks on its own, and warns once per agent", async () => {
      const logger = fakeLogger();
      const status = (stage: "searching"): ChatStreamEvent => ({ type: "status", stage });
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat([
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 100, event: status("searching") },
          { atMs: 2_000, event: { type: "chunk", text: "We open at nine." } },
          { atMs: 2_000, event: done() },
        ]),
        logger,
      });
      const turn = input({ minReleasableSentenceChars: 45 });

      const first = await runWithClock(service, turn);
      await runWithClock(service, turn);

      expect(first).toContainEqual({ type: "bridge", text: "Let me check." });
      const warnings = logger.warn.mock.calls.filter(([fields]) =>
        (fields as { event?: string }).event === "voice.bridge_line_below_vendor_minimum");
      expect(warnings).toEqual([[
        { event: "voice.bridge_line_below_vendor_minimum", agentId, vendor: "elevenlabs", lineCharacterCount: 13, minimumCharacterCount: 45 },
        "Voice bridge line is shorter than the runtime speaks on its own",
      ]]);
    });

    it("runs the turn without a bridge or a limit while voice is off", async () => {
      const agents = voiceProfiles({ ...voiceOn, enabled: false });
      const service = new VoiceTurnService({
        agents,
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(11_000)),
        logger: fakeLogger(),
      });

      const events = await runWithClock(service);

      expect(events).toEqual([
        { type: "conversation", conversationId },
        { type: "speech", text: "We open at nine.", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect(agents.findVoiceProfile).toHaveBeenCalledWith(input().session);
    });

    it("acknowledges while a routine is active in the session's conversation", async () => {
      const routines = routineStates(true);
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines,
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(3_000)),
        logger: fakeLogger(),
      });

      const events = await runWithClock(service);

      expect(events).toEqual([
        { type: "conversation", conversationId },
        { type: "bridge", text: "Got it." },
        { type: "speech", text: "We open at nine.", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect(routines.isRoutineActive).toHaveBeenCalledWith(conversationId);
    });

    it("checks on a session's first turn, which has no routine to read", async () => {
      const routines = routineStates(true);
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines,
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(null),
        chat: timedChat(slowReply(3_000)),
        logger: fakeLogger(),
      });

      const events = await runWithClock(service);

      expect(events).toContainEqual({ type: "bridge", text: "Let me check." });
      expect(routines.isRoutineActive).not.toHaveBeenCalled();
    });

    it("speaks in the session's locale ahead of the agent's default, and leaves chat to read the caller's language itself", async () => {
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const chat = timedChat(slowReply(3_000));
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger,
        metrics,
      });

      const events = await runWithClock(service, input({ locale: "it-IT" }));

      expect(events).toContainEqual({ type: "bridge", text: "Controllo subito." });
      // A session's locale says how the call started, not what the caller speaks now.
      expect(chat.requests[0]).not.toHaveProperty("userExpectedLocale");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ turnLanguage: "it-IT", languageSource: "session" }),
        "Voice turn finished",
      );
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_turn_language_source_total", expect.objectContaining({
        labels: { source: "session" },
      }));
    });

    it("speaks a turn the vendor switched to Italian in Italian on an English agent whose call started in English, and tells chat", async () => {
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const chat = timedChat(slowReply(12_000));
      const service = new VoiceTurnService({
        agents: voiceProfiles({ ...voiceOn, fallbackLine: { ...voiceOn.fallbackLine, it: "Scusa, puoi ripetere la domanda?" } }, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger,
        metrics,
      });

      const events = await runWithClock(service, input({
        utterance: "Vorrei prenotare un tavolo",
        locale: "en",
        turnLanguage: { tag: "it", source: "vendor_detected", isNew: true },
      }));

      expect(events.slice(1)).toEqual([
        { type: "bridge", text: "Controllo subito." },
        { type: "speech", text: "Scusa, puoi ripetere la domanda?", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect(chat.requests[0]).toMatchObject({ userExpectedLocale: "it" });
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_turn_language_source_total", expect.objectContaining({
        labels: { source: "vendor_detected" },
      }));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ turnLanguage: "it", languageSource: "vendor_detected", reportedTurnLanguage: "it" }),
        "Voice turn reached the turn limit",
      );
      // The tag is in the log only; no metric label carries it.
      expect(JSON.stringify(metrics.incrementCounter.mock.calls)).not.toContain('"it"');
    });

    it("keeps the lines in the language of a switch an earlier turn made", async () => {
      const chat = timedChat(slowReply(3_000));
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger: fakeLogger(),
      });

      const events = await runWithClock(service, input({ locale: "en", turnLanguage: { tag: "it", source: "vendor_detected", isNew: false } }));

      expect(events).toContainEqual({ type: "bridge", text: "Controllo subito." });
      expect(chat.requests[0]).not.toHaveProperty("userExpectedLocale");
    });

    it("speaks no bridge for a reported language without lines, and the session's fallback line at the limit", async () => {
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(12_000)),
        logger,
        metrics,
      });

      const events = await runWithClock(service, input({
        utterance: "Ich möchte einen Tisch reservieren",
        locale: "en",
        turnLanguage: { tag: "de", source: "vendor_detected", isNew: true },
      }));

      expect(events.slice(1)).toEqual([
        { type: "speech", text: "Sorry, could you ask me again?", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_bridge_emitted_total", expect.objectContaining({
        labels: { style: "check", locale_resolved: "no" },
      }));
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_turn_limit_total", expect.objectContaining({
        labels: { locale_resolved: "yes" },
      }));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ turnLanguage: "de", languageSource: "vendor_detected", fallbackSpoken: true }),
        "Voice turn reached the turn limit",
      );
    });

    it("measures the turn and logs whether the bridge and the limit fired, with bounded labels only", async () => {
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const chat = timedChat(slowReply(12_000));
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger,
        metrics,
      });

      const events = await runWithClock(service);

      expect(events.slice(1)).toEqual([
        { type: "bridge", text: "Let me check." },
        { type: "speech", text: "Sorry, could you ask me again?", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      // The reply behind the fallback line still ran to `done`, so it is stored.
      expect(chat.yielded()).toBe(3);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_bridge_emitted_total", expect.objectContaining({
        labels: { style: "check", locale_resolved: "yes" },
      }));
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_turn_limit_total", expect.objectContaining({
        labels: { locale_resolved: "yes" },
      }));
      expect(metrics.observeHistogram).toHaveBeenCalledWith("voice_turn_first_speech_ms", expect.objectContaining({
        labels: { bridged: "yes" },
        value: 10_000,
      }));
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ result: "completed", bridged: true, turnLimitReached: true, fallbackSpoken: true }),
        "Voice turn reached the turn limit",
      );
      expect(JSON.stringify([metrics.incrementCounter.mock.calls, metrics.observeHistogram.mock.calls])).not.toMatch(
        /check\.|again|nine|5555/u,
      );
    });

    it("logs a turn limit at warn even when there was no fallback line to speak", async () => {
      const logger = fakeLogger();
      const service = new VoiceTurnService({
        agents: voiceProfiles({ ...voiceOn, fallbackLine: {} }),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(11_000)),
        logger,
      });

      const events = await runWithClock(service);

      expect(events.at(-2)).toEqual({ type: "speech", text: "We open at nine.", last: true });
      expect(logger.warn).toHaveBeenCalledWith(
        { agentId, vendor: "elevenlabs", transport: "web", conversationId, result: "completed", durationMs: 11_000,
          speechPieceCount: 1, outcome: "continue", bridged: true, turnLimitReached: true, fallbackSpoken: false,
          turnLanguage: "en", languageSource: "builtin_default" },
        "Voice turn reached the turn limit",
      );
    });

    it("speaks neither a bridge before chat's waiting message nor a fallback line over it on a turn a person owns", async () => {
      const waiting = "Thanks for waiting. A teammate has your message.";
      const ownership = conversationOwnership(true);
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership,
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat([
          { atMs: 0, event: { type: "status", stage: "interpreting" } },
          { atMs: 0, event: { type: "status", stage: "composing" } },
          { atMs: 11_000, event: { type: "chunk", text: waiting } },
          { atMs: 11_000, event: waitingDone(waiting) },
        ]),
        logger,
        metrics,
      });

      const events = await runWithClock(service);

      expect(events.map((event) => event.type)).not.toContain("bridge");
      expect(spokenText(events)).not.toContain("Sorry, could you ask me again?");
      expect(spokenText(events)).toBe(waiting);
      expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
      expect(ownership.isHumanOwned).toHaveBeenCalledWith(conversationId);
      expect(metrics.incrementCounter).not.toHaveBeenCalledWith("voice_bridge_emitted_total", expect.anything());
      expect(metrics.incrementCounter).not.toHaveBeenCalledWith("voice_turn_limit_total", expect.anything());
      // No line was chosen for the turn, so no language is counted for it.
      expect(metrics.incrementCounter).not.toHaveBeenCalledWith("voice_turn_language_source_total", expect.anything());
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ bridged: false, turnLimitReached: false, fallbackSpoken: false }),
        "Voice turn finished",
      );
    });

    it("counts a bridge the agent has no line for as unresolved and speaks nothing", async () => {
      const metrics = fakeMetrics();
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "de"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(3_000)),
        logger: fakeLogger(),
        metrics,
      });

      const events = await runWithClock(service);

      expect(events.map((event) => event.type)).toEqual(["conversation", "speech", "outcome"]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_bridge_emitted_total", expect.objectContaining({
        labels: { style: "check", locale_resolved: "no" },
      }));
      expect(metrics.observeHistogram).toHaveBeenCalledWith("voice_turn_first_speech_ms", expect.objectContaining({
        labels: { bridged: "no" },
        value: 3_000,
      }));
    });
  });

  describe("when requests of one session overlap", () => {
    const voiceOn: AgentVoiceSettings = {
      enabled: true,
      bridgeLines: { en: { acknowledge: ["Got it."], check: ["Let me check that for you."] } },
      fallbackLine: { en: "Sorry, could you ask me again?" },
      runtime: null,
    };
    const assistantMessageId = "66666666-6666-4666-8666-666666666666";

    type Step = { atMs: number; event: ChatStreamEvent };

    /**
     * Chat as the turn registry runs it for `latest_input_wins` turns: a newer turn on the
     * conversation cancels the one in flight, which ends with `cancelled` at its next step. A turn
     * cut off after it emitted asks the channel what reached the caller and, when something did,
     * stores it as the turn's reply (`cut-<turn index>`).
     */
    const supersedingChat = (scripts: Step[][]) => {
      const requests: VoiceChatTurnRequest[] = [];
      const heardParts: Array<DeliveredReplyPart | null> = [];
      let newest = -1;
      return {
        requests,
        heardParts,
        streamTurn: (request: VoiceChatTurnRequest) => {
          requests.push(request);
          const index = requests.length - 1;
          newest = index;
          const steps = scripts[index] ?? [];
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            const startedAt = Date.now();
            let emitted = false;
            for (const step of steps) {
              const wait = startedAt + step.atMs - Date.now();
              if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
              if (newest !== index) {
                const heard = emitted ? request.deliveredReply() : null;
                if (emitted) heardParts.push(heard);
                yield { type: "cancelled", conversationId, reason: "superseded", stage: "rendering", ...(heard ? { storedReply: { assistantMessageId: `cut-${index}`, partial: true } } : {}) };
                return;
              }
              emitted ||= step.event.type === "chunk";
              yield step.event;
            }
          })();
        },
      };
    };

    const answered = (text: string, atMs = 300): Step[] => [
      { atMs: 0, event: { type: "conversation", conversationId } },
      { atMs, event: { type: "chunk", text } },
      { atMs, event: { ...done(), answer: text } as ChatStreamEvent },
    ];

    const fakeNotes = () => ({
      replyInterrupted: vi.fn().mockResolvedValue(undefined),
      replyReplayed: vi.fn().mockResolvedValue(undefined),
      operatorRepliesSpoken: vi.fn().mockResolvedValue(undefined),
    });
    const fakeMetrics = () => ({ observeHistogram: vi.fn(), incrementCounter: vi.fn() });

    const service = (chat: { streamTurn: (request: VoiceChatTurnRequest) => AsyncIterable<ChatStreamEvent> }, overrides: Partial<ConstructorParameters<typeof VoiceTurnService>[0]> = {}) =>
      new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger: fakeLogger(),
        ...overrides,
      });

    /** Starts a turn now and collects its events as the fake clock runs. */
    const start = (turns: VoiceTurnService, turn: VoiceTurnInput = input(), hungUp?: AbortSignal) =>
      collect(turns.runTurn(turn, new AbortController().signal, hungUp));

    const counted = (metrics: ReturnType<typeof fakeMetrics>, name: string) =>
      metrics.incrementCounter.mock.calls.filter(([metric]) => metric === name).map(([, options]) => (options as { labels?: unknown }).labels ?? {});

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("lets only the newest of three requests 100 ms apart start a chat turn while the session is still being looked up", async () => {
      const chat = supersedingChat([answered("Hatha yoga is on Sundays at nine.")]);
      // Each request's session lookup takes 150 ms.
      const sessions: VoiceSessionStore = {
        findConversationId: () => new Promise<string>((resolve) => {
          setTimeout(() => resolve(conversationId), 150);
        }),
        bind: async (_session, id) => id,
      };
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const turns = service(chat, { sessions, metrics, logger });

      const first = start(turns, input({ utterance: "Do you have Hatha?" }));
      await vi.advanceTimersByTimeAsync(100);
      const second = start(turns, input({ utterance: "Do you have hatter?" }));
      await vi.advanceTimersByTimeAsync(100);
      const third = start(turns, input({ utterance: "Do you have Hatha yoga?" }));
      await vi.runAllTimersAsync();

      expect(await first).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
      expect(await second).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
      expect((await third).filter((event) => event.type === "speech")).toEqual([
        { type: "speech", text: "Hatha yoga is on Sundays at nine.", last: true },
      ]);
      expect(chat.requests.map((request) => request.message)).toEqual(["Do you have Hatha yoga?"]);
      expect(counted(metrics, "voice_turn_superseded_total")).toEqual([{ stage: "before_speech" }, { stage: "before_speech" }]);
      // Only the request whose turn ran chose lines.
      expect(counted(metrics, "voice_turn_language_source_total")).toEqual([{ source: "builtin_default" }]);
      const superseded = logger.info.mock.calls.filter(([fields]) => (fields as { result?: string }).result === "superseded");
      expect(superseded).toHaveLength(2);
      expect(superseded[0]?.[0]).toEqual({
        agentId, vendor: "elevenlabs", transport: "web", conversationId, result: "superseded",
        supersededAt: "before_speech", durationMs: 150, speechPieceCount: 0, outcome: "continue",
      });
    });

    it("lets the later request win when the earlier one's voice profile read finishes after it", async () => {
      const chat = supersedingChat([answered("Yes, on Sundays from ten.")]);
      // The first request's profile read resolves only once the second request's turn is in chat.
      let releaseFirstRead!: () => void;
      const firstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
      const agents = {
        findVoiceProfile: vi.fn(async () => {
          if (agents.findVoiceProfile.mock.calls.length === 1) await firstRead;
          return { voice: voiceOn, defaultLocale: null };
        }),
      };
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const turns = service(chat, { agents, metrics, logger });

      const first = start(turns, input({ utterance: "Are you open on Saturdays?", turnLanguage: { tag: "it", source: "turn_field", isNew: true } }));
      await vi.waitFor(() => expect(agents.findVoiceProfile).toHaveBeenCalledTimes(1));
      const second = start(turns, input({ utterance: "Are you open on Sundays?" }));
      await vi.waitFor(() => expect(chat.requests).toHaveLength(1));
      releaseFirstRead();
      await vi.runAllTimersAsync();

      expect(await first).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
      expect((await second).filter((event) => event.type === "speech")).toEqual([
        { type: "speech", text: "Yes, on Sundays from ten.", last: true },
      ]);
      expect(chat.requests.map((request) => request.message)).toEqual(["Are you open on Sundays?"]);
      // The first request chose its lines, then lost the session before it used them: its log names
      // the language it was told, and none it spoke in.
      expect(counted(metrics, "voice_turn_language_source_total")).toEqual([{ source: "builtin_default" }]);
      const logged = logger.info.mock.calls.map(([fields]) => fields as Record<string, unknown>);
      expect(logged.find((fields) => fields.result === "superseded")).toMatchObject({ reportedTurnLanguage: "it" });
      expect(logged.find((fields) => fields.result === "superseded")).not.toHaveProperty("turnLanguage");
      expect(logged.find((fields) => fields.result === "completed")).toMatchObject({ turnLanguage: "en", languageSource: "builtin_default" });
    });

    it("counts a turn cut off after it spoke as superseded after speech", async () => {
      const chat = supersedingChat([
        [
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 100, event: { type: "chunk", text: "We open at nine. See" } },
          { atMs: 2_000, event: { type: "chunk", text: " you then!" } },
        ],
        answered("Yes, on Sundays too."),
      ]);
      const metrics = fakeMetrics();
      const turns = service(chat, { metrics });

      const first = start(turns, input({ utterance: "When do you open?" }));
      await vi.advanceTimersByTimeAsync(500);
      const second = start(turns, input({ utterance: "And on Sundays?" }));
      await vi.runAllTimersAsync();

      expect(await first).toEqual([
        { type: "conversation", conversationId },
        { type: "speech", text: "We open at nine. ", last: false },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect((await second).filter((event) => event.type === "speech")).toEqual([
        { type: "speech", text: "Yes, on Sundays too.", last: true },
      ]);
      expect(counted(metrics, "voice_turn_superseded_total")).toEqual([{ stage: "after_speech" }]);
    });

    it("speaks no second bridge when the turn it superseded bridged moments ago", async () => {
      const searching = (atMs: number): Step => ({ atMs, event: { type: "status", stage: "searching" } });
      const chat = supersedingChat([
        [{ atMs: 0, event: { type: "conversation", conversationId } }, searching(50), { atMs: 3_000, event: { type: "chunk", text: "Stale." } }],
        [{ atMs: 0, event: { type: "conversation", conversationId } }, searching(50), ...answered("We open at nine.", 2_500).slice(1)],
      ]);
      const turns = service(chat);

      const first = start(turns, input({ utterance: "When do you open?" }));
      await vi.advanceTimersByTimeAsync(600);
      const second = start(turns, input({ utterance: "When do you open on Sunday?" }));
      await vi.runAllTimersAsync();

      expect(await first).toEqual([
        { type: "conversation", conversationId },
        { type: "bridge", text: "Let me check that for you." },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect((await second).map((event) => event.type)).toEqual(["conversation", "speech", "outcome"]);
    });

    it("bridges again once the superseded turn's bridge is older than the bridge delay", async () => {
      const searching = (atMs: number): Step => ({ atMs, event: { type: "status", stage: "searching" } });
      const chat = supersedingChat([
        [{ atMs: 0, event: { type: "conversation", conversationId } }, searching(50), { atMs: 5_000, event: { type: "chunk", text: "Stale." } }],
        [{ atMs: 0, event: { type: "conversation", conversationId } }, searching(50), ...answered("We open at nine.", 2_500).slice(1)],
      ]);
      const turns = service(chat);

      const first = start(turns, input({ utterance: "When do you open?" }));
      await vi.advanceTimersByTimeAsync(2_700);
      const second = start(turns, input({ utterance: "When do you open on Sunday?" }));
      await vi.runAllTimersAsync();
      await first;

      expect((await second).map((event) => event.type)).toEqual(["conversation", "bridge", "speech", "outcome"]);
    });

    describe("an identical re-request", () => {
      const utterance = "When do you open?";

      it("replays the stored answer after the runtime hung up, with no chat turn and no bridge", async () => {
        const chat = supersedingChat([[
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 0, event: { type: "status", stage: "searching" } },
          { atMs: 3_000, event: { type: "chunk", text: "We open at **nine**. See you!" } },
          { atMs: 3_000, event: { ...done(), answer: "We open at **nine**. See you!" } as ChatStreamEvent },
        ]]);
        const notes = fakeNotes();
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(chat, { notes, metrics, logger });
        const hangUp = new AbortController();

        const first = start(turns, input({ utterance }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(1_000);
        hangUp.abort();
        await vi.advanceTimersByTimeAsync(3_000);
        await first;
        const replayed = start(turns, input({ utterance: ` ${utterance}` }));
        await vi.runAllTimersAsync();

        expect(await replayed).toEqual([
          { type: "conversation", conversationId },
          { type: "speech", text: "We open at nine. ", last: false },
          { type: "speech", text: "See you!", last: true },
          { type: "outcome", outcome: { kind: "continue" } },
        ]);
        expect(chat.requests).toHaveLength(1);
        expect(notes.replyReplayed).toHaveBeenCalledWith({ workspaceId, conversationId, assistantMessageId });
        expect(counted(metrics, "voice_turn_replayed_total")).toEqual([{}]);
        expect(logger.info).toHaveBeenLastCalledWith(
          expect.objectContaining({ conversationId, result: "replayed", speechPieceCount: 2 }),
          "Voice turn finished",
        );
      });

      it("replays the stored answer when the hang-up and the outcome fall in the same millisecond", async () => {
        const chat = supersedingChat([answered("We open at nine.")]);
        // A frozen clock: the hang-up, the stored reply and its outcome all read the same instant.
        const turns = service(chat, { now: () => 5_000 });
        const hangUp = new AbortController();

        const first = start(turns, input({ utterance }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(100);
        hangUp.abort();
        await vi.runAllTimersAsync();
        await first;
        const replayed = start(turns, input({ utterance }));
        await vi.runAllTimersAsync();

        expect((await replayed).filter((event) => event.type === "speech")).toEqual([
          { type: "speech", text: "We open at nine.", last: true },
        ]);
        expect(chat.requests).toHaveLength(1);
      });

      const hungUpAnswer = async (turns: VoiceTurnService) => {
        const hangUp = new AbortController();
        const first = start(turns, input({ utterance }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(100);
        hangUp.abort();
        await vi.runAllTimersAsync();
        await first;
      };

      it("ends a replayed turn without waiting for its note, and writes the note after the outcome", async () => {
        const notes = fakeNotes();
        notes.replyReplayed.mockReturnValue(new Promise<void>(() => {}));
        const logger = fakeLogger();
        const turns = service(supersedingChat([answered("We open at nine.")]), { notes, logger });
        await hungUpAnswer(turns);
        const events: VoiceTurnEvent[] = [];

        for await (const event of turns.runTurn(input({ utterance }), new AbortController().signal)) {
          // The note is not written before the outcome has left.
          if (event.type === "outcome") expect(notes.replyReplayed).not.toHaveBeenCalled();
          events.push(event);
        }

        expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
        expect(notes.replyReplayed).toHaveBeenCalledWith({ workspaceId, conversationId, assistantMessageId });
        // The session settled the replay, whatever became of the note.
        expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ result: "replayed" }), "Voice turn finished");
      });

      it("warns when the replay's note fails, or does not finish within its time", async () => {
        const notes = fakeNotes();
        notes.replyReplayed.mockRejectedValueOnce(new Error("audit store unavailable"));
        notes.replyReplayed.mockReturnValueOnce(new Promise<void>(() => {}));
        const logger = fakeLogger();
        const turns = service(supersedingChat([answered("We open at nine."), answered("We open at nine.")]), { notes, logger });
        const noteWarnings = () => logger.warn.mock.calls
          .filter(([, message]) => message === "Voice turn note could not be recorded")
          .map(([fields]) => (fields as { errorClass?: string }).errorClass);

        await hungUpAnswer(turns);
        await start(turns, input({ utterance }));
        await vi.advanceTimersByTimeAsync(0);
        expect(noteWarnings()).toEqual(["Error"]);

        // The replay settled with its outcome delivered, so the next identical request runs a new turn.
        await hungUpAnswer(turns);
        await start(turns, input({ utterance }));
        await vi.advanceTimersByTimeAsync(4_999);
        expect(noteWarnings()).toEqual(["Error"]);
        await vi.advanceTimersByTimeAsync(1);
        expect(noteWarnings()).toEqual(["Error", "VoiceTurnNoteTimeoutError"]);
      });

      it("runs a new turn when the earlier reply reached the runtime whole", async () => {
        const chat = supersedingChat([answered("We open at nine."), answered("We open at nine, every day.")]);
        const turns = service(chat);

        await (async () => {
          const first = start(turns, input({ utterance }));
          await vi.runAllTimersAsync();
          await first;
        })();
        const second = start(turns, input({ utterance }));
        await vi.runAllTimersAsync();

        expect((await second).filter((event) => event.type === "speech")).toEqual([
          { type: "speech", text: "We open at nine, every day.", last: true },
        ]);
        expect(chat.requests).toHaveLength(2);
      });

      it("runs a new turn once the replay window has passed", async () => {
        const chat = supersedingChat([answered("We open at nine.", 1_000), answered("We open at nine, every day.")]);
        const turns = service(chat);
        const hangUp = new AbortController();

        const first = start(turns, input({ utterance }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(500);
        hangUp.abort();
        await vi.advanceTimersByTimeAsync(1_000);
        await first;
        await vi.advanceTimersByTimeAsync(30_500);
        const second = start(turns, input({ utterance }));
        await vi.runAllTimersAsync();
        await second;

        expect(chat.requests).toHaveLength(2);
      });

      it("runs a new turn, superseding the first, while no answer is stored yet", async () => {
        const chat = supersedingChat([
          [{ atMs: 0, event: { type: "conversation", conversationId } }, { atMs: 6_000, event: { type: "chunk", text: "Stale." } }],
          answered("We open at nine."),
        ]);
        const turns = service(chat);
        const hangUp = new AbortController();

        const first = start(turns, input({ utterance }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(4_000);
        hangUp.abort();
        const second = start(turns, input({ utterance }));
        await vi.runAllTimersAsync();

        expect((await first).at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
        expect((await second).filter((event) => event.type === "speech")).toEqual([
          { type: "speech", text: "We open at nine.", last: true },
        ]);
        expect(chat.requests).toHaveLength(2);
      });
    });

    describe("a reply the caller interrupted", () => {
      const reply = "We open at nine. See you then!";

      const answerOnce = async (turns: VoiceTurnService) => {
        const first = start(turns, input({ utterance: "When do you open?" }));
        await vi.runAllTimersAsync();
        return first;
      };

      it("records how much of the stored reply the caller heard, once, when the vendor replays it cut off", async () => {
        const chat = supersedingChat([answered(reply), answered("Yes."), answered("Sure.")]);
        const notes = fakeNotes();
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(chat, { notes, metrics, logger });

        await answerOnce(turns);
        const next = start(turns, input({ utterance: "Sorry, on Sundays?", heardUntil: "We open at nine.  \u200BSee" }));
        await vi.runAllTimersAsync();
        await next;
        const again = start(turns, input({ utterance: "Sundays?", heardUntil: "We open at nine.  \u200BSee" }));
        await vi.runAllTimersAsync();
        await again;

        expect(notes.replyInterrupted).toHaveBeenCalledTimes(1);
        expect(notes.replyInterrupted).toHaveBeenCalledWith({
          workspaceId, conversationId, assistantMessageId, heardCharacterCount: 20, spokenCharacterCount: 30,
        });
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{ partial: "no" }]);
        expect(logger.info).toHaveBeenCalledWith(
          { agentId, vendor: "elevenlabs", conversationId, assistantMessageId, heardCharacterCount: 20, spokenCharacterCount: 30, partial: false },
          "Voice reply was interrupted",
        );
        expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/nine|Sundays/u);
      });

      it("records the interruption on a later report when the first note could not be recorded", async () => {
        const heardUntil = "We open at nine.  \u200BSee";
        const chat = supersedingChat([
          answered(reply),
          // Replaced before it answers, so the session's last exchange stays the interrupted reply.
          [{ atMs: 0, event: { type: "conversation", conversationId } }, { atMs: 3_000, event: { type: "chunk", text: "Stale." } }],
          answered("Yes."),
        ]);
        const notes = fakeNotes();
        notes.replyInterrupted.mockRejectedValueOnce(new Error("audit store unavailable"));
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(chat, { notes, metrics, logger });

        await answerOnce(turns);
        const replaced = start(turns, input({ utterance: "Sorry, on Sundays?", heardUntil }));
        await vi.advanceTimersByTimeAsync(500);
        const next = start(turns, input({ utterance: "Sorry, are you open on Sundays?", heardUntil }));
        await vi.runAllTimersAsync();
        await Promise.all([replaced, next]);

        expect(notes.replyInterrupted).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId, errorClass: "Error" }),
          "Voice turn note could not be recorded",
        );
        // Counted and logged once, for the note that was recorded.
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{ partial: "no" }]);
        expect(logger.info.mock.calls.filter(([, message]) => message === "Voice reply was interrupted")).toHaveLength(1);
      });

      it("writes the interruption again on a later report when the first note does not finish within its time", async () => {
        const heardUntil = "We open at nine.  \u200BSee";
        const chat = supersedingChat([
          answered(reply),
          // Still composing past the note's time, then replaced, so the last exchange stays the interrupted reply.
          [{ atMs: 0, event: { type: "conversation", conversationId } }, { atMs: 9_000, event: { type: "chunk", text: "Stale." } }],
          answered("Yes."),
        ]);
        const notes = fakeNotes();
        notes.replyInterrupted.mockReturnValueOnce(new Promise<void>(() => {}));
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(chat, { notes, metrics, logger });

        await answerOnce(turns);
        const replaced = start(turns, input({ utterance: "Sorry, on Sundays?", heardUntil }));
        await vi.advanceTimersByTimeAsync(4_999);
        expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "Voice turn note could not be recorded");
        await vi.advanceTimersByTimeAsync(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId, errorClass: "VoiceTurnNoteTimeoutError" }),
          "Voice turn note could not be recorded",
        );
        const next = start(turns, input({ utterance: "Sorry, are you open on Sundays?", heardUntil }));
        await vi.runAllTimersAsync();
        await Promise.all([replaced, next]);

        expect(notes.replyInterrupted).toHaveBeenCalledTimes(2);
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{ partial: "no" }]);
      });

      it("counts only the reply's characters when a bridge line was spoken before it", async () => {
        const chat = supersedingChat([
          [
            { atMs: 0, event: { type: "conversation", conversationId } },
            { atMs: 0, event: { type: "status", stage: "searching" } },
            ...answered(reply, 2_000).slice(1),
          ],
          answered("Yes."),
        ]);
        const notes = fakeNotes();
        const turns = service(chat, { notes });

        await answerOnce(turns);
        const next = start(turns, input({ utterance: "Sundays?", heardUntil: "Let me check that for you. We open" }));
        await vi.runAllTimersAsync();
        await next;

        expect(notes.replyInterrupted).toHaveBeenCalledWith(expect.objectContaining({ heardCharacterCount: 7, spokenCharacterCount: 30 }));
      });

      it("records nothing when the reply ends in an ellipsis of its own and was heard whole", async () => {
        const chat = supersedingChat([answered("Let me think about that..."), answered("Yes.")]);
        const notes = fakeNotes();
        const turns = service(chat, { notes });

        await answerOnce(turns);
        const next = start(turns, input({ utterance: "Sure?", heardUntil: "Let me think about that" }));
        await vi.runAllTimersAsync();
        await next;

        expect(notes.replyInterrupted).not.toHaveBeenCalled();
      });

      it("records nothing when the replayed text is not a prefix of what was spoken", async () => {
        const chat = supersedingChat([answered(reply), answered("Yes.")]);
        const notes = fakeNotes();
        const turns = service(chat, { notes });

        await answerOnce(turns);
        const next = start(turns, input({ utterance: "Sundays?", heardUntil: "We close at" }));
        await vi.runAllTimersAsync();
        await next;

        expect(notes.replyInterrupted).not.toHaveBeenCalled();
      });
    });

    describe("a reply cut off while it was still speaking", () => {
      /** Four sentences, two by 200 ms and two at 2 s: a newer request at 500 ms cuts the reply after two. */
      const fourSentences: Step[] = [
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 100, event: { type: "chunk", text: "We open at **nine** on weekdays. " } },
        { atMs: 200, event: { type: "chunk", text: "Saturdays at ten [[1]]. Sun" } },
        { atMs: 2_000, event: { type: "chunk", text: "days we rest. Holidays vary." } },
        { atMs: 2_000, event: { ...done(), answer: "We open at **nine** on weekdays. Saturdays at ten. Sundays we rest. Holidays vary." } as ChatStreamEvent },
      ];
      const reachedSpeech = "We open at nine on weekdays. Saturdays at ten. ";

      /** The first request streams the four sentences; the second cuts in at 500 ms, reporting what the runtime played. */
      const cutAt500 = async (turns: VoiceTurnService, newer: Partial<VoiceTurnInput> = {}, first: Partial<VoiceTurnInput> = {}) => {
        const cut = start(turns, input({ utterance: "When do you open?", ...first }));
        await vi.advanceTimersByTimeAsync(500);
        const next = start(turns, input({ utterance: "And on Sundays?", ...newer }));
        await vi.runAllTimersAsync();
        return { cut: await cut, next: await next };
      };

      it("hands chat the sentences the runtime played whole, as written, with the characters heard and those that reached it", async () => {
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const notes = fakeNotes();
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(chat, { notes, metrics, logger });

        // ElevenLabs had played the first sentence and two words of the second when the caller spoke.
        const { cut, next } = await cutAt500(turns, { heardUntil: "We open at nine on weekdays.  \u200BSaturdays at" });

        expect(spokenText(cut)).toBe(reachedSpeech);
        expect(spokenText(next)).toBe("Yes, on Sundays too.");
        expect(chat.heardParts).toEqual([{
          text: "We open at **nine** on weekdays. ",
          heardCharacterCount: 41,
          spokenCharacterCount: 46,
          // Chat writes it with the stored part, adding the conversation's and the message's ids.
          auditEvent: { eventType: "voice.reply_interrupted", metadata: { heardCharacterCount: 41, spokenCharacterCount: 46, partial: true } },
        }]);
        // Stored with its audit event by chat, so no note is written, and it is counted as chat names it.
        expect(notes.replyInterrupted).not.toHaveBeenCalled();
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{ partial: "yes" }]);
        expect(logger.info).toHaveBeenCalledWith(
          { agentId, vendor: "elevenlabs", conversationId, assistantMessageId: "cut-0", heardCharacterCount: 41, spokenCharacterCount: 46, partial: true },
          "Voice reply was interrupted",
        );
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ result: "superseded", supersededAt: "after_speech", storedPartialReply: true }),
          "Voice turn finished",
        );
        expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/nine|Saturdays/u);
      });

      it("counts every sentence that reached the runtime as heard when the newer request reports nothing", async () => {
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const turns = service(chat, { notes: fakeNotes() });

        await cutAt500(turns);

        expect(chat.heardParts).toEqual([expect.objectContaining({ text: "We open at **nine** on weekdays. Saturdays at ten [[1]]. ", heardCharacterCount: 46, spokenCharacterCount: 46 })]);
      });

      it("falls back to what reached the runtime, and warns with counts only, when the report does not match it", async () => {
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const logger = fakeLogger();
        const turns = service(chat, { notes: fakeNotes(), logger });

        await cutAt500(turns, { heardUntil: "We close at" });

        expect(chat.heardParts).toEqual([expect.objectContaining({ heardCharacterCount: 46, spokenCharacterCount: 46 })]);
        expect(logger.warn).toHaveBeenCalledWith(
          { agentId, vendor: "elevenlabs", conversationId, reachedCharacterCount: 46, reportedCharacterCount: 11 },
          "Voice reply reported heard does not match what reached the runtime; the stored part follows what reached it",
        );
      });

      it("stores nothing when the caller heard no sentence of the reply whole, or none reached the runtime, a bridge line spoken or not", async () => {
        const heardHalf = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const notes = fakeNotes();
        await cutAt500(service(heardHalf, { notes }), { heardUntil: "We open at nine" });

        const beforeFirstSentence = supersedingChat([
          [
            { atMs: 0, event: { type: "conversation", conversationId } },
            { atMs: 0, event: { type: "status", stage: "searching" } },
            { atMs: 100, event: { type: "chunk", text: "We open at" } },
            { atMs: 2_000, event: { type: "chunk", text: " nine." } },
          ],
          answered("Yes, on Sundays too."),
        ]);
        const logger = fakeLogger();
        const { cut } = await cutAt500(service(beforeFirstSentence, { notes, logger }));

        expect(heardHalf.heardParts).toEqual([null]);
        expect(cut.map((event) => event.type)).toEqual(["conversation", "bridge", "outcome"]);
        expect(beforeFirstSentence.heardParts).toEqual([null]);
        expect(notes.replyInterrupted).not.toHaveBeenCalled();
        expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("storedPartialReply");
      });

      it("stores nothing for a response that is not streamed, which the runtime gets only at its outcome", async () => {
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const turns = service(chat, { notes: fakeNotes() });

        await cutAt500(turns, { streamsSpeech: false }, { streamsSpeech: false });

        expect(chat.heardParts).toEqual([null]);
      });

      it("hands chat only what reached the runtime before it hung up, when a newer request then cuts the reply off", async () => {
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const turns = service(chat, { notes: fakeNotes() });
        const hangUp = new AbortController();

        const first = start(turns, input({ utterance: "When do you open?" }), hangUp.signal);
        await vi.advanceTimersByTimeAsync(150);
        hangUp.abort();
        await vi.advanceTimersByTimeAsync(350);
        const second = start(turns, input({ utterance: "And on Sundays?" }));
        await vi.runAllTimersAsync();
        await Promise.all([first, second]);

        expect(chat.heardParts).toEqual([expect.objectContaining({ text: "We open at **nine** on weekdays. ", heardCharacterCount: 28, spokenCharacterCount: 28 })]);
      });

      it("applies the report to the reply the overtaken turn was saying, never to the stored reply before it", async () => {
        // The stored reply starts with the words the caller heard of the next one.
        const chat = supersedingChat([answered("We open at nine. See you then!"), fourSentences, answered("Yes, on Sundays too.")]);
        const notes = fakeNotes();
        const turns = service(chat, { notes });

        const stored = start(turns, input({ utterance: "Hello?" }));
        await vi.runAllTimersAsync();
        await stored;
        await cutAt500(turns, { heardUntil: "We open at nine" });

        expect(notes.replyInterrupted).not.toHaveBeenCalled();
        expect(chat.heardParts).toEqual([null]);
      });

      it("records nothing more when the vendor later reports the stored part cut short", async () => {
        // The second request cuts the reply off; a third replaces it before it answers, so the
        // session's last exchange stays the stored part.
        const chat = supersedingChat([
          fourSentences,
          [{ atMs: 0, event: { type: "conversation", conversationId } }, { atMs: 3_000, event: { type: "chunk", text: "Stale." } }],
          answered("Sure."),
        ]);
        const notes = fakeNotes();
        const metrics = fakeMetrics();
        const turns = service(chat, { notes, metrics });

        const cut = start(turns, input({ utterance: "When do you open?" }));
        await vi.advanceTimersByTimeAsync(500);
        const replaced = start(turns, input({ utterance: "And on", heardUntil: "We open at nine on weekdays. Saturdays at" }));
        await vi.advanceTimersByTimeAsync(2_000);
        const third = start(turns, input({ utterance: "And on Sundays?", heardUntil: "We open at nine on weekdays." }));
        await vi.runAllTimersAsync();
        await Promise.all([cut, replaced, third]);

        expect(chat.heardParts).toEqual([expect.objectContaining({ heardCharacterCount: 41, spokenCharacterCount: 46 })]);
        expect(notes.replyInterrupted).not.toHaveBeenCalled();
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{ partial: "yes" }]);
      });

      it("stores a Japanese reply as far as ElevenLabs played it, with its flush delta between sentences", async () => {
        const chat = supersedingChat([
          [
            { atMs: 0, event: { type: "conversation", conversationId } },
            { atMs: 100, event: { type: "chunk", text: "私たちは平日**九時**に開きます。土曜日は十時に開きます。日" } },
            { atMs: 2_000, event: { type: "chunk", text: "曜日は休みです。" } },
          ],
          answered("はい。"),
        ]);
        const turns = service(chat, { notes: fakeNotes() });

        await cutAt500(turns, { heardUntil: "私たちは平日九時に開きます。 \u200B土曜日は" });

        expect(chat.heardParts).toEqual([expect.objectContaining({ text: "私たちは平日**九時**に開きます。", heardCharacterCount: 18, spokenCharacterCount: 26 })]);
      });

      it("warns once, with counts only, when the report does not match, and hands the teammate's replies back", async () => {
        const claims = {
          ...noOperatorReplies().claims,
          claimPendingOperatorReplies: vi.fn()
            .mockResolvedValueOnce([{ messageId: "77777777-7777-4777-8777-777777777771", text: "Yes, four works." }])
            .mockResolvedValue([]),
        };
        const replies = { claims, operatorReplies: { claims, newClaimTurnId: () => "turn-1" } };
        const chat = supersedingChat([fourSentences, answered("Yes, on Sundays too.")]);
        const logger = fakeLogger();
        const turns = service(chat, { notes: fakeNotes(), logger, operatorReplies: replies.operatorReplies });

        await cutAt500(turns, { heardUntil: "We close at" });

        const mismatches = logger.warn.mock.calls.filter(([, message]) => String(message).startsWith("Voice reply reported heard does not match"));
        expect(mismatches).toEqual([[
          { agentId, vendor: "elevenlabs", conversationId, reachedCharacterCount: 63, reportedCharacterCount: 11 },
          "Voice reply reported heard does not match what reached the runtime; the stored part follows what reached it",
        ]]);
        expect(replies.claims.releaseOperatorReplies).toHaveBeenCalledWith(expect.objectContaining({ claimTurnId: "turn-1" }));
      });

      it("records a whole reply chat stored before the cut as the turn's reply, and marks it by the newer request's report", async () => {
        const wholeBeforeCut = {
          streamTurn: (request: VoiceChatTurnRequest) => (async function* (): AsyncGenerator<ChatStreamEvent> {
            if (request.message === "When do you open?") {
              yield { type: "conversation", conversationId };
              yield { type: "chunk", text: "We open at nine. See you then!" };
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              yield { type: "cancelled", conversationId, reason: "superseded", stage: "persisting", storedReply: { assistantMessageId, partial: false } };
              return;
            }
            yield* answered("Yes.").map((step) => step.event);
          })(),
        };
        const notes = fakeNotes();
        const turns = service(wholeBeforeCut, { notes });

        const cut = start(turns, input({ utterance: "When do you open?" }));
        await vi.advanceTimersByTimeAsync(500);
        // Its first sentence had reached the runtime, which played three words of it.
        const next = start(turns, input({ utterance: "And Sundays?", heardUntil: "We open at" }));
        await vi.runAllTimersAsync();
        await Promise.all([cut, next]);

        expect(notes.replyInterrupted).toHaveBeenCalledWith({
          workspaceId, conversationId, assistantMessageId, heardCharacterCount: 10, spokenCharacterCount: 16,
        });
      });

      it("measures a report against the turn it was about even when the request that sent it settled first", async () => {
        // The first turn's chat finishes its whole reply only after the newer request has settled.
        const lateWhole = {
          streamTurn: (request: VoiceChatTurnRequest) => (async function* (): AsyncGenerator<ChatStreamEvent> {
            if (request.message === "When do you open?") {
              yield { type: "conversation", conversationId };
              yield { type: "chunk", text: "We open at nine. See you then!" };
              await new Promise((resolve) => setTimeout(resolve, 3_000));
              yield { ...done(), answer: "We open at nine. See you then!" } as ChatStreamEvent;
              return;
            }
            yield { type: "conversation", conversationId };
            yield { type: "chunk", text: "Yes, on Sundays too." };
            yield { ...done(), assistantMessageId: "88888888-8888-4888-8888-888888888888", answer: "Yes, on Sundays too." } as ChatStreamEvent;
          })(),
        };
        const notes = fakeNotes();
        const turns = service(lateWhole, { notes });

        const late = start(turns, input({ utterance: "When do you open?" }));
        await vi.advanceTimersByTimeAsync(500);
        const newer = start(turns, input({ utterance: "And Sundays?", heardUntil: "We open at nine. See" }));
        await vi.advanceTimersByTimeAsync(1_000);
        await newer;
        await vi.runAllTimersAsync();
        await late;

        expect(notes.replyInterrupted).toHaveBeenCalledTimes(1);
        expect(notes.replyInterrupted).toHaveBeenCalledWith({
          workspaceId, conversationId, assistantMessageId, heardCharacterCount: 20, spokenCharacterCount: 30,
        });
      });

      it("answers an identical re-request with a new turn, not the stored part again", async () => {
        const chat = supersedingChat([fourSentences]);
        // The request that cut the reply off fails before chat reports anything, so the session's
        // last exchange stays the cut one.
        const failingAfterCut = {
          streamTurn: (request: VoiceChatTurnRequest) => {
            if (chat.requests.length >= 1 && chat.requests.length < 2) {
              chat.streamTurn(request);
              return (async function* (): AsyncGenerator<ChatStreamEvent> {
                await new Promise((resolve) => setTimeout(resolve, 100));
                throw new Error("model unavailable");
              })();
            }
            return chat.requests.length === 0 ? chat.streamTurn(request) : fakeChat([...answered("We open at nine on weekdays and ten on Saturdays.").map((step) => step.event)]).streamTurn(request);
          },
        };
        const notes = fakeNotes();
        const turns = service(failingAfterCut, { notes });

        const first = start(turns, input({ utterance: "When do you open?" }));
        await vi.advanceTimersByTimeAsync(500);
        const failed = start(turns, input({ utterance: "Sorry?" })).then(() => "completed", () => "failed");
        // The cut turn learns it was cut off at its next step, at 2 s.
        await vi.advanceTimersByTimeAsync(2_000);
        await first;
        expect(await failed).toBe("failed");
        expect(chat.heardParts).toHaveLength(1);
        const again = start(turns, input({ utterance: "When do you open?" }));
        await vi.runAllTimersAsync();

        expect(spokenText(await again)).toBe("We open at nine on weekdays and ten on Saturdays.");
        expect(notes.replyReplayed).not.toHaveBeenCalled();
      });
    });

    describe("a teammate's replies to the caller", () => {
      const fourWorks = { messageId: "77777777-7777-4777-8777-777777777771", text: "Yes, **four** works." };
      const bringCard = { messageId: "77777777-7777-4777-8777-777777777772", text: "Bring your card, please. See you then" };
      const wordless = { messageId: "77777777-7777-4777-8777-777777777773", text: "**" };

      /** Chat on a turn a person owns, once a teammate has written: no waiting line, no reply. */
      const silentWhileHumanOwned: Step[] = [
        { atMs: 0, event: { type: "status", stage: "interpreting" } },
        { atMs: 0, event: { type: "status", stage: "composing" } },
        { atMs: 50, event: waitingDone("") },
      ];

      type Speech = { state: "pending" } | { state: "claimed"; claimTurnId: string } | { state: "spoken" } | { state: "skipped" };

      /**
       * Chat's store of the conversation's teammate replies, as the message repository keeps them:
       * a turn claims every pending reply in one write, and the reply reads as taken until the turn
       * marks it spoken or skipped, or releases it. `claimDelayMs` and `markDelayMs` hold those
       * writes back; each takes effect when it lands.
       */
      const teammateReplies = (replies: Array<{ messageId: string; text: string }>, options: { claimDelayMs?: number; markDelayMs?: number } = {}) => {
        const speech = new Map<string, Speech>(replies.map((reply) => [reply.messageId, { state: "pending" }]));
        const later = (ms: number | undefined): Promise<void> =>
          ms ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve();
        const settleTo = (to: Speech, delayMs?: number) => vi.fn(async ({ messageIds, claimTurnId }: { messageIds: string[]; claimTurnId: string }) => {
          await later(delayMs);
          return messageIds.filter((messageId) => {
            const current = speech.get(messageId);
            if (current?.state !== "claimed" || current.claimTurnId !== claimTurnId) return false;
            speech.set(messageId, to);
            return true;
          });
        });
        let turnIds = 0;
        const claims = {
          claimPendingOperatorReplies: vi.fn(async ({ claimTurnId }: { claimTurnId: string }) => {
            await later(options.claimDelayMs);
            return replies.filter((reply) => {
              if (speech.get(reply.messageId)?.state !== "pending") return false;
              speech.set(reply.messageId, { state: "claimed", claimTurnId });
              return true;
            });
          }),
          markOperatorRepliesSpoken: settleTo({ state: "spoken" }, options.markDelayMs),
          skipOperatorReplies: settleTo({ state: "skipped" }),
          releaseOperatorReplies: settleTo({ state: "pending" }),
        };
        return {
          notes: fakeNotes(),
          claims,
          speech,
          operatorReplies: { claims, newClaimTurnId: () => `turn-${++turnIds}` },
        };
      };

      const speechOf = (events: VoiceTurnEvent[]) => events.filter((event) => event.type === "speech");

      it("speaks the pending replies in order on a turn a person owns, in place of the waiting line, and marks them spoken", async () => {
        const replies = teammateReplies([fourWorks, bringCard]);
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const chat = supersedingChat([silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes, metrics, logger });

        const turn = start(turns, input({ utterance: "Can I come at four?" }));
        await vi.runAllTimersAsync();
        const events = await turn;

        expect(events.map((event) => event.type)).toEqual(["conversation", "speech", "speech", "speech", "speech", "outcome"]);
        expect(speechOf(events)).toEqual([
          { type: "speech", text: "Yes, four works.\n", last: false },
          { type: "speech", text: "Bring your card, please. ", last: false },
          { type: "speech", text: "See you then\n", last: false },
          { type: "speech", text: "", last: true },
        ]);
        expect(events.at(-1)).toEqual({ type: "outcome", outcome: { kind: "continue" } });
        expect(chat.requests.map((request) => request.message)).toEqual(["Can I come at four?"]);
        expect(replies.claims.claimPendingOperatorReplies).toHaveBeenCalledWith({ workspaceId, conversationId, claimTurnId: "turn-1" });
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith({
          workspaceId, conversationId, messageIds: [fourWorks.messageId, bringCard.messageId], claimTurnId: "turn-1",
        });
        expect(replies.notes.operatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.notes.operatorRepliesSpoken).toHaveBeenCalledWith({
          workspaceId, conversationId, messageIds: [fourWorks.messageId, bringCard.messageId],
        });
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
        expect(metrics.incrementCounter).toHaveBeenCalledWith("voice_operator_reply_spoken_total", expect.objectContaining({ value: 2 }));
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ result: "completed", outcome: "continue", speechPieceCount: 4, spokenOperatorReplies: 2 }),
          "Voice turn finished",
        );
        expect(metrics.incrementCounter).not.toHaveBeenCalledWith("voice_bridge_emitted_total", expect.anything());
      });

      it("speaks a reply once: the next turn hears chat again", async () => {
        const waiting = "Thanks for waiting.";
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([silentWhileHumanOwned, [
          { atMs: 0, event: { type: "chunk", text: waiting } },
          { atMs: 0, event: waitingDone(waiting) },
        ]]);
        const logger = fakeLogger();
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes, logger });

        const first = start(turns, input({ utterance: "Four?" }));
        await vi.runAllTimersAsync();
        await first;
        const second = start(turns, input({ utterance: "Great, thanks." }));
        await vi.runAllTimersAsync();

        expect(spokenText(await second)).toBe(waiting);
        expect(replies.notes.operatorRepliesSpoken).toHaveBeenCalledTimes(1);
        const [, secondLog] = logger.info.mock.calls.map(([fields]) => fields as Record<string, unknown>);
        expect(secondLog).not.toHaveProperty("spokenOperatorReplies");
      });

      it("counts, logs and audits only the replies the mark recorded as spoken", async () => {
        const replies = teammateReplies([fourWorks]);
        // The claim expired and another turn recorded them first.
        replies.claims.markOperatorRepliesSpoken.mockResolvedValue([]);
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const turns = service(supersedingChat([silentWhileHumanOwned]), {
          ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes, metrics, logger,
        });

        const turn = start(turns);
        await vi.runAllTimersAsync();
        await turn;

        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.notes.operatorRepliesSpoken).not.toHaveBeenCalled();
        expect(counted(metrics, "voice_operator_reply_spoken_total")).toEqual([]);
        expect(logger.info.mock.calls[0]?.[0]).not.toHaveProperty("spokenOperatorReplies");
      });

      it("speaks a reply still pending at hand-back ahead of the agent's answer, with no bridge line after it", async () => {
        const replies = teammateReplies([fourWorks]);
        const metrics = fakeMetrics();
        const chat = supersedingChat([[
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 0, event: { type: "status", stage: "searching" } },
          { atMs: 3_000, event: { type: "chunk", text: "We open at nine." } },
          { atMs: 3_000, event: done() },
        ]]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes, metrics });

        const turn = start(turns, input({ utterance: "And when do you open?" }));
        await vi.runAllTimersAsync();
        const events = await turn;

        expect(events).toEqual([
          { type: "conversation", conversationId },
          { type: "speech", text: "Yes, four works.\n", last: false },
          { type: "speech", text: "We open at nine.", last: true },
          { type: "outcome", outcome: { kind: "continue" } },
        ]);
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [fourWorks.messageId], claimTurnId: "turn-1" });
        expect(counted(metrics, "voice_bridge_emitted_total")).toEqual([]);
        expect(metrics.observeHistogram).toHaveBeenCalledWith("voice_turn_first_speech_ms", expect.objectContaining({ labels: { bridged: "no" } }));
      });

      it("records them as spoken when the turn limit ends the turn, without waiting for the unheard answer to drain", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([[
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 20_000, event: { type: "chunk", text: "We open at nine." } },
          { atMs: 20_000, event: done() },
        ]]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });

        const turn = start(turns, input({ utterance: "And when do you open?" }));
        await vi.advanceTimersByTimeAsync(11_000);
        const events = await turn;

        expect(spokenText(events)).toBe("Yes, four works.\nSorry, could you ask me again?");
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
        await vi.runAllTimersAsync();
      });

      it("counts what the caller heard of the agent's reply after a teammate's reply, not the teammate's words", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([answered("We open at nine. See you then!"), answered("Yes.")]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "And when do you open?" }));
        await vi.runAllTimersAsync();
        await first;
        const next = start(turns, input({ utterance: "Sorry, on Sundays?", heardUntil: "Yes, four works.\n ​We open at nine.  ​See" }));
        await vi.runAllTimersAsync();
        await next;

        expect(replies.notes.replyInterrupted).toHaveBeenCalledWith({
          workspaceId, conversationId, assistantMessageId, heardCharacterCount: 20, spokenCharacterCount: 30,
        });
      });

      it("hands the replies back when the runtime hung up before the outcome left, so the next turn speaks them", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([silentWhileHumanOwned, silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });
        const hungUp = new AbortController();
        hungUp.abort();

        const lost = start(turns, input({ utterance: "Four?" }), hungUp.signal);
        await vi.runAllTimersAsync();
        await lost;
        expect(replies.claims.markOperatorRepliesSpoken).not.toHaveBeenCalled();
        expect(replies.claims.releaseOperatorReplies).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [fourWorks.messageId], claimTurnId: "turn-1" });

        const next = start(turns, input({ utterance: "Hello?" }));
        await vi.runAllTimersAsync();

        expect(speechOf(await next)[0]).toEqual({ type: "speech", text: "Yes, four works.\n", last: false });
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("hands the replies back when the turn fails after speaking them", async () => {
        const replies = teammateReplies([fourWorks]);
        const failing = {
          streamTurn: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "status", stage: "interpreting" };
            throw new Error("model unavailable");
          })(),
        };
        const turns = service(failing, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const failed = start(turns, input({ utterance: "Four?" }));
        const settled = failed.then(() => "completed", () => "failed");
        await vi.runAllTimersAsync();

        expect(await settled).toBe("failed");
        expect(replies.claims.markOperatorRepliesSpoken).not.toHaveBeenCalled();
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });
      });

      it("hands the replies a turn held to the newer request that overtook it before its outcome, which speaks them", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([
          [
            { atMs: 0, event: { type: "conversation", conversationId } },
            { atMs: 3_000, event: { type: "chunk", text: "We open at nine." } },
            { atMs: 3_000, event: done() },
          ],
          answered("Sundays too."),
        ]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });

        const overtaken = start(turns, input({ utterance: "And when do you open?" }));
        await vi.advanceTimersByTimeAsync(1_000);
        const newer = start(turns, input({ utterance: "And on Sundays?" }));
        await vi.runAllTimersAsync();

        expect(speechOf(await overtaken)[0]).toEqual({ type: "speech", text: "Yes, four works.\n", last: false });
        expect(spokenText(await newer)).toBe("Yes, four works.\nSundays too.");
        expect(replies.claims.releaseOperatorReplies).toHaveBeenCalledWith(expect.objectContaining({ claimTurnId: "turn-1" }));
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith(expect.objectContaining({ claimTurnId: "turn-2" }));
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("keeps a reply the runtime played whole as spoken when the agent's answer after it is cut off", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([
          [
            { atMs: 0, event: { type: "conversation", conversationId } },
            { atMs: 100, event: { type: "chunk", text: "We open at nine. " } },
            { atMs: 2_000, event: { type: "chunk", text: "See you then!" } },
            { atMs: 2_000, event: done() },
          ],
          answered("Sundays too."),
        ]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "And when do you open?" }));
        await vi.advanceTimersByTimeAsync(500);
        const newer = start(turns, input({ utterance: "And on Sundays?", heardUntil: "Yes, four works.\n \u200BWe open at nine." }));
        await vi.runAllTimersAsync();

        expect(spokenText(await first)).toBe("Yes, four works.\nWe open at nine. ");
        expect(spokenText(await newer)).toBe("Sundays too.");
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [fourWorks.messageId], claimTurnId: "turn-1" }));
        expect(replies.claims.releaseOperatorReplies).not.toHaveBeenCalled();
        expect(chat.heardParts).toEqual([expect.objectContaining({ text: "We open at nine. ", heardCharacterCount: 16, spokenCharacterCount: 16 })]);
      });

      it("hands back the reply the caller spoke over, for the request that cut in to speak whole, and keeps the one played before it spoken", async () => {
        const replies = teammateReplies([fourWorks, bringCard]);
        const slowSilence: Step[] = [
          { atMs: 0, event: { type: "status", stage: "interpreting" } },
          { atMs: 400, event: waitingDone("") },
        ];
        const chat = supersedingChat([slowSilence, silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "Can I come at four?" }));
        await vi.advanceTimersByTimeAsync(100);
        // ElevenLabs had played the first reply and part of the second when the caller spoke.
        const bargeIn = start(turns, input({ utterance: "Sorry, four?", heardUntil: "Yes, four works.\n \u200BBring your card" }));
        await vi.runAllTimersAsync();
        await first;

        expect(spokenText(await bargeIn)).toBe("Bring your card, please. See you then\n");
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [fourWorks.messageId], claimTurnId: "turn-1" }));
        expect(replies.claims.releaseOperatorReplies).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [bringCard.messageId], claimTurnId: "turn-1" }));
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [bringCard.messageId], claimTurnId: "turn-2" }));
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
        expect(replies.speech.get(bringCard.messageId)).toEqual({ state: "spoken" });
      });

      it("hands back every reply of a response that is not streamed and was cut off before its outcome", async () => {
        const replies = teammateReplies([fourWorks]);
        const slowSilence: Step[] = [
          { atMs: 0, event: { type: "status", stage: "interpreting" } },
          { atMs: 400, event: waitingDone("") },
        ];
        const chat = supersedingChat([slowSilence, silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "Can I come at four?", streamsSpeech: false }));
        await vi.advanceTimersByTimeAsync(100);
        const bargeIn = start(turns, input({ utterance: "Hello?", streamsSpeech: false, heardUntil: "Yes, four works." }));
        await vi.runAllTimersAsync();
        await first;

        expect(spokenText(await bargeIn)).toBe("Yes, four works.\n");
        expect(replies.claims.releaseOperatorReplies).toHaveBeenCalledWith(expect.objectContaining({ messageIds: [fourWorks.messageId], claimTurnId: "turn-1" }));
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledWith(expect.objectContaining({ claimTurnId: "turn-2" }));
      });

      it("hands them over on a call a person owns too, so the caller's barge-in is not met with silence", async () => {
        const replies = teammateReplies([fourWorks]);
        const slowSilence: Step[] = [
          { atMs: 0, event: { type: "status", stage: "interpreting" } },
          { atMs: 400, event: waitingDone("") },
        ];
        const chat = supersedingChat([slowSilence, silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "Four?" }));
        await vi.advanceTimersByTimeAsync(100);
        const bargeIn = start(turns, input({ utterance: "Hello? Four o'clock?" }));
        await vi.runAllTimersAsync();
        await first;

        expect(spokenText(await bargeIn)).toBe("Yes, four works.\n");
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("settles its claims without notes", async () => {
        const replies = teammateReplies([fourWorks]);
        const turns = service(supersedingChat([silentWhileHumanOwned]), { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies });

        const turn = start(turns);
        await vi.runAllTimersAsync();
        await turn;

        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("logs the turn's own duration, with the replies recorded spoken once the mark lands", async () => {
        const replies = teammateReplies([fourWorks], { markDelayMs: 3_000 });
        const logger = fakeLogger();
        const turns = service(supersedingChat([silentWhileHumanOwned]), {
          ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes, logger,
        });

        const turn = start(turns);
        await vi.advanceTimersByTimeAsync(100);
        await turn;
        expect(logger.info).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 50, spokenOperatorReplies: 1 }), "Voice turn finished");
      });

      it("speaks nothing twice when a turn settles while a newer request's claim is in flight", async () => {
        const replies = teammateReplies([fourWorks], { claimDelayMs: 100, markDelayMs: 200 });
        const chat = supersedingChat([silentWhileHumanOwned, silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const first = start(turns, input({ utterance: "Four?" }));
        // The first turn has claimed the reply, spoken it and completed; its mark is still being written.
        await vi.advanceTimersByTimeAsync(160);
        const second = start(turns, input({ utterance: "Great." }));
        await vi.runAllTimersAsync();

        expect(speechOf(await first)[0]).toEqual({ type: "speech", text: "Yes, four works.\n", last: false });
        expect(spokenText(await second)).toBe("");
        expect(replies.claims.claimPendingOperatorReplies).toHaveBeenCalledTimes(2);
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("speaks nothing of them on a request a newer one overtook while it set up; the newer one speaks them", async () => {
        const replies = teammateReplies([fourWorks], { claimDelayMs: 150 });
        const chat = supersedingChat([silentWhileHumanOwned]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes });

        const overtaken = start(turns, input({ utterance: "Four" }));
        await vi.advanceTimersByTimeAsync(100);
        const newest = start(turns, input({ utterance: "Four o'clock?" }));
        await vi.runAllTimersAsync();

        expect(await overtaken).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
        expect(speechOf(await newest)[0]).toEqual({ type: "speech", text: "Yes, four works.\n", last: false });
        expect(replies.claims.markOperatorRepliesSpoken).toHaveBeenCalledTimes(1);
      });

      it("hands back the claim of a re-request overtaken while it claimed, and replays nothing to it", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([answered("We open at nine."), answered("On Sundays too.")]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });
        const hungUp = new AbortController();
        hungUp.abort();
        const lost = start(turns, input({ utterance: "When do you open?" }), hungUp.signal);
        await vi.runAllTimersAsync();
        await lost;
        replies.claims.claimPendingOperatorReplies.mockClear();
        const claimNow = replies.claims.claimPendingOperatorReplies.getMockImplementation()!;
        replies.claims.claimPendingOperatorReplies.mockImplementationOnce(async (claim) => {
          await new Promise((resolve) => { setTimeout(resolve, 150); });
          return claimNow(claim);
        });

        const replayed = start(turns, input({ utterance: "When do you open?" }));
        await vi.advanceTimersByTimeAsync(100);
        const newer = start(turns, input({ utterance: "And on Sundays?" }));
        await vi.runAllTimersAsync();

        expect(await replayed).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
        expect(replies.notes.replyReplayed).not.toHaveBeenCalled();
        expect(spokenText(await newer)).toBe("Yes, four works.\nOn Sundays too.");
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("speaks a reply the lost turn handed back before the answer an identical re-request hears again", async () => {
        const replies = teammateReplies([fourWorks]);
        const chat = supersedingChat([answered("We open at nine.")]);
        const turns = service(chat, { operatorReplies: replies.operatorReplies, notes: replies.notes });
        const hungUp = new AbortController();
        hungUp.abort();

        const lost = start(turns, input({ utterance: "When do you open?" }), hungUp.signal);
        await vi.runAllTimersAsync();
        await lost;
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "pending" });

        const replayed = start(turns, input({ utterance: "When do you open?" }));
        await vi.runAllTimersAsync();

        expect(await replayed).toEqual([
          { type: "conversation", conversationId },
          { type: "speech", text: "Yes, four works.\n", last: false },
          { type: "speech", text: "We open at nine.", last: true },
          { type: "outcome", outcome: { kind: "continue" } },
        ]);
        expect(chat.requests).toHaveLength(1);
        expect(replies.notes.replyReplayed).toHaveBeenCalledTimes(1);
        expect(replies.speech.get(fourWorks.messageId)).toEqual({ state: "spoken" });
      });

      it("speaks no reply with no words to say, and marks it skipped", async () => {
        const replies = teammateReplies([wordless, fourWorks]);
        const turns = service(supersedingChat([silentWhileHumanOwned]), {
          ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes,
        });

        const turn = start(turns);
        await vi.runAllTimersAsync();

        expect(spokenText(await turn)).toBe("Yes, four works.\n");
        expect(replies.claims.skipOperatorReplies).toHaveBeenCalledWith({ workspaceId, conversationId, messageIds: [wordless.messageId], claimTurnId: "turn-1" });
        expect(replies.speech.get(wordless.messageId)).toEqual({ state: "skipped" });
      });

      it("runs the turn as chat answers it when the pending replies cannot be claimed, and warns", async () => {
        const waiting = "Thanks for waiting.";
        const logger = fakeLogger();
        const replies = teammateReplies([fourWorks]);
        replies.claims.claimPendingOperatorReplies.mockRejectedValue(new Error("connection reset"));
        const chat = supersedingChat([[
          { atMs: 0, event: { type: "chunk", text: waiting } },
          { atMs: 0, event: waitingDone(waiting) },
        ]]);
        const turns = service(chat, { ownership: conversationOwnership(true), operatorReplies: replies.operatorReplies, notes: replies.notes, logger });

        const turn = start(turns);
        await vi.runAllTimersAsync();

        expect(spokenText(await turn)).toBe(waiting);
        expect(replies.claims.markOperatorRepliesSpoken).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          { agentId, vendor: "elevenlabs", conversationId, errorClass: "Error", step: "claim" },
          "Voice turn could not update the teammate's pending replies",
        );
      });
    });
  });

  describe("a turn that switches the call's language", () => {
    const voiceOn: AgentVoiceSettings = {
      enabled: true,
      bridgeLines: {
        en: { acknowledge: ["Got it."], check: ["Let me check."] },
        it: { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
      },
      fallbackLine: { en: "Sorry, could you ask me again?" },
      runtime: null,
      languageSwitching: true,
    };
    const answer = "Apriamo alle nove.";
    const switchEvent = { type: "switchLanguage", switchId: "switch-1", language: "it", reason: "response_language" } as const;

    type Step = { atMs: number; event: ChatStreamEvent };

    /**
     * Chat on the fake clock. A newer turn on the conversation cancels the one in flight at its next
     * step, as the registry does for `latest_input_wins`; a turn cut off after it emitted stores what
     * the channel says reached the caller.
     */
    const scriptedChat = (scripts: Step[][]) => {
      const requests: VoiceChatTurnRequest[] = [];
      const heardParts: Array<DeliveredReplyPart | null> = [];
      const finished: boolean[] = [];
      let newest = -1;
      return {
        requests,
        heardParts,
        finished,
        streamTurn: (request: VoiceChatTurnRequest) => {
          requests.push(request);
          const index = requests.length - 1;
          newest = index;
          finished[index] = false;
          const steps = scripts[index] ?? [];
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            const startedAt = Date.now();
            let emitted = false;
            try {
              for (const step of steps) {
                const wait = startedAt + step.atMs - Date.now();
                if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
                if (newest !== index) {
                  const heard = emitted ? request.deliveredReply() : null;
                  if (emitted) heardParts.push(heard);
                  yield { type: "cancelled", conversationId, reason: "superseded", stage: "rendering", ...(heard ? { storedReply: { assistantMessageId: `cut-${index}`, partial: true } } : {}) };
                  return;
                }
                emitted ||= step.event.type === "chunk";
                yield step.event;
              }
            } finally {
              finished[index] = true;
            }
          })();
        },
      };
    };

    /** A knowledge turn the planner answers in `tag`: it searches, then writes the answer at `answerAtMs`. */
    const plannedIn = (tag: string, answerAtMs = 3_000, text = answer): Step[] => [
      { atMs: 0, event: { type: "status", stage: "interpreting" } },
      { atMs: 0, event: { type: "conversation", conversationId } },
      { atMs: 1_100, event: { type: "status", stage: "searching" } },
      { atMs: 1_105, event: { type: "language", tag } },
      { atMs: answerAtMs, event: { type: "chunk", text } },
      { atMs: answerAtMs, event: { ...done(), answer: text } as ChatStreamEvent },
    ];

    const fakeMetrics = () => ({ observeHistogram: vi.fn(), incrementCounter: vi.fn() });
    const counted = (metrics: ReturnType<typeof fakeMetrics>, name: string) =>
      metrics.incrementCounter.mock.calls.filter(([metric]) => metric === name).map(([, options]) => (options as { labels?: unknown }).labels ?? {});

    const service = (
      chat: { streamTurn: (request: VoiceChatTurnRequest) => AsyncIterable<ChatStreamEvent> },
      overrides: Partial<ConstructorParameters<typeof VoiceTurnService>[0]> = {},
      voice: AgentVoiceSettings = voiceOn,
    ) =>
      new VoiceTurnService({
        agents: voiceProfiles(voice, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        operatorReplies: noOperatorReplies(),
        sessions: fakeSessions(conversationId),
        chat,
        logger: fakeLogger(),
        newLanguageSwitchId: () => "switch-1",
        ...overrides,
      });

    /** The caller's turn, on a request that offers the switch. */
    const offered = (overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput =>
      input({ utterance: "A che ora aprite?", locale: "en", languageSwitchOffer: { refused: [] }, ...overrides });

    /** The runtime's follow-up after the switch, as its history reports it. */
    const followUp = (confirmed: boolean, overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput =>
      offered({
        languageSwitchResult: { switchId: "switch-1", confirmed },
        ...(confirmed ? { turnLanguage: { tag: "it", source: "vendor_detected", isNew: true } } : { languageReport: "blocked" }),
        ...overrides,
      });

    /** Starts a request now and collects its events, each with when it left, as the fake clock runs. */
    const start = (turns: VoiceTurnService, turn: VoiceTurnInput) => {
      const startedAt = Date.now();
      const events: Array<{ atMs: number; event: VoiceTurnEvent }> = [];
      const finished = (async () => {
        for await (const event of turns.runTurn(turn, new AbortController().signal)) {
          events.push({ atMs: Date.now() - startedAt, event });
        }
        return events;
      })();
      return finished;
    };

    const finishedLog = (logger: ReturnType<typeof fakeLogger>) =>
      logger.info.mock.calls.filter(([, message]) => message === "Voice turn finished").map(([fields]) => fields as Record<string, unknown>);

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks the runtime to switch when the planner answers in another language, and speaks nothing on that request", async () => {
      const chat = scriptedChat([plannedIn("it")]);
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const turns = service(chat, { logger, metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_200);
      const events = await switching;

      expect(events).toEqual([
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 1_105, event: switchEvent },
        { atMs: 1_105, event: { type: "outcome", outcome: { kind: "continue" } } },
      ]);
      // The chat turn runs on behind the request and finishes as any turn does.
      expect(chat.finished[0]).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(chat.finished[0]).toBe(true);
      expect(chat.requests).toHaveLength(1);
      expect(chat.requests[0]).not.toHaveProperty("userExpectedLocale");
      // A turn that may switch asks chat to report the language it answers in.
      expect(chat.requests[0]).toMatchObject({ reportResponseLanguage: true });
      expect(finishedLog(logger)).toEqual([expect.objectContaining({ result: "completed", languageSwitch: "emitted", speechPieceCount: 0, outcome: "continue" })]);
      expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }]);
      expect(counted(metrics, "voice_bridge_emitted_total")).toEqual([]);
      // The runtime receives the turn's outcome with its answer, on the follow-up, which counts it.
      expect(counted(metrics, "voice_turn_outcome_total")).toEqual([]);
    });

    it("speaks the answer on the runtime's follow-up, with the new language's bridge while the answer is still being written", async () => {
      const chat = scriptedChat([plannedIn("it")]);
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const turns = service(chat, { logger, metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const spoken = start(turns, followUp(true));
      await vi.runAllTimersAsync();
      const events = await spoken;

      expect(events).toEqual([
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 0, event: { type: "bridge", text: "Controllo subito." } },
        { atMs: 1_345, event: { type: "speech", text: answer, last: true } },
        { atMs: 1_345, event: { type: "outcome", outcome: { kind: "continue" } } },
      ]);
      // One chat turn answered the utterance: the follow-up ran none of its own.
      expect(chat.requests).toHaveLength(1);
      const logs = finishedLog(logger);
      expect(logs).toContainEqual(expect.objectContaining({ languageSwitch: "emitted", speechPieceCount: 0 }));
      expect(logs).toContainEqual(expect.objectContaining({ languageSwitch: "confirmed", speechPieceCount: 1, bridged: true, turnLanguage: "it" }));
      expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }]);
      expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([{ outcome: "confirmed" }]);
      // The turn's outcome, and its lines' language, are counted once, by the request that spoke.
      expect(counted(metrics, "voice_turn_outcome_total")).toHaveLength(1);
      expect(counted(metrics, "voice_turn_language_source_total")).toEqual([{ source: "vendor_detected" }]);
    });

    it("speaks an answer already written at once, without a bridge", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const turns = service(chat);

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const spoken = start(turns, followUp(true));
      await vi.runAllTimersAsync();

      expect(await spoken).toEqual([
        { atMs: 0, event: { type: "conversation", conversationId } },
        { atMs: 0, event: { type: "speech", text: answer, last: true } },
        { atMs: 0, event: { type: "outcome", outcome: { kind: "continue" } } },
      ]);
    });

    it("speaks the answer anyway when the runtime refused the switch, and logs the refusal", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const turns = service(chat, { logger, metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const spoken = start(turns, followUp(false));
      await vi.runAllTimersAsync();

      expect(spokenText((await spoken).map(({ event }) => event))).toBe(answer);
      expect(finishedLog(logger)).toContainEqual(expect.objectContaining({ languageSwitch: "refused", languageReport: "blocked" }));
      expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }]);
      expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([{ outcome: "refused" }]);
    });

    it("runs a normal turn when the agent has not turned language switching on, and asks chat for no language", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const turns = service(chat, {}, { ...voiceOn, languageSwitching: false });

      const turn = start(turns, offered());
      await vi.runAllTimersAsync();
      const events = (await turn).map(({ event }) => event);

      expect(events.map((event) => event.type)).toEqual(["conversation", "bridge", "speech", "outcome"]);
      expect(events).toContainEqual({ type: "bridge", text: "Let me check." });
      expect(chat.requests[0]).not.toHaveProperty("reportResponseLanguage");
    });

    it("asks for no switch while the call's language is unknown: an unreadable switch, or a three-letter tag beside a two-letter one", async () => {
      const runs: Array<{ turn: VoiceTurnInput; planned: string }> = [
        { turn: offered({ languageReport: "unreadable" }), planned: "it" },
        { turn: offered(), planned: "ita" },
        { turn: offered({ languageSwitchOffer: { refused: ["ita"] } }), planned: "it" },
      ];
      for (const { turn, planned } of runs) {
        const turns = service(scriptedChat([plannedIn(planned, 1_300)]));
        const events = start(turns, turn);
        await vi.runAllTimersAsync();
        const seen = (await events).map(({ event }) => event);
        expect(seen.some((event) => event.type === "switchLanguage"), planned).toBe(false);
        expect(spokenText(seen)).toBe(answer);
      }
    });

    it("keeps the call's language when the planner's has the same primary subtag, or the runtime offers no switch, or refused this language before", async () => {
      const runs = [
        offered({ locale: "it-IT" }),
        offered({ languageSwitchOffer: undefined }),
        offered({ languageSwitchOffer: { refused: ["it"] } }),
      ];
      for (const turnInput of runs) {
        const turns = service(scriptedChat([plannedIn("it", 1_300)]));
        const turn = start(turns, turnInput);
        await vi.runAllTimersAsync();
        const events = (await turn).map(({ event }) => event);
        expect(events.some((event) => event.type === "switchLanguage")).toBe(false);
        expect(spokenText(events)).toBe(answer);
      }
    });

    it("keeps the call's language on a turn that spoke a teammate's reply first: a switch must be all its request carries", async () => {
      let pending = [{ messageId: "77777777-7777-4777-8777-777777777771", text: "Ciao, sono Marta." }];
      const operatorReplies = {
        claims: {
          claimPendingOperatorReplies: vi.fn(async () => {
            const claimed = pending;
            pending = [];
            return claimed;
          }),
          markOperatorRepliesSpoken: vi.fn(async ({ messageIds }: { messageIds: string[] }) => messageIds),
          skipOperatorReplies: vi.fn(async () => []),
          releaseOperatorReplies: vi.fn(async () => []),
        },
        newClaimTurnId: () => "turn-1",
      };
      const turns = service(scriptedChat([plannedIn("it", 1_300)]), { operatorReplies });

      const turn = start(turns, offered());
      await vi.runAllTimersAsync();
      const events = (await turn).map(({ event }) => event);

      expect(events.some((event) => event.type === "switchLanguage")).toBe(false);
      expect(spokenText(events)).toContain("Ciao, sono Marta.");
      expect(spokenText(events)).toContain(answer);
    });

    it("logs a switching turn with its reply's own outcome, not the switch's continue", async () => {
      const handedOff = { ...done(), answer, handoff: { reason: "routine_handoff", collectedSlotCount: 1 }, ownership: { state: "human_owned", suppressed: false } } as ChatStreamEvent;
      const chat = scriptedChat([[...plannedIn("it", 1_300).slice(0, -1), { atMs: 1_300, event: handedOff }]]);
      const logger = fakeLogger();
      const turns = service(chat, { logger });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_200);
      expect((await switching).at(-1)).toMatchObject({ event: { type: "outcome", outcome: { kind: "continue" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(finishedLog(logger)).toEqual([expect.objectContaining({ languageSwitch: "emitted", outcome: "callback_requested", handoffReason: "routine_handoff" })]);
    });

    it("counts a switch the runtime never follows up as unanswered once the replay window passes, and its outcome once", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const turns = service(chat, { logger, metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_200);
      await switching;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }, { outcome: "unanswered" }]);
      // The turn's outcome and lines' language are counted, and logged, once nobody else will.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId, languageSwitch: "unanswered", outcome: "continue", turnLanguage: "en", languageSource: "session" }),
        "Voice language switch was not followed up",
      );
      expect(counted(metrics, "voice_turn_outcome_total")).toEqual([{ kind: "continue", handoff_reason: "none" }]);
      expect(counted(metrics, "voice_turn_language_source_total")).toEqual([{ source: "session" }]);
    });

    it("lets an identical re-request hear the answer of a switch nobody followed up, without a second turn", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const turns = service(chat);

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_200);
      await switching;
      await vi.advanceTimersByTimeAsync(2_000);
      const repeat = start(turns, offered());
      await vi.runAllTimersAsync();

      expect((await repeat).map(({ event }) => event)).toEqual([
        { type: "conversation", conversationId },
        { type: "speech", text: answer, last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]);
      expect(chat.requests).toHaveLength(1);
    });

    describe("a follow-up this instance holds no switched turn for", () => {
      const voiceWithItalianFallback: AgentVoiceSettings = { ...voiceOn, fallbackLine: { en: "Sorry, could you ask me again?", it: "Scusa, puoi ripetere?" } };
      /** The conversation as the instance that switched stores it: the answer lands at `answerAtMs`. */
      const storedAnswerAt = (answerAtMs: number | null, utterance = "A che ora aprite?") => {
        const startedAt = Date.now();
        return {
          newestExchange: vi.fn(async () => ({
            utterance,
            reply: answerAtMs !== null && Date.now() - startedAt >= answerAtMs ? { messageId: "66666666-6666-4666-8666-666666666666", text: answer } : null,
          })),
        };
      };

      it("bridges in the confirmed language, then speaks the answer the other instance stores", async () => {
        const chat = scriptedChat([]);
        const logger = fakeLogger();
        const metrics = fakeMetrics();
        const sessions = fakeSessions(conversationId);
        const storedReplies = storedAnswerAt(1_500);
        const elsewhere = service(chat, { logger, metrics, sessions, storedReplies });

        const spoken = start(elsewhere, followUp(true));
        await vi.runAllTimersAsync();

        expect(await spoken).toEqual([
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 0, event: { type: "bridge", text: "Controllo subito." } },
          { atMs: 1_500, event: { type: "speech", text: answer, last: true } },
          { atMs: 1_500, event: { type: "outcome", outcome: { kind: "continue" } } },
        ]);
        expect(chat.requests).toEqual([]);
        expect(sessions.findConversationId).toHaveBeenCalledWith(followUp(true).session);
        expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([{ outcome: "unheld" }]);
        expect(counted(metrics, "voice_language_switch_total")).toEqual([]);
        // The instance that switched counts the turn's outcome.
        expect(counted(metrics, "voice_turn_outcome_total")).toEqual([]);
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId, languageSwitch: "unheld", speechPieceCount: 1 }),
          "Voice language switch follow-up found no switched turn here",
        );
      });

      it("speaks the fallback line in the confirmed language when no answer is stored by the turn limit", async () => {
        const elsewhere = service(scriptedChat([]), { storedReplies: storedAnswerAt(null) }, voiceWithItalianFallback);

        const spoken = start(elsewhere, followUp(true));
        await vi.runAllTimersAsync();

        expect(await spoken).toEqual([
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 0, event: { type: "bridge", text: "Controllo subito." } },
          { atMs: 10_000, event: { type: "speech", text: "Scusa, puoi ripetere?", last: true } },
          { atMs: 10_000, event: { type: "outcome", outcome: { kind: "continue" } } },
        ]);
      });

      it("lets the session's held switch go as mismatched for a follow-up of another utterance, which says nothing, and keeps it replayable", async () => {
        const chat = scriptedChat([plannedIn("it", 1_300)]);
        const metrics = fakeMetrics();
        const storedReplies = storedAnswerAt(0);
        const turns = service(chat, { metrics, storedReplies });

        const switching = start(turns, offered());
        await vi.advanceTimersByTimeAsync(1_655);
        await switching;
        const other = start(turns, followUp(true, { utterance: "E la domenica?" }));
        await vi.runAllTimersAsync();

        expect((await other).map(({ event }) => event)).toEqual([{ type: "outcome", outcome: { kind: "continue" } }]);
        expect(storedReplies.newestExchange).not.toHaveBeenCalled();
        expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }, { outcome: "mismatched" }]);
        expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([{ outcome: "unheld" }]);
        const repeat = start(turns, offered());
        await vi.runAllTimersAsync();
        expect(spokenText((await repeat).map(({ event }) => event))).toBe(answer);
        expect(chat.requests).toHaveLength(1);
      });

      it("speaks no earlier exchange's answer when the conversation's newest user message is not this utterance", async () => {
        const storedReplies = storedAnswerAt(0, "Ciao!");
        const elsewhere = service(scriptedChat([]), { storedReplies }, voiceWithItalianFallback);

        const spoken = start(elsewhere, followUp(true));
        await vi.runAllTimersAsync();

        expect((await spoken).filter(({ event }) => event.type === "speech")).toEqual([
          { atMs: 10_000, event: { type: "speech", text: "Scusa, puoi ripetere?", last: true } },
        ]);
      });

      it("stops reading the conversation once the caller is gone", async () => {
        const storedReplies = storedAnswerAt(null);
        const elsewhere = service(scriptedChat([]), { storedReplies });
        const hungUp = new AbortController();

        const spoken = collect(elsewhere.runTurn(followUp(true), new AbortController().signal, hungUp.signal));
        await vi.advanceTimersByTimeAsync(1_000);
        const readsBefore = storedReplies.newestExchange.mock.calls.length;
        hungUp.abort();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await spoken).toContainEqual({ type: "outcome", outcome: { kind: "continue" } });
        expect(storedReplies.newestExchange.mock.calls.length).toBe(readsBefore);
      });
    });

    it("speaks the session's switched turn for a follow-up that names another switch, and warns", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300)]);
      const logger = fakeLogger();
      const turns = service(chat, { logger });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const spoken = start(turns, followUp(true, { languageSwitchResult: { switchId: "switch-9", confirmed: true } }));
      await vi.runAllTimersAsync();

      expect(spokenText((await spoken).map(({ event }) => event))).toBe(answer);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId }),
        "Voice language switch follow-up names another switch than its session's; it speaks the session's switched turn",
      );
    });

    it("counts a follow-up overtaken before it spoke as unanswered, never confirmed", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300), plannedIn("it", 1_300)]);
      const metrics = fakeMetrics();
      const slowOwnership = { isHumanOwned: vi.fn(() => new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 200); })) };
      const turns = service(chat, { metrics, ownership: slowOwnership });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const followed = start(turns, followUp(true));
      await vi.advanceTimersByTimeAsync(100);
      const next = start(turns, offered({ utterance: "E la domenica?" }));
      await vi.runAllTimersAsync();
      await Promise.all([followed, next]);

      const switches = counted(metrics, "voice_language_switch_total");
      expect(switches.slice(0, 2)).toEqual([{ outcome: "emitted" }, { outcome: "unanswered" }]);
      expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([]);
    });

    it("measures the follow-up's turn limit and first speech from the switched turn's start", async () => {
      const chat = scriptedChat([plannedIn("it", 12_000)]);
      const metrics = fakeMetrics();
      const turns = service(chat, { metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const spoken = start(turns, followUp(true));
      await vi.runAllTimersAsync();

      expect((await spoken).filter(({ event }) => event.type === "speech")).toEqual([
        { atMs: 10_000 - 1_655, event: { type: "speech", text: "Sorry, could you ask me again?", last: true } },
      ]);
      expect(metrics.observeHistogram).toHaveBeenCalledWith("voice_turn_first_speech_ms", expect.objectContaining({ value: 10_000 }));
    });

    it("logs a reply that fails after the switch once, as the switched turn's failure", async () => {
      const logger = fakeLogger();
      const failingChat = {
        streamTurn: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
          yield { type: "conversation", conversationId };
          yield { type: "language", tag: "it" };
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          throw new Error("provider down");
        })(),
      };
      const turns = service(failingChat, { logger });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(550);
      await switching;
      const spoken = start(turns, followUp(true)).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await spoken).toBeInstanceOf(Error);
      expect(logger.warn.mock.calls.filter(([, message]) => message === "Voice turn failed")).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failed", languageSwitch: "confirmed" }),
        "Voice language switch follow-up ended with its switched turn's failure",
      );
    });

    it("asks for no switch once a newer request overtook the turn, or the runtime hung up on it, before its language came", async () => {
      for (const lose of ["overtaken", "hung up"] as const) {
        const chat = scriptedChat([plannedIn("it", 1_300), plannedIn("it", 1_300)]);
        const turns = service(chat);
        const hungUp = new AbortController();

        const switching = collect(turns.runTurn(offered(), new AbortController().signal, hungUp.signal));
        await vi.advanceTimersByTimeAsync(1_000);
        const newer = lose === "overtaken" ? start(turns, offered({ utterance: "E la domenica?" })) : null;
        if (lose === "hung up") hungUp.abort();
        await vi.runAllTimersAsync();
        await newer;

        expect((await switching).some((event) => event.type === "switchLanguage"), lose).toBe(false);
      }
    });

    it("ends a follow-up promptly with continue when a newer utterance overtakes it while the answer is still being written", async () => {
      const chat = scriptedChat([plannedIn("it", 20_000), plannedIn("it", 1_300)]);
      const turns = service(chat, { storedReplies: undefined });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      await switching;
      const followed = start(turns, followUp(true));
      await vi.advanceTimersByTimeAsync(500);
      const newer = start(turns, offered({ utterance: "E la domenica?" }));
      await vi.advanceTimersByTimeAsync(10);

      // The follow-up was waiting on the switched turn's reply; it ends without waiting for it.
      const ended = await followed;
      expect(ended.at(-1)).toEqual({ atMs: 500, event: { type: "outcome", outcome: { kind: "continue" } } });
      await vi.runAllTimersAsync();
      await newer;
    });

    it("keeps the call in the new language on the turn after a confirmed switch: no switch again, and its lines", async () => {
      const chat = scriptedChat([plannedIn("it")]);
      const turns = service(chat);

      const next = start(turns, offered({ utterance: "E la domenica?", turnLanguage: { tag: "it", source: "vendor_detected", isNew: false } }));
      await vi.runAllTimersAsync();
      const events = (await next).map(({ event }) => event);

      expect(events.some((event) => event.type === "switchLanguage")).toBe(false);
      expect(events).toContainEqual({ type: "bridge", text: "Controllo subito." });
      expect(spokenText(events)).toBe(answer);
      expect(chat.requests[0]).not.toHaveProperty("userExpectedLocale");
    });

    it("switches twice in one session, each switch spoken by its own follow-up", async () => {
      const english = "We are closed on Sundays.";
      const chat = scriptedChat([plannedIn("it", 1_300), plannedIn("en", 1_300, english)]);
      const ids = ["switch-1", "switch-2"];
      const metrics = fakeMetrics();
      const turns = service(chat, { metrics, newLanguageSwitchId: () => ids.shift() ?? "switch-x" });
      const italian = { tag: "it", source: "vendor_detected" as const, isNew: false };

      const first = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_655);
      expect((await first).map(({ event }) => event)).toContainEqual(switchEvent);
      const firstFollowUp = start(turns, followUp(true));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spokenText((await firstFollowUp).map(({ event }) => event))).toBe(answer);

      const second = start(turns, offered({ utterance: "Do you open on Sundays?", turnLanguage: italian }));
      await vi.advanceTimersByTimeAsync(1_655);
      expect((await second).map(({ event }) => event)).toContainEqual({ ...switchEvent, switchId: "switch-2", language: "en" });
      const secondFollowUp = start(turns, offered({
        utterance: "Do you open on Sundays?",
        languageSwitchResult: { switchId: "switch-2", confirmed: true },
        turnLanguage: { tag: "en", source: "vendor_detected", isNew: false },
      }));
      await vi.runAllTimersAsync();
      const spoken = (await secondFollowUp).map(({ event }) => event);

      // The answer was written before the follow-up came, so it is spoken at once.
      expect(spoken.map((event) => event.type)).toEqual(["conversation", "speech", "outcome"]);
      expect(spokenText(spoken)).toBe(english);
      expect(counted(metrics, "voice_language_switch_total")).toEqual([{ outcome: "emitted" }, { outcome: "emitted" }]);
      expect(counted(metrics, "voice_language_switch_followup_total")).toEqual([{ outcome: "confirmed" }, { outcome: "confirmed" }]);
    });

    it("counts the switch unanswered when the caller's next utterance comes first", async () => {
      const chat = scriptedChat([plannedIn("it", 1_300), plannedIn("it", 1_300)]);
      const metrics = fakeMetrics();
      const turns = service(chat, { metrics });

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(1_200);
      await switching;
      const next = start(turns, offered({ utterance: "E la domenica?" }));
      await vi.runAllTimersAsync();
      await next;

      expect(counted(metrics, "voice_language_switch_total").slice(0, 2)).toEqual([{ outcome: "emitted" }, { outcome: "unanswered" }]);
    });

    it("stores the part of the answer the follow-up's caller heard when they speak over it", async () => {
      const chat = scriptedChat([
        [
          { atMs: 0, event: { type: "conversation", conversationId } },
          { atMs: 100, event: { type: "language", tag: "it" } },
          { atMs: 700, event: { type: "chunk", text: "Apriamo alle nove. " } },
          { atMs: 5_000, event: { type: "chunk", text: "Chiudiamo alle sei." } },
          { atMs: 5_000, event: { ...done(), answer: "Apriamo alle nove. Chiudiamo alle sei." } as ChatStreamEvent },
        ],
        plannedIn("it", 300),
      ]);
      const turns = service(chat);

      const switching = start(turns, offered());
      await vi.advanceTimersByTimeAsync(650);
      await switching;
      const spoken = start(turns, followUp(true));
      await vi.advanceTimersByTimeAsync(1_000);
      const cutIn = start(turns, offered({ utterance: "E la domenica?", heardUntil: "Apriamo alle nove." }));
      await vi.runAllTimersAsync();
      await Promise.all([spoken, cutIn]);

      expect(chat.heardParts).toEqual([expect.objectContaining({ text: "Apriamo alle nove. ", heardCharacterCount: 18 })]);
    });
  });
});
