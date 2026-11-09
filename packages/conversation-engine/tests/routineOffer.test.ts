import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  ClarificationCandidate,
  ConversationClarificationStore,
  ConversationRoutineActivator,
  ConversationRoutineOfferMemory,
  ConversationTraceStage,
  PendingClarification,
  ProcessTurnInput,
  RoutineActivationNotice,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "../src/index.js";
import { resolvePendingClarification } from "../src/clarification.js";
import { attemptRoutine, attemptRoutineActivation } from "../src/routineActivation.js";

const dates = { arrival: "2027-03-08", departure: "2027-03-10" };

const bookingCandidate: ClarificationCandidate = {
  id: "room_booking",
  label: "Room booking",
  description: "The visitor wants to book a room.",
  confidence: 0.9,
  payload: { routineId: "room_booking", variables: dates },
};

/** A ranked pick of the room-booking routine, as the registry reports it. */
const rankedActivator = (pick: { startMode?: "automatic" | "offer"; directRequest?: boolean }): ConversationRoutineActivator => ({
  activate: vi.fn(async () => ({
    kind: "activate" as const,
    routineId: "room_booking",
    variables: dates,
    decisionMetadata: {
      consideredCandidates: [bookingCandidate],
      decision: { kind: "auto_pick" as const, candidate: bookingCandidate, reason: "clear_margin" as const },
      reason: "clear_margin",
    },
    ...pick,
  })),
});

/** The activator a host builds from an accepted offer's candidate. */
const acceptedOfferActivator = (candidate: ClarificationCandidate): ConversationRoutineActivator => ({
  activate: vi.fn(async () => {
    const payload = candidate.payload as { routineId: string; variables?: Record<string, unknown> };
    return { kind: "activate" as const, routineId: payload.routineId, variables: payload.variables };
  }),
});

const memoryOf = (offered: string[] = []): ConversationRoutineOfferMemory & {
  recordOffered: ReturnType<typeof vi.fn>;
} => ({
  loadOffered: vi.fn(async () => offered),
  recordOffered: vi.fn(async () => {}),
});

const clarificationStoreOf = (pending: PendingClarification | null = null): ConversationClarificationStore & {
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  loadPending: vi.fn(async () => pending),
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
});

const startedRunner = () => ({
  resume: vi.fn(async (input: { state: RoutineState }) => ({
    response: { answer: "Which room type would you like?" },
    nextState: { ...input.state, path: ["ask_room"] },
  })),
});

const attemptInput = (overrides: Partial<AttemptRoutineInput> = {}): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: {
    id: "input_1",
    kind: "message",
    content: "I'd like to come 8-10 March, is there a single room and what does it cost?",
  },
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  routineStore: {
    loadActive: vi.fn(async () => null),
    loadCompleted: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  routineRunner: startedRunner(),
  clarifier: { phraseQuestion: vi.fn(), mapReply: vi.fn() },
  ...overrides,
});

const clarificationOutputs = (stages: ConversationTraceStage[]) =>
  stages.filter((stage) => stage.kind === "clarification").map((stage) => stage.outputs);

const startedVariables = (input: AttemptRoutineInput): Record<string, unknown> | undefined => {
  const resume = vi.mocked(input.routineRunner!.resume);
  return (resume.mock.calls[0]?.[0] as { state: RoutineState } | undefined)?.state.variables;
};

