import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  ConversationEvent,
  ProcessTurnInput,
  TurnOutcome,
} from "@radioso/conversation-contract";

const createInput = (overrides: Partial<ProcessTurnInput> = {}): ProcessTurnInput => {
  const events: ConversationEvent[] = [];
  return {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
    skills: [
      { name: "order.status", description: "Looks up order status", outcomeKinds: ["generic"] },
    ],
    directives: [
      {
        name: "be-brief",
        condition: { kind: "always" },
        action: "Keep the response concise.",
        priority: 10,
      },
    ],
    stores: {
      loadHistory: vi.fn().mockResolvedValue([{ role: "user", content: "Previous turn" }]),
      appendEvent: vi.fn(async (event: ConversationEvent) => {
        events.push(event);
      }),
    },
    modelGateway: {
      complete: vi.fn(),
    },
    directiveMatcher: {
      match: vi.fn(async ({ directives }) => [
        {
          directive: directives[0],
          selectionMode: "deterministic",
          selectionReason: "always",
        },
      ]),
    },
    selector: {
      select: vi.fn(async () => ({
        selected: [{ skillName: "order.status", input: { orderId: "A1" }, reason: "selected_by_test" }],
        reason: "test selector",
      })),
    },
    dispatcher: {
      dispatch: vi.fn(async ({ skill, turn, selected }): Promise<TurnOutcome> => ({
        kind: "generic",
        skillName: skill.name,
        outcome: {
          status: "completed",
          answer: "Your order ships tomorrow.",
          outputs: { orderId: selected.input },
          guidance: [{ action: "Mention shipment timing.", priority: 5 }],
        },
        stagedContext: [{ kind: "order", data: { status: "shipping" } }],
        steering: turn.steering,
        trace: {
          traceId: "skill-trace",
          startedAt: new Date(0).toISOString(),
          stages: [],
        },
      })),
    },
    composer: {
      compose: vi.fn(async ({ turn, outcomes }) => ({
        answer: outcomes[0]?.outcome.answer ?? "",
        metadata: {
          steeringCount: turn.steering.length,
          stagedContextCount: turn.stagedContext.length,
        },
      })),
    },
    ...overrides,
  };
};

describe("DefaultConversationEngine", () => {
  it("runs a pure gather-select-dispatch-compose turn through contract ports", async () => {
    const input = createInput();
    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.stores.loadHistory).toHaveBeenCalledWith({ sessionId: "session_1" });
    expect(input.directiveMatcher.match).toHaveBeenCalledWith({
      turn: expect.objectContaining({ sessionId: "session_1", steering: [] }),
      directives: input.directives,
    });
    expect(input.selector.select).toHaveBeenCalledWith({
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive", action: "Keep the response concise." })],
      }),
      skills: input.skills,
      directives: [expect.objectContaining({ selectionReason: "always" })],
    });
    expect(input.dispatcher.dispatch).toHaveBeenCalledWith({
      skill: input.skills[0],
      selected: expect.objectContaining({ skillName: "order.status" }),
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive" })],
      }),
    });
    expect(input.composer.compose).toHaveBeenCalledWith({
      turn: expect.objectContaining({
        stagedContext: [expect.objectContaining({ kind: "order" })],
        steering: [
          expect.objectContaining({ source: "directive" }),
          expect.objectContaining({ source: "skill", action: "Mention shipment timing." }),
        ],
      }),
      outcomes: [expect.objectContaining({ skillName: "order.status" })],
      decision: expect.objectContaining({
        steeringConsidered: [
          expect.objectContaining({ source: "directive" }),
          expect.objectContaining({ source: "skill" }),
        ],
      }),
    });
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
    expect(result.response.answer).toBe("Your order ships tomorrow.");
    expect(result.events).toHaveLength(2);
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });

  it("records a failed outcome when selection names an unregistered skill", async () => {
    const input = createInput({
      selector: {
        select: vi.fn(async () => ({
          selected: [{ skillName: "missing.skill" }],
        })),
      },
      composer: {
        compose: vi.fn(async ({ outcomes }) => ({
          answer: outcomes[0]?.outcome.error?.message ?? "",
        })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        skillName: "missing.skill",
        outcome: expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({ code: "skill_not_found" }),
        }),
      }),
    ]);
    expect(result.response.answer).toContain("missing.skill");
    expect(result.trace.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill_dispatch", status: "failed" }),
      ]),
    );
  });
});
