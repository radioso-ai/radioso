import { describe, expect, it, vi } from "vitest";
import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import type {
  ConversationEvent,
  ConversationRoutineNextStepSelector,
  ConversationRoutineStepRenderer,
  ConversationRoutineStore,
  ProcessTurnInput,
  RoutineState,
} from "@radioso/conversation-contract";

import { contactRoutine, CONTACT_SEND_ACTION_TYPE } from "../../src/modules/chat/services/routines/contactRoutine.js";
import { RoutineRegistry } from "../../src/modules/chat/services/routines/routineRegistry.js";

/**
 * End-to-end proof for the chat-only contact routine (#520 slice 4): drives the real
 * routine graph through the REAL engine + runner + RoutineRegistry activator, with
 * scripted ports standing in for the LLM selector/renderer. Asserts the flow gathers
 * email + message over chat turns, then emits a `contact.send` action (fire-and-forget)
 * carrying the gathered variables and clears its state at the terminal step.
 */

const inMemoryStore = (): ConversationRoutineStore & { rows: Map<string, RoutineState> } => {
  const rows = new Map<string, RoutineState>();
  return {
    rows,
    loadActive: vi.fn(async ({ sessionId }) => {
      const row = rows.get(sessionId);
      return row && row.status === "active" ? row : null;
    }),
    save: vi.fn(async (state) => {
      rows.set(state.sessionId, state);
    }),
    clear: vi.fn(async ({ sessionId }) => {
      rows.delete(sessionId);
    }),
  };
};

// Scripted next-step selector: decides edges from the user's latest message, the way
// the LLM selector would for the contact flow (email vs message vs neither).
const scriptedSelector: ConversationRoutineNextStepSelector = {
  async select({ currentStep, transitions, turn }) {
    const text = turn.inputEvent.content.trim();
    if (currentStep.id === "ask_email") {
      return /\S+@\S+\.\S+/.test(text)
        ? { nextStepId: "ask_message", variables: { email: text } }
        : { nextStepId: "ask_email" };
    }
    if (currentStep.id === "ask_message") {
      return text.length > 0
        ? { nextStepId: "send", variables: { message: text } }
        : { nextStepId: "ask_message" };
    }
    return { nextStepId: transitions[0]?.to ?? currentStep.id };
  },
};

const echoRenderer: ConversationRoutineStepRenderer = {
  render: vi.fn(async ({ step, steering }) => ({ answer: `[${step.id}] ${steering[0]?.action ?? ""}` })),
};

const registry = new RoutineRegistry([
  {
    routine: contactRoutine,
    activates: async ({ turn }) =>
      turn.inputEvent.metadata?.method === "intent_click" ? {} : null,
  },
]);

const buildInput = (content: string, store: ConversationRoutineStore, events: ConversationEvent[]): ProcessTurnInput => ({
  agent: { id: "agent_1", name: "Vikram" },
  sessionId: "conv_1",
  inputEvent: { id: `in_${content}`, kind: "message", content },
  skills: [],
  directives: [],
  stores: {
    loadHistory: vi.fn(async () => []),
    appendEvent: vi.fn(async (event: ConversationEvent) => {
      events.push(event);
    }),
  },
  modelGateway: { complete: vi.fn(async () => ({ text: "" })) },
  directiveMatcher: { match: vi.fn(async () => []) },
  selector: { select: vi.fn(async () => ({ selected: [], reason: "none" })) },
  dispatcher: { dispatch: vi.fn() },
  composer: { compose: vi.fn(async () => ({ answer: "normal answer" })) },
  routineStore: store,
  routineRunner: new DefaultRoutineRunner([contactRoutine], scriptedSelector, echoRenderer),
  routineActivator: registry.activator(),
});

describe("contact routine — end-to-end through the engine (action emission)", () => {
  it("gathers email + message, then emits contact.send with the gathered payload and clears state", async () => {
    const store = inMemoryStore();
    const engine = createConversationEngine();
    const events: ConversationEvent[] = [];
    const run = (content: string, metadata?: Record<string, unknown>) => {
      const input = buildInput(content, store, events);
      if (metadata) {
        input.inputEvent.metadata = metadata;
      }
      return engine.processTurn(input);
    };

    // Turn 1 — explicit intent activates the routine; it asks for the email.
    const t1 = await run("I want to contact you", { method: "intent_click" });
    expect(t1.response.answer).toContain("ask_email");
    expect(t1.actions ?? []).toEqual([]);
    expect(store.rows.get("conv_1")?.status).toBe("active");

    // Turn 2 — user provides their email; advance to ask_message, capture the slot.
    const t2 = await run("alex@example.com");
    expect(t2.response.answer).toContain("ask_message");
    expect(t2.actions ?? []).toEqual([]);
    expect(store.rows.get("conv_1")?.variables).toMatchObject({ email: "alex@example.com" });

    // Turn 3 — user provides the message; the action step emits contact.send (carrying
    // the gathered variables), the routine confirms at the terminal step, state cleared.
    const t3 = await run("Please call me about pricing.");
    expect(t3.actions).toEqual([
      {
        type: CONTACT_SEND_ACTION_TYPE,
        payload: { email: "alex@example.com", message: "Please call me about pricing." },
      },
    ]);
    expect(t3.response.answer).toContain("done");
    expect(store.rows.get("conv_1")).toBeUndefined();
  });
});