describe("Offer-first routine activation", () => {
  it("starts the routine when the visitor directly asks for it, and the trace says so", async () => {
    const input = attemptInput({
      routineActivator: rankedActivator({ startMode: "offer", directRequest: true }),
      routineOfferMemory: memoryOf(),
      clarificationStore: clarificationStoreOf(),
    });

    const result = await attemptRoutine(input);

    expect(result?.routineExecution?.routineId).toBe("room_booking");
    expect(startedVariables(input)).toEqual(dates);
    expect(clarificationOutputs(result!.trace.stages)).toEqual([
      expect.objectContaining({ decision: "auto_picked", chosenCandidateId: "room_booking", startedBy: "direct_request" }),
    ]);
  });

  it("offers instead of starting when the visitor is exploring, and leaves the turn to the answer", async () => {
    const store = clarificationStoreOf();
    const memory = memoryOf();
    const noticed = vi.fn<(notice: RoutineActivationNotice) => void>();
    const input = attemptInput({
      routineActivator: rankedActivator({ startMode: "offer", directRequest: false }),
      routineOfferMemory: memory,
      clarificationStore: store,
      routineActivationSink: { noticed },
    });

    const result = await attemptRoutine(input);

    expect(result).toBeNull();
    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: "session_1",
      source: "routine_activation",
      mode: "offer",
      status: "pending",
      candidates: [bookingCandidate],
    }));
    const saved = store.save.mock.calls[0][0] as PendingClarification;
    expect(new Date(saved.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
    expect(memory.recordOffered).toHaveBeenCalledExactlyOnceWith({ sessionId: "session_1", routineId: "room_booking" });
    const notice = noticed.mock.calls[0][0];
    expect(notice).toMatchObject({
      sessionId: "session_1",
      inputEventId: "input_1",
      offer: { routineId: "room_booking", label: "Room booking", description: "The visitor wants to book a room." },
    });
    expect(clarificationOutputs(notice.stages)).toEqual([
      expect.objectContaining({ surface: "routine_activation", decision: "offered", chosenCandidateId: "room_booking" }),
    ]);
  });

  it("records the offer on the answered turn's trace when the host hands the notice back", async () => {
    const noticed = vi.fn<(notice: RoutineActivationNotice) => void>();
    await attemptRoutine(attemptInput({
      routineActivator: rankedActivator({ startMode: "offer" }),
      routineOfferMemory: memoryOf(),
      clarificationStore: clarificationStoreOf(),
      routineActivationSink: { noticed },
    }));
    const compose = vi.fn(async () => ({ answer: "Single rooms are available from 8 March. Would you like me to book one?" }));
    const turnInput: ProcessTurnInput = {
      ...attemptInput(),
      skills: [{ name: "retrieval.answer", outcomeKinds: ["generic"] }],
      directives: [],
      modelGateway: { complete: vi.fn() },
      directiveMatcher: { match: vi.fn(async () => []) },
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "retrieval.answer" }], reason: "test" })) },
      dispatcher: {
        dispatch: vi.fn(async ({ skill }) => ({
          kind: "generic",
          skillName: skill.name,
          outcome: { status: "completed" as const, answer: "Single rooms are available." },
          stagedContext: [],
          steering: [],
          trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
        })),
      },
      composer: { compose },
      routineActivationNotice: noticed.mock.calls[0][0],
    };

    const result = await new DefaultConversationEngine().processTurn(turnInput);

    expect(compose).toHaveBeenCalled();
    expect(clarificationOutputs(result.trace.stages)).toEqual([
      expect.objectContaining({ decision: "offered", chosenCandidateId: "room_booking" }),
    ]);
  });

  it("does not offer again in a conversation that already had the offer", async () => {
    const store = clarificationStoreOf();
    const memory = memoryOf(["room_booking"]);
    const noticed = vi.fn<(notice: RoutineActivationNotice) => void>();
    const input = attemptInput({
      routineActivator: rankedActivator({ startMode: "offer", directRequest: false }),
      routineOfferMemory: memory,
      clarificationStore: store,
      routineActivationSink: { noticed },
    });

    expect(await attemptRoutine(input)).toBeNull();
    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(memory.recordOffered).not.toHaveBeenCalled();
    const notice = noticed.mock.calls[0][0];
    expect(notice.offer).toBeUndefined();
    expect(clarificationOutputs(notice.stages)).toEqual([
      expect.objectContaining({ decision: "none", reason: "already_offered", chosenCandidateId: "room_booking" }),
    ]);
  });

  it("still starts an already-offered routine on a later clear request", async () => {
    const input = attemptInput({
      inputEvent: { id: "input_3", kind: "message", content: "I want to book a room for 8-10 March" },
      routineActivator: rankedActivator({ startMode: "offer", directRequest: true }),
      routineOfferMemory: memoryOf(["room_booking"]),
      clarificationStore: clarificationStoreOf(),
    });

    const result = await attemptRoutine(input);

    expect(result?.routineExecution?.routineId).toBe("room_booking");
  });

  it("starts an automatic routine on a ranked pick whatever the ranker says about the request", async () => {
    for (const startMode of ["automatic", undefined] as const) {
      const store = clarificationStoreOf();
      const input = attemptInput({
        routineActivator: rankedActivator({ ...(startMode ? { startMode } : {}), directRequest: false }),
        routineOfferMemory: memoryOf(),
        clarificationStore: store,
      });

      const result = await attemptRoutine(input);

      expect(result?.routineExecution?.routineId).toBe("room_booking");
      expect(store.save).not.toHaveBeenCalled();
      expect(clarificationOutputs(result!.trace.stages)[0]).not.toHaveProperty("startedBy");
    }
  });

  it("neither offers nor starts when the host wired no place to keep the offer", async () => {
    const input = attemptInput({
      routineActivator: rankedActivator({ startMode: "offer", directRequest: false }),
      clarificationStore: clarificationStoreOf(),
    });

    expect(await attemptRoutine(input)).toBeNull();
    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
  });

  it("starts on the post-evidence coverage pass, which makes no offers", async () => {
    const input = attemptInput({
      routineActivator: rankedActivator({ startMode: "offer", directRequest: false }),
      routineOfferMemory: memoryOf(),
      clarificationStore: clarificationStoreOf(),
    });

    const result = await attemptRoutineActivation(input);

    expect(result?.routineExecution?.routineId).toBe("room_booking");
  });
});

