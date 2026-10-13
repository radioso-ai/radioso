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

/** The agent has voice turned off, so turns run as plain chat turns. */
const voiceOff = { agents: voiceProfiles(defaultAgentVoiceSettings()), routines: routineStates(false) };

const collect = async (events: AsyncIterable<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> => {
  const collected: VoiceTurnEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

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
    let clock = 1_000;
    const service = new VoiceTurnService({ ...voiceOff,
      sessions: fakeSessions(conversationId),
      chat,
      logger,
      now: () => (clock += 250),
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
      const second = collect(service.runTurn(input(), new AbortController().signal));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
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
      const second = collect(service.runTurn(input(), new AbortController().signal));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
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

    it("runs the turn without a bridge or a limit while voice is off", async () => {
      const agents = voiceProfiles({ ...voiceOn, enabled: false });
      const service = new VoiceTurnService({
        agents,
        routines: routineStates(false),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(9_000)),
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
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(2_000)),
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
        sessions: fakeSessions(null),
        chat: timedChat(slowReply(2_000)),
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
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(2_000)),
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
        value: 8_000,
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
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(9_000)),
        logger,
      });

      const events = await runWithClock(service);

      expect(events.at(-2)).toEqual({ type: "speech", text: "We open at nine.", last: true });
      expect(logger.warn).toHaveBeenCalledWith(
        { agentId, vendor: "elevenlabs", transport: "web", conversationId, result: "completed", durationMs: 9_000,
          speechPieceCount: 1, bridged: true, turnLimitReached: true, fallbackSpoken: false },
        "Voice turn reached the turn limit",
      );
    });

    it("counts a bridge the agent has no line for as unresolved and speaks nothing", async () => {
      const metrics = fakeMetrics();
      const service = new VoiceTurnService({
        agents: voiceProfiles(voiceOn, "de"),
        routines: routineStates(false),
        sessions: fakeSessions(conversationId),
        chat: timedChat(slowReply(2_000)),
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
        value: 2_000,
      }));
    });
  });
});
