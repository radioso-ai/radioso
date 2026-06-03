import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { ConversationEvent, TurnOutcome } from "@radioso/conversation-contract";
import {
  AlwaysMatchDirectiveMatcher,
  InMemoryConversationRoutineStore,
  InMemoryConversationStores,
} from "../src/index.js";

describe("in-memory defaults with DefaultConversationEngine", () => {
  it("runs a full turn without backend or Postgres", async () => {
    const stores = new InMemoryConversationStores();
    await stores.appendEvent({
      sessionId: "session_1",
      kind: "message",
      role: "user",
      content: "Previous turn",
      createdAt: new Date(0).toISOString(),
    });

    const routineStore = new InMemoryConversationRoutineStore();
    const selector = {
      select: vi.fn(async () => ({
        selected: [{ skillName: "echo", input: { text: "hello" }, reason: "test" }],
        reason: "test selector",
      })),
    };
    const dispatcher = {
      dispatch: vi.fn(async ({ skill, turn }): Promise<TurnOutcome> => ({
        kind: "generic",
        skillName: skill.name,
        outcome: {
          status: "completed",
          answer: `Echo: ${turn.inputEvent.content}`,
          guidance: [{ action: "Keep the reply short." }],
        },
        stagedContext: [{ kind: "echo", data: { ok: true } }],
        steering: turn.steering,
        trace: {
          traceId: "skill-trace",
          startedAt: new Date(0).toISOString(),
          stages: [],
        },
      })),
    };
    const composer = {
      compose: vi.fn(async ({ outcomes }) => ({
        answer: outcomes[0]?.outcome.answer ?? "",
      })),
    };

    const result = await new DefaultConversationEngine().processTurn({
      agent: { id: "agent_1", name: "Assistant" },
      sessionId: "session_1",
      inputEvent: { id: "input_1", kind: "message", content: "hello" },
      skills: [{ name: "echo", description: "Echoes input" }],
      directives: [{
        name: "brief",
        condition: { kind: "always" },
        action: "Answer briefly.",
      }],
      stores,
      routineStore,
      modelGateway: { complete: vi.fn() },
      directiveMatcher: {
        match: async ({ directives }) =>
          new AlwaysMatchDirectiveMatcher().match({ turnContext: {}, directives }),
      },
      selector,
      dispatcher,
      composer,
    });

    expect(result.response.answer).toBe("Echo: hello");
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
    expect(selector.select).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        history: [expect.objectContaining({ content: "Previous turn" })],
        steering: [expect.objectContaining({ source: "directive", action: "Answer briefly." })],
      }),
    }));
    expect(stores.listEvents("session_1").map((event: ConversationEvent) => event.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });
});
