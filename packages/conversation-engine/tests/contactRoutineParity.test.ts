import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationEvent,
  ConversationRoutineNextStepSelector,
  ConversationRoutineStepRenderer,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStore,
  ProcessTurnInput,
  Routine,
  RoutineState,
} from "@radioso/conversation-contract";

/**
 * End-to-end parity proof for the contact-flow transplant: drives the (faithful)
 * contact Routine graph through the REAL DefaultConversationEngine + DefaultRoutineRunner
 * across multiple turns, with scripted ports standing in for the LLM selector/renderer,
 * the DB store, and the submit skill. Asserts the flow reproduces the human-contact
 * intake: activate → ask email → (yield an off-topic question) → email → ask message
 * → message → submit (skill) → confirm, with the routine state persisted between turns
 * and cleared on completion.
 */

const contactRoutine: Routine = {
  id: "human_contact.request",
  rootStepId: "ask_email",
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask the user for the email address where they can be reached." },
    { id: "ask_message", kind: "chat", action: "Ask the user for the message they would like to send." },
    { id: "submit", kind: "skill", skillName: "human_contact.request" },
    { id: "done", kind: "terminal", action: "Confirm their request was sent." },
    { id: "failed", kind: "terminal", action: "Apologize that the request could not be submitted; suggest trying later." },
  ],
  transitions: [
    { from: "ask_email", to: "ask_message", condition: "the user provided a valid email address" },
    { from: "ask_message", to: "submit", condition: "the user provided the message they want to send" },
    { from: "submit", to: "done", condition: "the contact request was submitted successfully" },
    { from: "submit", to: "failed", condition: "the contact request submission failed" },
  ],
};

// A simple in-memory routine store with the single-open-flow guarantee per session.
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

// Stands in for the LLM next-step selector: decides from the user's latest message
// what the contact flow would decide (email vs off-topic vs message vs submit result).
const scriptedSelector: ConversationRoutineNextStepSelector = {
  async select({ currentStep, transitions, turn, skillResult }) {
    const text = turn.inputEvent.content;
    const isEmail = /\S+@\S+\.\S+/.test(text) && !text.includes("?");
    const isQuestion = text.includes("?");

    if (currentStep.id === "ask_email") {
      if (isEmail) {
        return { nextStepId: "ask_message", variables: { email: text.trim() } };
      }
      if (isQuestion) {
        // Off-topic question (e.g. "is bob@x.com a valid format?") → yield the turn.
        return { nextStepId: "ask_email", yieldTurn: true };
      }
      return { nextStepId: "ask_email" }; // invalid → re-ask (stay)
    }
    if (currentStep.id === "ask_message") {
      if (text.trim().length > 0) {
        return { nextStepId: "submit", variables: { message: text.trim() } };
      }
      return { nextStepId: "ask_message" }; // empty → re-ask
    }
    if (currentStep.id === "submit") {
      return { nextStepId: skillResult?.status === "completed" ? "done" : "failed" };
    }
    return { nextStepId: transitions[0]?.to ?? currentStep.id };
  },
};

const echoRenderer: ConversationRoutineStepRenderer = {
  render: vi.fn(async ({ step, steering }) => ({ answer: `[${step.id}] ${steering[0]?.action ?? ""}` })),
};

const buildInput = (
  content: string,
  store: ConversationRoutineStore,
  dispatcher: ConversationRoutineSkillDispatcher,
  events: ConversationEvent[],
): ProcessTurnInput => ({
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
  modelGateway: { complete: vi.fn(async () => ({ text: "normal answer" })) },
  directiveMatcher: { match: vi.fn(async () => []) },
  // Normal-path ports — used only when a routine yields the turn.
  selector: { select: vi.fn(async () => ({ selected: [], reason: "none" })) },
  dispatcher: { dispatch: vi.fn() },
  composer: { compose: vi.fn(async () => ({ answer: "Sure — a valid email looks like name@example.com." })) },
  routineStore: store,
  routineRunner: new DefaultRoutineRunner([contactRoutine], scriptedSelector, echoRenderer, dispatcher),
  routineActivator: {
    // Start the contact routine on the explicit pill click (intent_click metadata).
    activate: vi.fn(async ({ turn }) =>
      turn.inputEvent.metadata?.method === "intent_click"
        ? { kind: "activate", routineId: "human_contact.request" }
        : null,
    ),
  },
});

