import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineSkillDispatcher,
  ConversationModelGateway,
  Routine,
  RoutineState,
  SkillDefinition,
  TurnContext,
} from "@radioso/conversation-contract";

import {
  createConversationKit,
  createDefaultRoutineSkillDispatcher,
  type LocalSkillHandler,
  type LocalSkillHandlerInput,
  type RoutineRegistration,
} from "../src/index.js";

const signupRoutine: Routine = {
  id: "signup",
  rootStepId: "ask_name",
  steps: [
    { id: "ask_name", kind: "chat", action: "Ask the user for their name." },
    { id: "done", kind: "terminal", action: "Thank the user and end the routine." },
  ],
  transitions: [{ from: "ask_name", to: "done", condition: "the user provided their name" }],
};

// Branches on the default routine prompts so the routine runs deterministically:
// the next-step selector prompt asks for a JSON decision; the step renderer prompt
// asks for the user-facing message.
const routineGateway = (): ConversationModelGateway => ({
  complete: vi.fn(async ({ systemPrompt, messages }) => {
    const userMessage = String(messages.at(-1)?.content ?? "");
    if (systemPrompt?.includes("Return a JSON object")) {
      return userMessage.toLowerCase().includes("name is")
        ? { text: '{"condition": 1, "offTopic": false, "variables": {"name": "Sam"}}' }
        : { text: '{"condition": null, "offTopic": false, "variables": {}}' };
    }
    if (systemPrompt?.includes("Rank whether the latest user message wants to start any registered routine")) {
      return { text: '{"matches":[{"routineId":"signup","confidence":0.95}]}' };
    }
    if (systemPrompt?.includes("Write only the message to the user")) {
      return systemPrompt.includes("Ask the user for their name")
        ? { text: "What is your name?" }
        : { text: "Thanks, all set!" };
    }
    return { text: `fallback:${userMessage}` };
  }),
});

describe("conversation kit routines", () => {
  it("activates a registered routine, then resumes it to a terminal step across turns", async () => {
    const registration: RoutineRegistration = {
      routine: signupRoutine,
      trigger: {
        description: "The user wants to sign up.",
        priority: 0,
      },
    };
    const kit = createConversationKit({
      modelGateway: routineGateway(),
      routineRegistrations: [registration],
    });

    // The registered routine is authorable/listable.
    expect(kit.routines.map((routine) => routine.id)).toContain("signup");

    const first = await kit.runTurn({ sessionId: "s1", message: "I'd like to sign up" });
    expect(first.response.answer).toBe("What is your name?");

    const second = await kit.runTurn({ sessionId: "s1", message: "My name is Sam" });
    expect(second.response.answer).toBe("Thanks, all set!");
  });

  it("leaves turn behavior unchanged when no routine registrations are wired", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ messages }) => ({ text: `reply:${messages.at(-1)?.content ?? ""}` })),
    };
    const kit = createConversationKit({ modelGateway: gateway });

    const result = await kit.runTurn({ sessionId: "s2", message: "hello" });
    expect(result.response.answer).toBe("reply:hello");
  });
});

const orderLookupSkill: SkillDefinition = { name: "order_lookup" };

const recordingSkillHandler = (outputs: Record<string, unknown> = {}): {
  handler: LocalSkillHandler;
  calls: LocalSkillHandlerInput[];
} => {
  const calls: LocalSkillHandlerInput[] = [];
  const handler: LocalSkillHandler = async (input) => {
    calls.push(input);
    return { disposition: "settled", outcome: { status: "completed", outputs } };
  };
  return { handler, calls };
};

const orderStatusRoutine: Routine = {
  id: "order_status",
  rootStepId: "ask_order",
  steps: [
    { id: "ask_order", kind: "chat", action: "Ask the user for their order id." },
    {
      id: "run_lookup",
      kind: "skill",
      skillName: "order_lookup",
      inputBindings: { orderId: { kind: "variableRef", ref: "orderId" } },
      outputAssignments: { eta: "eta" },
    },
    { id: "done", kind: "terminal", action: "Tell the user the order arrives {{slot.eta}}." },
  ],
  transitions: [
    { from: "ask_order", to: "run_lookup", condition: "the user provided an order id" },
    { from: "run_lookup", to: "done", condition: "the lookup finished" },
  ],
};

