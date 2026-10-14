import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatStreamEvent } from "../../src/modules/chat/contracts/index.js";
import {
  defaultAgentVoiceSettings,
  type AgentVoiceSettings,
} from "../../src/modules/agents/public.js";
import type { VoiceTurnEvent, VoiceTurnInput } from "../../src/modules/voiceChannel/domain.js";
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

/** The agent has voice turned off, so turns run as plain chat turns. */
const voiceOff = {
  agents: voiceProfiles(defaultAgentVoiceSettings()),
  routines: routineStates(false),
  ownership: conversationOwnership(false),
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
      signal: expect.any(AbortSignal),
    }]);
    expect(chat.requests[0]).not.toHaveProperty("conversationId");
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

    it("runs the turn without a bridge or a limit while voice is off", async () => {
      const agents = voiceProfiles({ ...voiceOn, enabled: false });
      const service = new VoiceTurnService({
        agents,
        routines: routineStates(false),
        ownership: conversationOwnership(false),
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
        sessions: fakeSessions(null),
        chat: timedChat(slowReply(3_000)),
        logger: fakeLogger(),
      });

      const events = await runWithClock(service);

      expect(events).toContainEqual({ type: "bridge", text: "Let me check." });
      expect(routines.isRoutineActive).not.toHaveBeenCalled();
    });

    it("speaks in the request's locale ahead of the agent's default", async () => {
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "en"),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(3_000)),
        logger: fakeLogger(),
      });

      const events = await runWithClock(service, input({ locale: "it-IT" }));

      expect(events).toContainEqual({ type: "bridge", text: "Controllo subito." });
    });

    it("measures the turn and logs whether the bridge and the limit fired, with bounded labels only", async () => {
      const metrics = fakeMetrics();
      const logger = fakeLogger();
      const chat = timedChat(slowReply(12_000));
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
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
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(11_000)),
        logger,
      });

      const events = await runWithClock(service);

      expect(events.at(-2)).toEqual({ type: "speech", text: "We open at nine.", last: true });
      expect(logger.warn).toHaveBeenCalledWith(
        { agentId, vendor: "elevenlabs", transport: "web", conversationId, result: "completed", durationMs: 11_000,
          speechPieceCount: 1, outcome: "continue", bridged: true, turnLimitReached: true, fallbackSpoken: false },
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
    };
    const assistantMessageId = "66666666-6666-4666-8666-666666666666";

    type Step = { atMs: number; event: ChatStreamEvent };

    /**
     * Chat as the turn registry runs it for `latest_input_wins` turns: a newer turn on the
     * conversation cancels the one in flight, which ends with `cancelled` at its next step.
     */
    const supersedingChat = (scripts: Step[][]) => {
      const requests: VoiceChatTurnRequest[] = [];
      let newest = -1;
      return {
        requests,
        streamTurn: (request: VoiceChatTurnRequest) => {
          requests.push(request);
          const index = requests.length - 1;
          newest = index;
          const steps = scripts[index] ?? [];
          return (async function* (): AsyncGenerator<ChatStreamEvent> {
            const startedAt = Date.now();
            for (const step of steps) {
              const wait = startedAt + step.atMs - Date.now();
              if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
              if (newest !== index) {
                yield { type: "cancelled", conversationId, reason: "superseded", stage: "rendering" };
                return;
              }
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

    const fakeNotes = () => ({ replyInterrupted: vi.fn().mockResolvedValue(undefined), replyReplayed: vi.fn().mockResolvedValue(undefined) });
    const fakeMetrics = () => ({ observeHistogram: vi.fn(), incrementCounter: vi.fn() });

    const service = (chat: { streamTurn: (request: VoiceChatTurnRequest) => AsyncIterable<ChatStreamEvent> }, overrides: Partial<ConstructorParameters<typeof VoiceTurnService>[0]> = {}) =>
      new VoiceTurnService({
        agents: voiceProfiles(voiceOn),
        routines: routineStates(false),
        ownership: conversationOwnership(false),
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
      const superseded = logger.info.mock.calls.filter(([fields]) => (fields as { result?: string }).result === "superseded");
      expect(superseded).toHaveLength(2);
      expect(superseded[0]?.[0]).toEqual({
        agentId, vendor: "elevenlabs", transport: "web", conversationId, result: "superseded",
        supersededAt: "before_speech", durationMs: 150, speechPieceCount: 0, outcome: "continue",
      });
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
        expect(counted(metrics, "voice_reply_interrupted_total")).toEqual([{}]);
        expect(logger.info).toHaveBeenCalledWith(
          { agentId, vendor: "elevenlabs", conversationId, assistantMessageId, heardCharacterCount: 20, spokenCharacterCount: 30 },
          "Voice reply was interrupted",
        );
        expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/nine|Sundays/u);
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
  });
});