describe("contact routine — end-to-end parity through the engine", () => {
  it("walks activate → ask email → yield off-topic → email → ask message → message → submit → done", async () => {
    const store = inMemoryStore();
    const submit = vi.fn(async () => ({ status: "completed" as const, outputs: { requestId: "req_1" } }));
    const dispatcher: ConversationRoutineSkillDispatcher = { dispatch: submit };
    const engine = new DefaultConversationEngine();
    const events: ConversationEvent[] = [];

    const run = async (content: string, metadata?: Record<string, unknown>) => {
      const input = buildInput(content, store, dispatcher, events);
      if (metadata) {
        input.inputEvent.metadata = metadata;
      }
      return engine.processTurn(input);
    };

    // Turn 1 — user clicks the "contact a human" pill → routine activates, asks for email.
    const t1 = await run("contact a human", { method: "intent_click", intent: { skillName: "human_contact.request" } });
    expect(t1.response.answer).toContain("ask_email");
    expect(store.rows.get("conv_1")?.path).toEqual([]);

    // Turn 2 — user asks an off-topic question that merely mentions an email → yield.
    const t2 = await run("is bob@x.com a valid email format?");
    expect(t2.response.answer).toContain("valid email looks like"); // normal answer, not the routine
    expect(store.rows.get("conv_1")?.status).toBe("active"); // routine still parked at ask_email

    // Turn 3 — user supplies their email → advance to ask_message, capture the slot.
    const t3 = await run("alex@example.com");
    expect(t3.response.answer).toContain("ask_message");
    expect(store.rows.get("conv_1")?.variables).toMatchObject({ email: "alex@example.com" });

    // Turn 4 — user supplies the message → submit (skill) → done; state marked completed.
    const t4 = await run("Please call me about pricing.");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ skillName: "human_contact.request" }));
    expect(t4.response.answer).toContain("done");
    expect(store.rows.get("conv_1")).toMatchObject({
      routineId: "human_contact.request",
      status: "completed",
    });
  });

  it("re-asks (stays) on an invalid email, then advances once a valid one arrives", async () => {
    const store = inMemoryStore();
    const dispatcher: ConversationRoutineSkillDispatcher = { dispatch: vi.fn(async () => ({ status: "completed" as const })) };
    const engine = new DefaultConversationEngine();
    const events: ConversationEvent[] = [];
    const run = (content: string, metadata?: Record<string, unknown>) => {
      const input = buildInput(content, store, dispatcher, events);
      if (metadata) {
        input.inputEvent.metadata = metadata;
      }
      return engine.processTurn(input);
    };

    await run("contact a human", { method: "intent_click", intent: { skillName: "human_contact.request" } });
    const invalid = await run("my email is not-an-email");
    expect(invalid.response.answer).toContain("ask_email"); // stayed
    expect(store.rows.get("conv_1")?.path).toEqual([]); // still at root step

    const valid = await run("alex@example.com");
    expect(valid.response.answer).toContain("ask_message");
  });

  it("routes a submit failure to the failed step", async () => {
    const store = inMemoryStore();
    const dispatcher: ConversationRoutineSkillDispatcher = { dispatch: vi.fn(async () => ({ status: "failed" as const })) };
    const engine = new DefaultConversationEngine();
    const events: ConversationEvent[] = [];
    const run = (content: string, metadata?: Record<string, unknown>) => {
      const input = buildInput(content, store, dispatcher, events);
      if (metadata) {
        input.inputEvent.metadata = metadata;
      }
      return engine.processTurn(input);
    };

    await run("contact a human", { method: "intent_click", intent: { skillName: "human_contact.request" } });
    await run("alex@example.com");
    const failed = await run("Please help.");
    expect(failed.response.answer).toContain("failed");
    expect(store.rows.get("conv_1")).toMatchObject({
      routineId: "human_contact.request",
      status: "completed",
    });
  });
});