const skillRoutineGateway = (routineId: string): ConversationModelGateway => ({
  complete: vi.fn(async ({ systemPrompt, messages }) => {
    const userMessage = String(messages.at(-1)?.content ?? "");
    if (systemPrompt?.includes("Return a JSON object")) {
      return userMessage.toLowerCase().includes("order is")
        ? { text: '{"condition": 1, "offTopic": false, "variables": {"orderId": "A-1"}}' }
        : { text: '{"condition": null, "offTopic": false, "variables": {}}' };
    }
    if (systemPrompt?.includes("Rank whether the latest user message wants to start any registered routine")) {
      return { text: `{"matches":[{"routineId":"${routineId}","confidence":0.95}]}` };
    }
    if (systemPrompt?.includes("Write only the message to the user")) {
      if (systemPrompt.includes("Ask the user for their order id")) {
        return { text: "What is your order id?" };
      }
      return { text: `rendered:${systemPrompt.includes("arrives tomorrow") ? "arrives tomorrow" : "no eta"}` };
    }
    return { text: `fallback:${userMessage}` };
  }),
});

describe("conversation kit routine skill steps", () => {
  it("runs a skill step against a local handler and assigns its outputs to routine variables", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const kit = createConversationKit({
      modelGateway: skillRoutineGateway("order_status"),
      skills: [orderLookupSkill],
      localSkills: new Map([["order_lookup", lookup.handler]]),
      routineRegistrations: [{
        routine: orderStatusRoutine,
        trigger: { description: "The user asks about an order.", priority: 0 },
      }],
    });

    const first = await kit.runTurn({ sessionId: "s_skill", message: "where is my order" });
    expect(first.response.answer).toBe("What is your order id?");

    const second = await kit.runTurn({ sessionId: "s_skill", message: "my order is A-1" });

    expect(lookup.calls).toHaveLength(1);
    expect(lookup.calls[0]?.input).toEqual({ orderId: "A-1" });
    // The assigned `eta` variable rendered into the terminal step's instruction.
    expect(second.response.answer).toBe("rendered:arrives tomorrow");
  });

  it("advances off a skill step naming an unregistered skill instead of throwing", async () => {
    const brokenRoutine: Routine = {
      id: "broken_lookup",
      rootStepId: "run_missing",
      steps: [
        { id: "run_missing", kind: "skill", skillName: "not_registered" },
        { id: "done", kind: "terminal", action: "Tell the user someone will follow up." },
      ],
      transitions: [{ from: "run_missing", to: "done", condition: "the skill finished" }],
    };
    const kit = createConversationKit({
      modelGateway: skillRoutineGateway("broken_lookup"),
      routineRegistrations: [{
        routine: brokenRoutine,
        trigger: { description: "The user asks about an order.", priority: 0 },
      }],
    });

    const result = await kit.runTurn({ sessionId: "s_missing", message: "where is my order" });

    expect(result.response.answer).toBe("rendered:no eta");
  });

  it("uses an explicitly supplied routine skill dispatcher instead of the default", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const dispatched: string[] = [];
    const routineSkillDispatcher: ConversationRoutineSkillDispatcher = {
      async dispatch({ skillName }) {
        dispatched.push(skillName);
        return { status: "completed", outputs: { eta: "tomorrow" } };
      },
    };
    const kit = createConversationKit({
      modelGateway: skillRoutineGateway("order_status"),
      skills: [orderLookupSkill],
      localSkills: new Map([["order_lookup", lookup.handler]]),
      routineSkillDispatcher,
      routineRegistrations: [{
        routine: orderStatusRoutine,
        trigger: { description: "The user asks about an order.", priority: 0 },
      }],
    });

    await kit.runTurn({ sessionId: "s_custom", message: "where is my order" });
    const second = await kit.runTurn({ sessionId: "s_custom", message: "my order is A-1" });

    expect(dispatched).toEqual(["order_lookup"]);
    expect(lookup.calls).toHaveLength(0);
    expect(second.response.answer).toBe("rendered:arrives tomorrow");
  });
});

