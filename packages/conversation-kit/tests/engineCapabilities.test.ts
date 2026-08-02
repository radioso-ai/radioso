import { describe, expect, it, vi } from "vitest";

import type {
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationEngine,
  ConversationModelGateway,
  ConversationRetrievalWorkPort,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  ConversationTurnInterpreter,
  ProcessTurnInput,
  ProcessTurnResult,
  SteeringResolver,
} from "@radioso/conversation-contract";

import { createConversationKit } from "../src/index.js";

// The recording engine short-circuits the turn, so the gateway is never called — it
// only has to satisfy the kit's requirement that a host supplies one.
const modelGateway: ConversationModelGateway = {
  complete: vi.fn(async () => ({ text: "unused" })),
};

const processTurnResult: ProcessTurnResult = {
  sessionId: "session_recorded",
  events: [],
  decision: { selected: [] },
  outcomes: [],
  response: { answer: "recorded" },
  trace: { traceId: "trace_recorded", startedAt: "2026-08-02T00:00:00.000Z", stages: [] },
};

const recordingEngine = (): { engine: ConversationEngine; input: () => ProcessTurnInput | undefined } => {
  let recordedInput: ProcessTurnInput | undefined;
  const engine = {
    processTurn: vi.fn(async (input: ProcessTurnInput) => {
      recordedInput = input;
      return processTurnResult;
    }),
  } as ConversationEngine;

  return { engine, input: () => recordedInput };
};

describe("conversation kit engine capabilities", () => {
  it("forwards each supplied engine capability to processTurn by identity", async () => {
    const steeringResolver = {} as SteeringResolver;
    const turnInterpreter = {} as ConversationTurnInterpreter;
    const retrievalWork = {} as ConversationRetrievalWorkPort;
    const routineReentryGate = {} as ConversationRoutineReentryGate;
    const routineSlotCorrection = {} as ConversationRoutineSlotCorrection;
    const clarifier = {} as ConversationClarifier;
    const clarificationStore = {} as ConversationClarificationStore;
    const recording = recordingEngine();
    const kit = createConversationKit({
      modelGateway,
      engine: recording.engine,
      steeringResolver,
      turnInterpreter,
      retrievalWork,
      routineReentryGate,
      routineSlotCorrection,
      clarifier,
      clarificationStore,
    });

    await kit.runTurn({ sessionId: "session_recorded", message: "Record the ports." });

    const input = recording.input();
    if (!input) {
      throw new Error("Expected the engine to receive a turn input.");
    }
    expect(input.steeringResolver).toBe(steeringResolver);
    expect(input.turnInterpreter).toBe(turnInterpreter);
    expect(input.retrievalWork).toBe(retrievalWork);
    expect(input.routineReentryGate).toBe(routineReentryGate);
    expect(input.routineSlotCorrection).toBe(routineSlotCorrection);
    expect(input.clarifier).toBe(clarifier);
    expect(input.clarificationStore).toBe(clarificationStore);
  });

  it("keeps omitted engine capability keys absent from processTurn input", async () => {
    const recording = recordingEngine();
    const kit = createConversationKit({ modelGateway, engine: recording.engine });

    await kit.runTurn({ sessionId: "session_recorded", message: "Record the defaults." });

    const input = recording.input();
    if (!input) {
      throw new Error("Expected the engine to receive a turn input.");
    }
    expect(input).not.toHaveProperty("steeringResolver");
    expect(input).not.toHaveProperty("turnInterpreter");
    expect(input).not.toHaveProperty("retrievalWork");
    expect(input).not.toHaveProperty("routineReentryGate");
    expect(input).not.toHaveProperty("routineSlotCorrection");
    expect(input).not.toHaveProperty("clarifier");
    expect(input).not.toHaveProperty("clarificationStore");
  });
});
