import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  Directive,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { attemptRoutineActivation } from "../src/routineActivation.js";

const unansweredGatedDirective: Directive = {
  name: "offer-form",
  condition: { kind: "always" },
  action: "Offer the contact form.",
  coverageCriteria: { coverage: ["unanswered"] },
};

const answeredOnlyDirective: Directive = {
  name: "celebrate",
  condition: { kind: "always" },
  action: "Congratulate them on a full answer.",
  coverageCriteria: { coverage: ["answered"] },
};

const assessedTurn = (coverage: "unanswered" | "answered"): TurnContext => ({
  agent: { id: "agent_1" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
  history: [],
  stagedContext: [],
  steering: [],
  metadata: {
    answerCoverage: {
      availability: "assessed" as const,
      coverage,
      reason: coverage === "unanswered" ? "insufficient_evidence" as const : "sufficient_evidence" as const,
      schemaVersion: 1,
      producer: "answer_head" as const,
    },
  },
});

/**
 * `routineRunner.resume` is the real integration point that hands the routine
 * step's resolved steering to the renderer. This stub plays that role, capturing
 * whatever `resumeRoutine`'s steeringResolver actually hands it, the way a real
 * chat-step renderer would receive it.
 */
const baseInput = (
  directive: Directive,
  turnContext: TurnContext,
  captured: SteeringRule[][],
): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
  turnContext,
  inputEventAlreadyAppended: true,
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  directives: [directive],
  directiveMatcher: {
    match: vi.fn(async ({ directives }) => directives.map((matched) => ({
      directive: matched,
      selectionMode: "deterministic" as const,
      selectionReason: "always",
    }))),
  },
  routineStore: {
    loadActive: vi.fn(async () => null),
    loadCompleted: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  routineRunner: {
    resume: vi.fn(async ({ steeringResolver }) => {
      const steering = await steeringResolver!.resolve({
        step: { id: "greet", kind: "chat", action: "Greet them." },
        baseSteering: [],
        turn: turnContext,
      });
      captured.push(steering);
      return { response: { answer: "Let me help." }, nextState: null };
    }),
  },
  routineActivator: {
    activate: vi.fn(async () => ({ kind: "activate" as const, routineId: "support" })),
  },
});

describe("resumeRoutine steering for a known coverage verdict (#1260 F3)", () => {
  it("renders a matching coverage-gated directive on the activated routine's first step as a plain rule", async () => {
    const captured: SteeringRule[][] = [];
    const input = baseInput(unansweredGatedDirective, assessedTurn("unanswered"), captured);

    await attemptRoutineActivation(input);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0][0]).toMatchObject({ action: "Offer the contact form." });
    expect(captured[0][0]).not.toHaveProperty("coverageCriteria");
  });

  it("drops a non-matching coverage-gated directive from the activated routine's first step", async () => {
    const captured: SteeringRule[][] = [];
    const input = baseInput(answeredOnlyDirective, assessedTurn("unanswered"), captured);

    await attemptRoutineActivation(input);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual([]);
  });
});