describe("createDefaultRoutineSkillDispatcher", () => {
  const turnWithContextVariable = (): TurnContext => ({
    agent: { id: "agent_test", name: "Test" },
    sessionId: "s_dispatch",
    inputEvent: { id: "input_1", kind: "message", content: "look it up" },
    history: [],
    stagedContext: [
      {
        kind: "context_variable",
        id: "locale",
        data: { kind: "variable", value: "et-EE" },
        metadata: { variableName: "locale" },
      },
    ],
    steering: [],
  });

  const state = (variables: Record<string, unknown>): RoutineState => ({
    sessionId: "s_dispatch",
    routineId: "order_status",
    path: ["run_lookup"],
    variables,
    status: "active",
  });

  it("resolves literal, variableRef, and contextVariableRef bindings into the handler's args", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const dispatcher = createDefaultRoutineSkillDispatcher(
      new Map([["order_lookup", lookup.handler]]),
      [orderLookupSkill],
    );

    const result = await dispatcher.dispatch({
      skillName: "order_lookup",
      state: state({ orderId: "A-1" }),
      turn: turnWithContextVariable(),
      inputBindings: {
        channel: { kind: "literal", value: "chat" },
        orderId: { kind: "variableRef", ref: "orderId" },
        locale: { kind: "contextVariableRef", contextVariable: "locale" },
      },
    });

    expect(lookup.calls[0]?.input).toEqual({
      channel: "chat",
      orderId: "A-1",
      locale: "et-EE",
    });
    expect(result).toMatchObject({ status: "completed", outputs: { eta: "tomorrow" } });
  });

  it("hands an untyped step the routine's collected variables when it authors no bindings", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const dispatcher = createDefaultRoutineSkillDispatcher(
      new Map([["order_lookup", lookup.handler]]),
      [orderLookupSkill],
    );

    await dispatcher.dispatch({
      skillName: "order_lookup",
      state: state({ orderId: "A-1", email: "sam@example.com" }),
      turn: turnWithContextVariable(),
    });

    expect(lookup.calls[0]?.input).toEqual({ orderId: "A-1", email: "sam@example.com" });
  });

  it("degrades to a failed result when the skill is unknown or has no handler", async () => {
    const dispatcher = createDefaultRoutineSkillDispatcher(new Map(), [orderLookupSkill]);

    const unknown = await dispatcher.dispatch({
      skillName: "not_registered",
      state: state({}),
      turn: turnWithContextVariable(),
    });
    expect(unknown.status).toBe("failed");
    expect(unknown.outputs).toMatchObject({ skill: "not_registered", reason: "unknown_skill" });

    const noHandler = await dispatcher.dispatch({
      skillName: "order_lookup",
      state: state({}),
      turn: turnWithContextVariable(),
    });
    expect(noHandler.status).toBe("failed");
    expect(noHandler.outputs).toMatchObject({ skill: "order_lookup", reason: "local_skill_not_registered" });
  });

  it("degrades to a failed result when the handler rejects", async () => {
    const dispatcher = createDefaultRoutineSkillDispatcher(
      new Map<string, LocalSkillHandler>([["order_lookup", async () => {
        throw new Error("boom");
      }]]),
      [orderLookupSkill],
    );

    const result = await dispatcher.dispatch({
      skillName: "order_lookup",
      state: state({}),
      turn: turnWithContextVariable(),
    });

    expect(result.status).toBe("failed");
    expect(result.outputs).toMatchObject({ skill: "order_lookup", reason: "handler_error" });
  });
});
