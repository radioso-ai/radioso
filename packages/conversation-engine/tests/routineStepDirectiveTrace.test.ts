import { describe, expect, it, vi } from "vitest";

import type {
  AttemptRoutineInput,
  ConversationTraceStage,
  Directive,
  RoutineStep,
  RoutineStepSteeringTrace,
  TurnContext,
} from "@radioso/conversation-contract";
import { attemptRoutine } from "../src/routineActivation.js";

const handoffDirective: Directive = {
  id: "directive-handoff",
  name: "hand-off-to-a-person",
  condition: { kind: "always" },
  action: "For accommodation, refunds, or complaints, tell the visitor to call reception.",
};

const toneDirective: Directive = {
  id: "directive-tone",
  name: "formal-register",
  condition: { kind: "always" },
  action: "Use the formal register.",
};

const suggestionDirective: Directive = {
  id: "directive-suggestions",
  name: "suggest-programs",
  condition: { kind: "always" },
  action: "Suggest upcoming programs.",
  surfaces: ["suggested_questions"],
};

const unansweredOnlyDirective: Directive = {
  id: "directive-unanswered",
  name: "offer-form",
  condition: { kind: "always" },
  action: "Offer the contact form.",
  coverageCriteria: { coverage: ["unanswered"] },
};

const contactStep: RoutineStep = { id: "contact", kind: "chat", action: "Ask for the visitor's name and email." };

const turnContext: TurnContext = {
  agent: { id: "agent_1" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Vorrei prenotare una camera." },
  history: [],
  stagedContext: [],
  steering: [],
};

const routineInput = (directives: Directive[]): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: turnContext.inputEvent,
  turnContext,
  inputEventAlreadyAppended: true,
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  directives,
  directiveMatcher: {
    match: vi.fn(async ({ directives: eligible }: { directives: Directive[] }) => eligible.map((directive) => ({
      directive,
      selectionMode: "deterministic" as const,
      selectionReason: "always",
    }))),
  },
  routineStore: {
    loadActive: vi.fn(async () => ({
      sessionId: "session_1",
      routineId: "book-accommodation",
      path: ["dates", "contact"],
      variables: {},
      status: "active" as const,
    })),
    loadCompleted: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  // Plays the runner: resolves the landed step's steering the way a real chat step does.
  routineRunner: {
    resume: vi.fn(async ({ steeringResolver }) => {
      await steeringResolver!.resolve({
        step: contactStep,
        baseSteering: [{ action: contactStep.action!, source: "routine", lifespan: "response" }],
        turn: turnContext,
      });
      return {
        response: { answer: "Posso avere il suo nome e la sua email?" },
        nextState: {
          sessionId: "session_1",
          routineId: "book-accommodation",
          path: ["dates", "contact"],
          variables: {},
          status: "active" as const,
        },
      };
    }),
  },
});

const directiveStage = (stages: ConversationTraceStage[]): ConversationTraceStage => {
  const stage = stages.find((candidate) => candidate.kind === "directive_steering");
  if (!stage) {
    throw new Error("routine turn recorded no directive_steering stage");
  }
  return stage;
};

const routineStepOutputs = (stages: ConversationTraceStage[]): RoutineStepSteeringTrace =>
  directiveStage(stages).outputs?.routineStep as RoutineStepSteeringTrace;

describe("routine step directive trace (#1351)", () => {
  it("records which directives steered the step and that the step instruction controlled them", async () => {
    const result = await attemptRoutine(routineInput([handoffDirective, toneDirective]));

    expect(routineStepOutputs(result!.trace.stages)).toEqual({
      routineId: "book-accommodation",
      stepId: "contact",
      directivesAppliedAs: "subordinate_to_step_instruction",
      steeringDirectives: [
        { id: "directive-handoff", name: "hand-off-to-a-person" },
        { id: "directive-tone", name: "formal-register" },
      ],
    });
  });

  it("names directives without copying their text into the routine step record", async () => {
    const result = await attemptRoutine(routineInput([handoffDirective]));

    expect(JSON.stringify(routineStepOutputs(result!.trace.stages))).not.toContain(handoffDirective.action);
  });

  it("lists only directives that reached the step reply", async () => {
    // A rule for the follow-up-question generator never reaches the step reply, and a
    // coverage-gated rule with no verdict on the turn is dropped before rendering.
    const result = await attemptRoutine(routineInput([toneDirective, suggestionDirective, unansweredOnlyDirective]));

    expect(routineStepOutputs(result!.trace.stages).steeringDirectives).toEqual([
      { id: "directive-tone", name: "formal-register" },
    ]);
  });

  it("records the step with an empty directive list when no directive steered it", async () => {
    const result = await attemptRoutine(routineInput([]));

    expect(routineStepOutputs(result!.trace.stages)).toMatchObject({
      stepId: "contact",
      steeringDirectives: [],
    });
  });
});
