import { describe, expect, it, vi } from "vitest";

import type {
  ConversationEvent,
  ConversationInteractionRole,
  ProcessTurnInput,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";

import { DefaultConversationEngine } from "../src/index.js";

const roles = [
  "substantive_new",
  "substantive_followup",
  "clarification_value",
  "control",
  "social",
  "unresolved",
] as const satisfies readonly ConversationInteractionRole[];

const inputFor = (interactionRole: ConversationInteractionRole): ProcessTurnInput => ({
  agent: { id: "agent-1" },
  sessionId: "conversation-1",
  inputEvent: { id: "user-1", kind: "message", content: "sensitive visitor text" },
  skills: [{ name: "direct.answer" }],
  directives: [],
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async (_event: ConversationEvent) => undefined),
  },
  modelGateway: { complete: vi.fn() },
  directiveMatcher: { match: vi.fn(async () => []) },
  turnInterpreter: {
    interpret: vi.fn(async () => ({
      route: "direct",
      interactionRole,
      framing: { intentTopic: "private topic" },
      metadata: { semanticIntent: "private contextual intent" },
    })),
  },
  selector: {
    select: vi.fn(async ({ turn }: { turn: TurnContext }) => ({
      selected: [{ skillName: "direct.answer" }],
      reason: String(turn.metadata?.turnInterpretation ? "interpreted" : "missing"),
    })),
  },
  dispatcher: {
    dispatch: vi.fn(async ({ turn }: { turn: TurnContext }): Promise<TurnOutcome> => ({
      kind: "direct",
      skillName: "direct.answer",
      outcome: { status: "completed", answer: "ok" },
      stagedContext: [],
      steering: turn.steering,
      trace: { traceId: "dispatch", startedAt: new Date(0).toISOString(), stages: [] },
    })),
  },
  composer: { compose: vi.fn(async () => ({ answer: "ok" })) },
});

describe("conversation-engine interaction role propagation", () => {
  it.each(roles)("propagates %s structurally while tracing only the enum", async (interactionRole) => {
    const input = inputFor(interactionRole);
    const result = await new DefaultConversationEngine().processTurn(input);
    const selectedTurn = vi.mocked(input.selector.select).mock.calls[0]?.[0].turn;
    const traceOutput = result.trace.stages.find((stage) => stage.kind === "turn_interpretation")?.outputs;

    expect(selectedTurn?.metadata?.turnInterpretation).toMatchObject({ interactionRole });
    expect(traceOutput).toMatchObject({ interactionRole });
    expect(JSON.stringify(traceOutput)).not.toContain("private topic");
    expect(JSON.stringify(traceOutput)).not.toContain("private contextual intent");
    expect(JSON.stringify(traceOutput)).not.toContain("sensitive visitor text");
  });
});