describe("a reply to a routine offer", () => {
  const offerRow = (): PendingClarification => ({
    sessionId: "session_1",
    source: "routine_activation",
    originalQuery: "I'd like to come 8-10 March, is there a single room and what does it cost?",
    mode: "offer",
    candidates: [bookingCandidate],
    status: "pending",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  const replyTurn = (content: string): TurnContext => ({
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_2", kind: "message", content },
    history: [],
    stagedContext: [],
    steering: [],
  });

  it("starts the offered routine on acceptance, holding the dates the visitor already gave", async () => {
    const mapReply = vi.fn(async () => ({ kind: "chosen" as const, id: "room_booking" }));
    const resolution = await resolvePendingClarification({
      store: clarificationStoreOf(offerRow()),
      clarifier: { phraseQuestion: vi.fn(), mapReply },
      turn: replyTurn("yes please"),
    });

    expect(mapReply).toHaveBeenCalledWith(expect.objectContaining({ mode: "offer", source: "routine_activation" }));
    expect(resolution).toMatchObject({ outcome: "resolved", mappingOutcome: "accepted" });
    const input = attemptInput({
      inputEvent: { id: "input_2", kind: "message", content: "yes please" },
      routineActivator: acceptedOfferActivator(resolution.chosen!.candidate),
      clarificationMappingStage: resolution.mappingStage,
      routineOfferMemory: memoryOf(["room_booking"]),
      clarificationStore: clarificationStoreOf(),
    });

    const result = await attemptRoutine(input);

    expect(result?.routineExecution?.routineId).toBe("room_booking");
    expect(startedVariables(input)).toEqual(dates);
    expect(clarificationOutputs(result!.trace.stages)).toEqual([
      expect.objectContaining({ surface: "routine_activation", decision: "mapped", mappingOutcome: "accepted", chosenCandidateId: "room_booking" }),
    ]);
  });

  it.each([
    ["declined", { kind: "declined" as const }, "no thanks"],
    ["ignored", { kind: "unrelated" as const }, "Is there parking near the house?"],
  ])("starts nothing when the visitor %s the offer, and records it on the turn", async (outcome, mapping, reply) => {
    const resolution = await resolvePendingClarification({
      store: clarificationStoreOf(offerRow()),
      clarifier: { phraseQuestion: vi.fn(), mapReply: vi.fn(async () => mapping) },
      turn: replyTurn(reply),
    });

    expect(resolution).toMatchObject({ resolvedPending: true, mappingOutcome: outcome });
    expect(resolution.chosen).toBeUndefined();
    const noticed = vi.fn<(notice: RoutineActivationNotice) => void>();
    const store = clarificationStoreOf();
    const input = attemptInput({
      inputEvent: { id: "input_2", kind: "message", content: reply },
      routineActivator: rankedActivator({ startMode: "offer", directRequest: false }),
      clarificationMappingStage: resolution.mappingStage,
      routineOfferMemory: memoryOf(["room_booking"]),
      clarificationStore: store,
      routineActivationSink: { noticed },
    });

    expect(await attemptRoutine(input)).toBeNull();
    expect(store.save).not.toHaveBeenCalled();
    expect(clarificationOutputs(noticed.mock.calls[0][0].stages)).toEqual([
      expect.objectContaining({ decision: "mapped", mappingOutcome: outcome, candidates: [expect.objectContaining({ id: "room_booking" })] }),
      expect.objectContaining({ decision: "none", reason: "already_offered" }),
    ]);
  });
});
