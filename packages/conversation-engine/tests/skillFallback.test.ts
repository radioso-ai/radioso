import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  ConversationEvent,
  ConversationTraceStage,
  ProcessTurnInput,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  SelectedSkill,
  SkillDefinition,
  SkillOutcome,
  TurnOutcome,
} from "@radioso/conversation-contract";

const outcomeFor = (skillName: string, outcome: SkillOutcome): TurnOutcome => ({
  kind: "generic",
  skillName,
  outcome,
  stagedContext: [],
  steering: [],
  trace: { traceId: `${skillName}-trace`, startedAt: new Date(0).toISOString(), stages: [] },
});

const failedLookup: SkillOutcome = {
  status: "failed",
  error: { code: "suppressed_for_safe_test", message: "Skill effects are suppressed for this turn." },
};

/**
 * A turn whose selector binds `order.lookup` and names `retrieval.answer` as its fallback.
 * Each skill settles with the outcome the test hands it.
 */
const fallbackInput = (input: {
  outcomes: Record<string, SkillOutcome>;
  selected?: SelectedSkill;
  skills?: SkillDefinition[];
}): ProcessTurnInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
  skills: input.skills ?? [{ name: "order.lookup" }, { name: "retrieval.answer" }],
  directives: [],
  directiveMatcher: { match: vi.fn(async () => []) },
  stores: {
    loadHistory: vi.fn().mockResolvedValue([]),
    appendEvent: vi.fn(async (_event: ConversationEvent) => {}),
  },
  modelGateway: { complete: vi.fn() },
  selector: {
    select: vi.fn(async () => ({
      selected: [input.selected ?? {
        skillName: "order.lookup",
        reason: "directive:order-status",
        fallbackSkillName: "retrieval.answer",
      }],
    })),
  },
  dispatcher: {
    dispatch: vi.fn(async ({ skill }): Promise<TurnOutcome> => {
      const outcome = input.outcomes[skill.name];
      if (!outcome) {
        throw new Error(`no outcome scripted for ${skill.name}`);
      }
      return outcomeFor(skill.name, outcome);
    }),
  },
  composer: {
    compose: vi.fn(async ({ outcomes }) => ({ answer: outcomes[0]?.outcome.answer ?? "" })),
  },
});

const dispatchStages = (stages: ConversationTraceStage[]) => stages.filter((stage) => stage.kind === "skill_dispatch");

describe("DefaultConversationEngine skill fallback", () => {
  it("dispatches the fallback skill in place of a selected skill that settles without completing", async () => {
    const input = fallbackInput({
      outcomes: {
        "order.lookup": failedLookup,
        "retrieval.answer": { status: "completed", answer: "Grounded answer." },
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const fallbackSelection = vi.mocked(input.dispatcher.dispatch).mock.calls[1]?.[0].selected;
    expect(fallbackSelection).toEqual({
      skillName: "retrieval.answer",
      reason: "fallback",
      metadata: {
        fallbackFor: {
          skillName: "order.lookup",
          outcomeStatus: "failed",
          failureReason: "suppressed_for_safe_test",
        },
      },
    });
    // Outcomes are what compose renders, so the fallback's replaces the failed one.
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["retrieval.answer"]);
    expect(result.response.answer).toBe("Grounded answer.");
    expect(dispatchStages(result.trace.stages)).toEqual([
      expect.objectContaining({
        id: "dispatch:order.lookup",
        status: "fallback",
        outputs: {
          skillName: "order.lookup",
          outcomeStatus: "failed",
          guidanceCount: 0,
          failureReason: "suppressed_for_safe_test",
        },
      }),
      expect.objectContaining({
        id: "dispatch:retrieval.answer",
        status: "applied",
        outputs: {
          skillName: "retrieval.answer",
          outcomeStatus: "completed",
          guidanceCount: 0,
          fallbackFor: "order.lookup",
        },
      }),
    ]);
  });

  it("falls back on the streamed path too", async () => {
    const input: ProcessTurnStreamInput = {
      ...fallbackInput({
        outcomes: {
          "order.lookup": failedLookup,
          "retrieval.answer": { status: "completed", answer: "Grounded answer." },
        },
      }),
      composer: {
        compose: vi.fn(),
        async *stream({ outcomes }) {
          yield { type: "final", response: { answer: outcomes[0]?.outcome.answer ?? "" } };
        },
      },
    };
    const events: ProcessTurnStreamEvent[] = [];

    for await (const event of new DefaultConversationEngine().processTurnStream(input)) {
      events.push(event);
    }

    const final = events.find((event) => event.type === "final");
    if (!final || final.type !== "final") {
      throw new Error("expected a final event");
    }
    expect(final.result.outcomes.map((outcome) => outcome.skillName)).toEqual(["retrieval.answer"]);
    expect(final.result.response.answer).toBe("Grounded answer.");
  });

  it("keeps a completed outcome and records no failure reason", async () => {
    const input = fallbackInput({
      outcomes: { "order.lookup": { status: "completed", answer: "Order 1 ships tomorrow." } },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["order.lookup"]);
    expect(dispatchStages(result.trace.stages)[0]?.outputs).toEqual({
      skillName: "order.lookup",
      outcomeStatus: "completed",
      guidanceCount: 0,
    });
  });

  it("records the failure reason on the dispatch stage when no fallback is named", async () => {
    const input = fallbackInput({
      outcomes: { "order.lookup": failedLookup },
      selected: { skillName: "order.lookup" },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["order.lookup"]);
    expect(dispatchStages(result.trace.stages)).toEqual([
      expect.objectContaining({
        status: "fallback",
        outputs: expect.objectContaining({ failureReason: "suppressed_for_safe_test" }),
      }),
    ]);
  });

  it.each([
    {
      name: "the fallback is not registered",
      selected: { skillName: "order.lookup", fallbackSkillName: "retrieval.missing" },
      skills: [{ name: "order.lookup" }, { name: "retrieval.answer" }],
    },
    {
      name: "the fallback declares input fields",
      selected: { skillName: "order.lookup", fallbackSkillName: "retrieval.answer" },
      skills: [
        { name: "order.lookup" },
        { name: "retrieval.answer", inputSchema: { fields: [{ name: "topic", type: "string" as const, required: true }] } },
      ],
    },
    {
      name: "the fallback names the selected skill itself",
      selected: { skillName: "order.lookup", fallbackSkillName: "order.lookup" },
      skills: [{ name: "order.lookup" }, { name: "retrieval.answer" }],
    },
  ])("keeps the failed outcome when $name", async ({ selected, skills }) => {
    const input = fallbackInput({
      outcomes: {
        "order.lookup": failedLookup,
        "retrieval.answer": { status: "completed", answer: "Grounded answer." },
      },
      selected,
      skills,
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["order.lookup"]);
    expect(dispatchStages(result.trace.stages)).toHaveLength(1);
  });

  it("does not fall back again when the fallback itself settles without completing", async () => {
    const input = fallbackInput({
      outcomes: {
        "order.lookup": failedLookup,
        "retrieval.answer": { status: "failed", error: { code: "retrieval_unavailable", message: "Retrieval failed." } },
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["retrieval.answer"]);
    expect(dispatchStages(result.trace.stages).map((stage) => stage.outputs)).toEqual([
      expect.objectContaining({ skillName: "order.lookup", failureReason: "suppressed_for_safe_test" }),
      expect.objectContaining({
        skillName: "retrieval.answer",
        failureReason: "retrieval_unavailable",
        fallbackFor: "order.lookup",
      }),
    ]);
  });
});
