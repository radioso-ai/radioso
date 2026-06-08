import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine, DefaultRoutineRunner, DefaultSteeringResolver } from "../src/index.js";
import type {
  ConversationEvent,
  ConversationRoutineStepRenderer,
  ProcessTurnInput,
  Routine,
  RoutineState,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

const routine: Routine = {
  id: "contact",
  rootStepId: "ask_email",
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask the user for their email address." },
    { id: "ask_message", kind: "chat", action: "Ask the user for the message they want to send." },
  ],
  transitions: [
    { from: "ask_email", to: "ask_message", condition: "the user provided an email address" },
  ],
};

const activeState: RoutineState = {
  sessionId: "session_1",
  routineId: "contact",
  path: ["ask_email"],
  variables: {},
  status: "active",
};

const createRoutineInput = (
  overrides: Partial<ProcessTurnInput> = {},
  renderer?: ConversationRoutineStepRenderer,
): ProcessTurnInput => {
  const events: ConversationEvent[] = [];
  const stepRenderer: ConversationRoutineStepRenderer = renderer ?? {
    render: vi.fn(async ({ steering }) => ({
      answer: steering.map((rule) => rule.action).join(" | "),
      metadata: { steering },
    })),
  };

  return {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: "alex@example.com" },
    skills: [],
    directives: [
      {
        id: "directive_1",
        name: "warmth",
        condition: { kind: "always" },
        action: "Use a warm tone.",
        priority: 10,
        description: "Tone guidance",
      },
    ],
    stores: {
      loadHistory: vi.fn(async () => []),
      appendEvent: vi.fn(async (event: ConversationEvent) => {
        events.push(event);
      }),
    },
    modelGateway: { complete: vi.fn() },
    directiveMatcher: {
      match: vi.fn(async ({ directives }) => [
        {
          directive: directives[0]!,
          selectionMode: "deterministic",
          selectionReason: "always",
        },
      ]),
    },
    selector: { select: vi.fn(async () => ({ selected: [] })) },
    dispatcher: { dispatch: vi.fn() },
    composer: { compose: vi.fn(async ({ turn }) => ({ answer: turn.steering.map((rule) => rule.action).join(" | ") })) },
    routineStore: {
      loadActive: vi.fn(async () => activeState),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
    routineRunner: new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_message" })) },
      stepRenderer,
    ),
    ...overrides,
  };
};

describe("one steering-list pipeline", () => {
  it("resolves routine step steering with matched directive steering and traces directive_steering", async () => {
    const render = vi.fn(async ({ steering }) => ({
      answer: steering.map((rule: SteeringRule) => rule.action).join(" | "),
    }));
    const input = createRoutineInput({}, { render });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      steering: [
        expect.objectContaining({ source: "routine", action: "Ask the user for the message they want to send." }),
        expect.objectContaining({ source: "directive", action: "Use a warm tone." }),
      ],
    }));
    expect(result.response.answer).toBe("Ask the user for the message they want to send. | Use a warm tone.");
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "routine_resume",
      "directive_steering",
    ]);
    expect(result.trace.stages.at(-1)?.outputs).toMatchObject({
      matchCount: 1,
      candidateCount: 1,
      directives: [{ id: "directive_1", name: "warmth" }],
    });
    expect(result.trace.stages.at(-1)?.outputs?.directives).not.toEqual([
      expect.objectContaining({ action: "Use a warm tone." }),
    ]);
  });

  it("passes active routine and step ids to the directive matcher on routine turns", async () => {
    let capturedTurn: TurnContext | null = null;
    const input = createRoutineInput({
      directiveMatcher: {
        match: vi.fn(async ({ turn, directives }) => {
          capturedTurn = turn;
          return [{
            directive: directives[0]!,
            selectionMode: "deterministic",
            selectionReason: "always",
          }];
        }),
      },
    });

    await new DefaultConversationEngine().processTurn(input);

    expect(capturedTurn).toMatchObject({
      activeRoutineId: "contact",
      activeStepId: "ask_email",
    });
  });

  it("orders base routine steering first, then directive steering by priority, and dedups identical rules", () => {
    const base: SteeringRule = {
      action: "Ask the user for the message they want to send.",
      source: "routine",
      lifespan: "response",
    };
    const duplicateDirective: SteeringRule = {
      action: base.action,
      source: "directive",
      lifespan: "response",
      priority: 100,
    };
    const lowerPriorityDirective: SteeringRule = {
      action: "Use a warm tone.",
      source: "directive",
      lifespan: "response",
      priority: 1,
    };
    const higherPriorityDirective: SteeringRule = {
      action: "Confirm the email address.",
      source: "directive",
      lifespan: "response",
      priority: 50,
    };

    const resolved = new DefaultSteeringResolver().resolve(
      [base, lowerPriorityDirective, higherPriorityDirective, duplicateDirective],
      {
        turnContext: {
          agent: { id: "agent_1" },
          sessionId: "session_1",
          inputEvent: { kind: "message", content: "hello" },
          history: [],
          stagedContext: [],
          steering: [],
        },
      },
    );

    expect(resolved).toEqual([base, higherPriorityDirective, lowerPriorityDirective]);
  });

  it("keeps normal-turn directive steering unchanged while using the shared steering helper", async () => {
    const input = createRoutineInput({
      routineStore: undefined,
      routineRunner: undefined,
      selector: { select: vi.fn(async () => ({ selected: [], reason: "none" })) },
    });

    await new DefaultConversationEngine().processTurn(input);

    expect(input.selector.select).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive", action: "Use a warm tone." })],
      }),
      directives: [expect.objectContaining({ selectionReason: "always" })],
    }));
    expect(input.composer.compose).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive", action: "Use a warm tone." })],
      }),
    }));
  });
});
