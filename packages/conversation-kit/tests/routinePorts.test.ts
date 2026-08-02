import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationRoutineNextStepSelector,
  ConversationRoutineRunner,
  ConversationRoutineStepRenderer,
  ConversationRoutineStore,
  Routine,
  RoutineState,
} from "@radioso/conversation-contract";
import { InMemoryConversationRoutineStore } from "@radioso/conversation-defaults";

import { createConversationKit, type RoutineRegistration } from "../src/index.js";

const signupRoutine: Routine = {
  id: "signup",
  rootStepId: "ask_name",
  steps: [
    { id: "ask_name", kind: "chat", action: "Ask the user for their name." },
    { id: "done", kind: "terminal", action: "Thank the user and end the routine." },
  ],
  transitions: [{ from: "ask_name", to: "done", condition: "the user provided their name" }],
};

const activeSignupState = (sessionId: string): RoutineState => ({
  sessionId,
  routineId: signupRoutine.id,
  path: ["ask_name"],
  variables: {},
  status: "active",
});

const routineGateway = (): ConversationModelGateway => ({
  complete: vi.fn(async ({ systemPrompt, messages }) => {
    const userMessage = String(messages.at(-1)?.content ?? "");
    // `condition` is a 1-based index into the step's transitions, null when none holds,
    // so the routine only leaves `ask_name` once the user has actually given a name.
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

const recordingRoutineStore = (active: RoutineState | null): ConversationRoutineStore & {
  loadActive: ReturnType<typeof vi.fn>;
  loadCompleted: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  loadActive: vi.fn(async () => active),
  loadCompleted: vi.fn(async () => []),
  save: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
});

describe("conversation kit routine ports", () => {
  it("reads and writes through a supplied routine store instead of the in-memory default", async () => {
    const sessionId = "s_supplied_store";
    const routineStore = recordingRoutineStore(activeSignupState(sessionId));
    const defaultLoadActive = vi.spyOn(InMemoryConversationRoutineStore.prototype, "loadActive");
    const defaultSave = vi.spyOn(InMemoryConversationRoutineStore.prototype, "save");
    const kit = createConversationKit({
      modelGateway: routineGateway(),
      routines: [signupRoutine],
      routineStore,
    });

    const result = await kit.runTurn({ sessionId, message: "My name is Sam" });

    expect(result.response.answer).toBe("Thanks, all set!");
    expect(routineStore.loadActive).toHaveBeenCalledWith({ sessionId });
    expect(routineStore.save).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      routineId: "signup",
      status: "completed",
    }));
    expect(defaultLoadActive).not.toHaveBeenCalled();
    expect(defaultSave).not.toHaveBeenCalled();
  });

  it("uses supplied routine selector and renderer with the default runner", async () => {
    const sessionId = "s_supplied_selector_renderer";
    const routineStore = recordingRoutineStore(activeSignupState(sessionId));
    const routineSelector: ConversationRoutineNextStepSelector = {
      select: vi.fn(async () => ({ nextStepId: "done" })),
    };
    const routineRenderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async ({ step }) => ({ answer: `rendered:${step.id}` })),
    };
    const kit = createConversationKit({
      modelGateway: routineGateway(),
      routines: [signupRoutine],
      routineStore,
      routineSelector,
      routineRenderer,
    });

    const result = await kit.runTurn({ sessionId, message: "My name is Sam" });

    expect(result.response.answer).toBe("rendered:done");
    expect(routineSelector.select).toHaveBeenCalledWith(expect.objectContaining({
      currentStep: expect.objectContaining({ id: "ask_name" }),
    }));
    expect(routineRenderer.render).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ id: "done" }),
    }));
  });

  it("uses a supplied routine runner before supplied selector and renderer", async () => {
    const sessionId = "s_supplied_runner";
    const routineStore = recordingRoutineStore(activeSignupState(sessionId));
    const routineSelector: ConversationRoutineNextStepSelector = {
      select: vi.fn(async () => ({ nextStepId: "done" })),
    };
    const routineRenderer: ConversationRoutineStepRenderer = {
      render: vi.fn(async () => ({ answer: "renderer should not run" })),
    };
    const routineRunner: ConversationRoutineRunner = {
      resume: vi.fn(async ({ state }) => ({
        response: { answer: "from supplied runner" },
        nextState: { ...state, path: ["done"], status: "completed" },
        terminal: { kind: "complete", stepId: "done" },
      })),
    };
    const kit = createConversationKit({
      modelGateway: routineGateway(),
      routines: [signupRoutine],
      routineStore,
      routineSelector,
      routineRenderer,
      routineRunner,
    });

    const result = await kit.runTurn({ sessionId, message: "My name is Sam" });

    expect(result.response.answer).toBe("from supplied runner");
    expect(routineRunner.resume).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ sessionId, routineId: "signup" }),
    }));
    expect(routineSelector.select).not.toHaveBeenCalled();
    expect(routineRenderer.render).not.toHaveBeenCalled();
  });

  it("keeps the default routine collaborators active when none are supplied", async () => {
    const registration: RoutineRegistration = {
      routine: signupRoutine,
      trigger: { description: "The user wants to sign up.", priority: 0 },
    };
    const kit = createConversationKit({
      modelGateway: routineGateway(),
      routineRegistrations: [registration],
    });

    const first = await kit.runTurn({ sessionId: "s_defaults", message: "I want to sign up" });
    const second = await kit.runTurn({ sessionId: "s_defaults", message: "My name is Sam" });

    expect(first.response.answer).toBe("What is your name?");
    expect(second.response.answer).toBe("Thanks, all set!");
  });
});
