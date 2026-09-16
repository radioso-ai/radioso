import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  ClarificationCandidate,
  Directive,
  DirectiveMatch,
  TurnContext,
} from "@radioso/conversation-contract";
import { attemptRoutine, attemptRoutineActivation } from "../src/routineActivation.js";

const coverageDirective: Directive = {
  name: "offer-form",
  condition: { kind: "always" },
  action: "Offer the contact form.",
  coverageCriteria: { coverage: ["unanswered"] },
};

const clarificationCandidates: ClarificationCandidate[] = [
  { id: "support", label: "Talk to support", confidence: 1, payload: { routineId: "support" } },
];

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

const baseInput = (overrides: Partial<AttemptRoutineInput> = {}): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  directives: [coverageDirective],
  directiveMatcher: {
    match: vi.fn(async ({ directives }): Promise<DirectiveMatch[]> => directives.map((directive) => ({
      directive,
      selectionMode: "deterministic" as const,
      selectionReason: "always",
    }))),
  },
  clarifier: {
    phraseQuestion: vi.fn(async () => "Would you like to talk to support?"),
    mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
  },
  clarificationStore: {
    loadPending: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  routineStore: {
    loadActive: vi.fn(async () => null),
    loadCompleted: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  routineRunner: {
    resume: vi.fn(async () => ({ response: { answer: "unused" }, nextState: null })),
  },
  routineActivator: {
    activate: vi.fn(async () => ({ kind: "clarify" as const, candidates: clarificationCandidates })),
  },
  ...overrides,
});

const renderedSteering = (input: AttemptRoutineInput) =>
  (input.clarifier!.phraseQuestion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].turn.steering as Array<Record<string, unknown>>;

describe("clarifier steering for a known coverage verdict (#1260 review round 3, Q3)", () => {
  it("drops a coverage-gated directive from the pre-retrieval clarification, which runs before any verdict can exist", async () => {
    const input = baseInput();

    await attemptRoutine(input);

    expect(input.clarifier!.phraseQuestion).toHaveBeenCalledOnce();
    expect(renderedSteering(input)).toEqual([]);
  });

  it("renders a matching coverage-gated directive as a plain instruction on the coverage-offer clarification", async () => {
    const turnContext = assessedTurn("unanswered");
    const input = baseInput({ turnContext, inputEventAlreadyAppended: true });

    await attemptRoutineActivation(input);

    const steering = renderedSteering(input);
    expect(steering).toHaveLength(1);
    expect(steering[0]).toMatchObject({ action: "Offer the contact form." });
    expect(steering[0]).not.toHaveProperty("coverageCriteria");
  });

  it("drops a non-matching coverage-gated directive from the coverage-offer clarification", async () => {
    const turnContext = assessedTurn("answered");
    const input = baseInput({ turnContext, inputEventAlreadyAppended: true });

    await attemptRoutineActivation(input);

    expect(renderedSteering(input)).toEqual([]);
  });
});
