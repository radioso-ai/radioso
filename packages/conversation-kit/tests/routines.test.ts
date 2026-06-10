import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine } from "@radioso/conversation-contract";

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
