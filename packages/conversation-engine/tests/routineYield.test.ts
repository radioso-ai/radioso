import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationTraceStage,
  ProcessTurnInput,
  ProcessTurnStreamInput,
  RoutinePendingStep,
  RoutineState,
  RoutineTurnYield,
} from "@radioso/conversation-contract";

const activeState: RoutineState = {
  sessionId: "session_1",
  routineId: "booking",
  executionId: "run_1",
  path: ["ask_dates"],
  variables: { name: "Giulia" },
  status: "active",
};

const pendingStep: RoutinePendingStep = {
  stepId: "ask_dates",
  instruction: "Ask Giulia for the arrival and departure dates.",
  missingSlotKeys: ["arrival", "departure"],
};

const yieldingRunner = (): ConversationRoutineRunner => ({
  resume: vi.fn(async (): Promise<ConversationRoutineResumeResult> => ({
    yielded: true,
    response: { answer: "" },
    nextState: null,
    pendingStep,
  })),
});

const createInput = (overrides: Partial<ProcessTurnInput> = {}): ProcessTurnInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Is there parking?" },
  skills: [{ name: "retrieval.answer", outcomeKinds: ["generic"] }],
  directives: [],
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async () => {}),
  },
  modelGateway: { complete: vi.fn() },
  directiveMatcher: { match: vi.fn(async () => []) },
  selector: {
    select: vi.fn(async () => ({ selected: [{ skillName: "retrieval.answer" }], reason: "test" })),
  },
  dispatcher: {
    dispatch: vi.fn(async ({ skill, turn }) => ({
      kind: "generic",
      skillName: skill.name,
      outcome: { status: "completed" as const, answer: "Yes, there is free parking." },
      stagedContext: [],
      steering: turn.steering,
      trace: { traceId: "skill", startedAt: new Date(0).toISOString(), stages: [] },
    })),
  },
  composer: {
    compose: vi.fn(async ({ outcomes }) => ({ answer: outcomes[0]?.outcome.answer ?? "" })),
  },
  routineStore: {
    loadActive: vi.fn(async () => activeState),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  ...overrides,
});

const stageKinds = (stages: ConversationTraceStage[]): string[] => stages.map((entry) => entry.kind);

describe("routine yield", () => {
  it("tells the host which step the parked routine still waits on and claims nothing", async () => {
    const yielded = vi.fn();
    const input = createInput({ routineRunner: yieldingRunner() });

    const result = await new DefaultConversationEngine().attemptRoutine({
      ...input,
      routineYieldSink: { yielded },
    });

    expect(result).toBeNull();
    expect(yielded).toHaveBeenCalledExactlyOnceWith({
      routineId: "booking",
      executionId: "run_1",
      pendingStep,
    } satisfies RoutineTurnYield);
    expect(input.routineStore!.save).not.toHaveBeenCalled();
  });

  it("reports no yield when the routine claims the turn", async () => {
    const yielded = vi.fn();
    const input = createInput({
      routineRunner: {
        resume: vi.fn(async () => ({
          response: { answer: "Which dates would you like?" },
          nextState: activeState,
        })),
      },
    });

    const result = await new DefaultConversationEngine().attemptRoutine({
      ...input,
      routineYieldSink: { yielded },
    });

    expect(result?.response.answer).toBe("Which dates would you like?");
    expect(yielded).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records a yield the host already took and does not ask the routine again (stream: %s)",
    async (stream) => {
      const runner = yieldingRunner();
      const input = createInput({
        routineRunner: runner,
        routineYield: { routineId: "booking", executionId: "run_1", pendingStep },
      });

      let stages: ConversationTraceStage[];
      if (stream) {
        const streamInput: ProcessTurnStreamInput = {
          ...input,
          composer: {
            compose: vi.fn(),
            async *stream() {
              yield { type: "final" as const, response: { answer: "Yes, there is free parking." } };
            },
          },
        };
        let finalStages: ConversationTraceStage[] = [];
        for await (const event of new DefaultConversationEngine().processTurnStream(streamInput)) {
          if (event.type === "final") finalStages = event.result.trace.stages;
        }
        stages = finalStages;
      } else {
        stages = (await new DefaultConversationEngine().processTurn(input)).trace.stages;
      }

      expect(runner.resume).not.toHaveBeenCalled();
      expect(stageKinds(stages).slice(0, 3)).toEqual(["message", "gather", "routine_yield"]);
      const yieldStage = stages.find((entry) => entry.kind === "routine_yield");
      expect(yieldStage).toMatchObject({
        id: "routine_yield:booking",
        status: "skipped",
        outputs: {
          routineId: "booking",
          executionId: "run_1",
          stepId: "ask_dates",
          missingSlotKeys: ["arrival", "departure"],
        },
      });
      // Ids and slot keys only: the step instruction may carry captured values.
      expect(JSON.stringify(stages)).not.toContain("Giulia");
    },
  );

  it("records the yield of its own routine attempt on the turn it then answers", async () => {
    const input = createInput({ routineRunner: yieldingRunner() });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(result.response.answer).toBe("Yes, there is free parking.");
    expect(result.trace.stages.find((entry) => entry.kind === "routine_yield")).toMatchObject({
      outputs: { routineId: "booking", stepId: "ask_dates" },
    });
  });

  it("records no yield stage on a turn with no active routine", async () => {
    const input = createInput({
      routineRunner: yieldingRunner(),
      routineStore: {
        loadActive: vi.fn(async () => null),
        save: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(stageKinds(result.trace.stages)).not.toContain("routine_yield");
  });
});