// Regression guard for spec-091 review finding P1(a): the engine MUST forward the
// runner's `awaitingDecision` through ProcessTurnResult (and persist status="suspended"),
// otherwise a routine that hits an approval gate is silently orphaned — it saves a
// suspended row that loadActive never reloads, with no pending decision and no notice.
describe("approval gate — engine surfaces awaitingDecision and suspends", () => {
  const approvalRoutine: Routine = {
    id: "refund.flow",
    rootStepId: "gate",
    steps: [
      {
        id: "gate",
        kind: "await",
        action: "Tell the customer the request is under review.",
        decision: {
          captureKey: "refund_decision",
          options: [
            { id: "approve", label: "Approve" },
            { id: "reject", label: "Reject" },
          ],
        },
        metadata: { reason: "refund_review" },
      },
      { id: "issue", kind: "action", actionType: "refund.issue" },
      { id: "done", kind: "terminal", action: "Confirm the refund was issued." },
      { id: "declined", kind: "terminal", action: "Explain the refund was declined." },
    ],
    transitions: [
      { from: "gate", to: "issue", condition: "approved", guard: { kind: "field", ref: "refund_decision.id", op: "equals", value: "approve" } },
      { from: "gate", to: "declined", condition: "rejected", guard: { kind: "field", ref: "refund_decision.id", op: "equals", value: "reject" } },
      { from: "issue", to: "done", condition: "issued" },
    ],
  };

  it("forwards awaitingDecision (handle minted by the host) and persists status=suspended, with no model call", async () => {
    const store = inMemoryStore();
    const events: ConversationEvent[] = [];
    // A selector that throws if consulted — landing on the await gate must be deterministic.
    const throwingSelector: ConversationRoutineNextStepSelector = {
      select: vi.fn(async () => {
        throw new Error("SELECTOR_CALLED");
      }),
    };
    const dispatcher: ConversationRoutineSkillDispatcher = { dispatch: vi.fn() };
    const engine = new DefaultConversationEngine();
    const input: ProcessTurnInput = {
      agent: { id: "agent_1", name: "Vikram" },
      sessionId: "conv_1",
      inputEvent: {
        id: "in_approve",
        kind: "message",
        content: "refund please",
        metadata: { method: "intent_click", intent: { skillName: "refund.flow" } },
      },
      skills: [],
      directives: [],
      stores: {
        loadHistory: vi.fn(async () => []),
        appendEvent: vi.fn(async (event: ConversationEvent) => {
          events.push(event);
        }),
      },
      modelGateway: { complete: vi.fn(async () => ({ text: "normal answer" })) },
      directiveMatcher: { match: vi.fn(async () => []) },
      selector: { select: vi.fn(async () => ({ selected: [], reason: "none" })) },
      dispatcher: { dispatch: vi.fn() },
      composer: { compose: vi.fn(async () => ({ answer: "normal answer" })) },
      routineStore: store,
      routineRunner: new DefaultRoutineRunner([approvalRoutine], throwingSelector, echoRenderer, dispatcher),
      routineActivator: {
        activate: vi.fn(async ({ turn }) =>
          turn.inputEvent.metadata?.method === "intent_click"
            ? { kind: "activate", routineId: "refund.flow" }
            : null,
        ),
      },
    };

    const result = await engine.processTurn(input);

    expect(result.awaitingDecision).toEqual({
      stepId: "gate",
      captureKey: "refund_decision",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      reason: "refund_review",
    });
    expect(store.rows.get("conv_1")?.status).toBe("suspended");
    expect(throwingSelector.select).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled(); // the gated action never fired
  });
});
