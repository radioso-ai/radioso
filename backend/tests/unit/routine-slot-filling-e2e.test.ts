import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationRoutineStepRenderer,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import { RoutineNextStepSelector } from "@radioso/conversation-defaults";

import { compileRoutineDefinition } from "../../src/modules/routines/public.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";

/**
 * Reproduces the authoring → compile → runtime slot-filling path that a no-code
 * routine takes: a plain sequential routine (bare `default` edges, the shape the
 * chip editor emits) whose chat steps each ask for a {{slot.x}}. This must run the
 * *real* compiler (so auto-gating fires) and the *real* next-step selector (the one
 * place variables are extracted), with the model scripted turn-by-turn the way it
 * would actually answer. If slot capture is broken, this is where it shows.
 */

const now = new Date("2026-06-16T00:00:00.000Z");

// A plain-sequential authored definition: every step→next edge is a bare `default`.
const authored: RoutineDefinition = {
  id: "routine:agent_1:contact:v1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  version: 1,
  status: "published",
  createdAt: now,
  updatedAt: now,
  name: "Contact us",
  activation: { triggerDescription: "the user wants to contact a human", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: "Reachable email.", ordinal: 0 },
    { stableSlotId: "slot_message", key: "message", type: "text", required: true, description: "What to pass on.", ordinal: 1 },
  ],
  steps: [
    {
      stableStepId: "ask_email",
      kind: "chat",
      instruction: "Ask what email we can reach them at: {{slot.email}}",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    },
    {
      stableStepId: "ask_message",
      kind: "chat",
      instruction: "Ask for the message they want to send: {{slot.message}}",
      toolRef: null,
      actionType: null,
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [
    { fromStep: "ask_email", toRef: "ask_message", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    { fromStep: "ask_message", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 1 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm we'll be in touch.", ordinal: 0 },
  ],
};

const echoRenderer: ConversationRoutineStepRenderer = {
  render: vi.fn(async ({ step, steering }) => ({ answer: `[${step.id}] ${steering[0]?.action ?? ""}`, metadata: {} })),
};

const turnWith = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: `in:${content}`, kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
});

describe("routine slot filling (authoring → compile → runtime)", () => {
  it("auto-gates the sequential steps and captures each slot through the real selector", async () => {
    const compiled = compileRoutineDefinition(authored);

    // Sanity: the compiler must have promoted the bare default edges to selector-running
    // (llm) transitions. If it didn't, the runner would auto-advance without ever
    // extracting the slot — the original bug class.
    const askEmailEdge = compiled.transitions.find((t) => t.from === "ask_email");
    expect(askEmailEdge?.guard).toBeUndefined();
    expect(askEmailEdge?.condition).toContain("{{slot.email}}");

    // The model, scripted turn-by-turn exactly as it would answer.
    const scripted = [
      '{"condition": null, "offTopic": false, "variables": {}}', // activation: no email yet → re-ask
      '{"condition": 1, "variables": {"email": "alex@example.com"}}', // user gives email
      '{"condition": 1, "variables": {"message": "Please call me about pricing."}}', // user gives message
    ];
    let call = 0;
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: scripted[call++] ?? "{}" })),
    };
    const runner = new DefaultRoutineRunner(
      [compiled],
      new RoutineNextStepSelector(gateway),
      echoRenderer,
    );

    let state: RoutineState = { sessionId: "s1", routineId: compiled.id, path: [], variables: {}, status: "active" };

    // Turn 1 — activation, no email in the message yet → the selector runs and we stay.
    const t1 = await runner.resume({ turn: turnWith("I'd like to contact someone"), state });
    expect(gateway.complete).toHaveBeenCalledTimes(1); // proves the edge is selector-gated
    expect(t1.response.answer).toContain("ask_email");
    expect(t1.nextState?.variables).toEqual({});
    expect(t1.trace?.steps.map((s) => `${s.stepId}:${s.event}`)).toEqual(["ask_email:reasked"]);
    state = t1.nextState!;

    // Turn 2 — user provides their email → captured and persisted, advance to ask_message.
    const t2 = await runner.resume({ turn: turnWith("alex@example.com"), state });
    expect(t2.nextState?.variables).toMatchObject({ email: "alex@example.com" });
    expect(t2.response.answer).toContain("ask_message");
    expect(t2.trace?.capturedSlotKeys).toEqual(["email"]);
    expect(t2.trace?.filledSlotKeys).toEqual(["email"]);
    state = t2.nextState!;

    // Turn 3 — user provides the message → both slots filled, routine completes.
    const t3 = await runner.resume({ turn: turnWith("Please call me about pricing."), state });
    expect(t3.nextState).toBeNull(); // terminal reached → state cleared
    expect(t3.trace?.capturedSlotKeys).toEqual(["message"]);
    expect(t3.trace?.filledSlotKeys).toEqual(expect.arrayContaining(["email", "message"]));
    expect(t3.trace?.terminalKind).toBe("complete");
  });

  it("captures a slot on a step that branches on it via a field guard (no llm edge)", async () => {
    // "Ask for budget, then route by budget in code." A natural authoring shape where
    // the slot is asked and branched on in the same step. Before the fix the selector
    // never ran (no llm edge), so the slot was dropped and the branch was dead.
    const branchDef: RoutineDefinition = {
      ...authored,
      id: "routine:agent_1:budget:v1",
      name: "Budget router",
      slots: [
        { stableSlotId: "slot_budget", key: "budget", type: "number", required: true, description: "Monthly budget.", ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ask_budget", kind: "chat", instruction: "Ask their monthly budget: {{slot.budget}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      ],
      transitions: [
        { fromStep: "ask_budget", toRef: "premium", guardKind: "field", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: "budget", fieldOp: "gte", fieldValue: 1000, fieldValues: null, fieldUnit: null, ordinal: 0 },
        { fromStep: "ask_budget", toRef: "standard", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "premium", kind: "complete", instruction: "Route to the premium team.", ordinal: 0 },
        { stableStepId: "standard", kind: "complete", instruction: "Route to standard support.", ordinal: 1 },
      ],
    };
    const compiled = compileRoutineDefinition(branchDef);
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: '{"condition": null, "variables": {"budget": 5000}}' })),
    };
    const runner = new DefaultRoutineRunner([compiled], new RoutineNextStepSelector(gateway), echoRenderer);

    const r = await runner.resume({
      turn: turnWith("about 5000 a month"),
      state: { sessionId: "s1", routineId: compiled.id, path: ["ask_budget"], variables: {}, status: "active" },
    });

    expect(gateway.complete).toHaveBeenCalledTimes(1); // the selector ran for extraction
    expect(r.trace?.capturedSlotKeys).toEqual(["budget"]); // the slot WAS captured
    expect(r.response.answer).toContain("premium"); // and the field guard saw it → premium branch
    expect(r.nextState).toBeNull();
  });

  it("renders (not skips) a later step that only interpolates an already-filled slot", async () => {
    // The "Thanks, cap" shape: step 1 collects {{slot.name}}, step 2 only *mentions* it.
    // Before the first-referencer fix, step 2 was flagged as collecting `name`, so once
    // `name` was filled the runner fast-forwarded (skipped) it and dropped its message.
    const redirectDef: RoutineDefinition = {
      ...authored,
      id: "routine:agent_1:thanks:v1",
      name: "Thanks, cap",
      slots: [
        { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "Their name.", ordinal: 0 },
      ],
      steps: [
        { stableStepId: "ack", kind: "chat", instruction: "Acknowledge and ask their name; record as {{slot.name}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
        { stableStepId: "redirect", kind: "chat", instruction: "Redirect to the main purpose and mention their {{slot.name}}", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
      ],
      transitions: [
        { fromStep: "ack", toRef: "redirect", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
        { fromStep: "redirect", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 1 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "All set.", ordinal: 0 },
      ],
    };
    const compiled = compileRoutineDefinition(redirectDef);
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: '{"condition": 1, "variables": {"name": "Joe"}}' })),
    };
    const runner = new DefaultRoutineRunner([compiled], new RoutineNextStepSelector(gateway), echoRenderer);

    // On the name-giving turn, resuming at the acknowledgement step.
    const r = await runner.resume({
      turn: turnWith("Joe"),
      state: { sessionId: "s1", routineId: compiled.id, path: ["ack"], variables: {}, status: "active" },
    });

    const events = r.trace?.steps.map((s) => `${s.stepId}:${s.event}`);
    expect(events).toContain("ack:advanced"); // captured name, advanced
    expect(events).toContain("redirect:rendered"); // the redirection message is delivered
    expect(events).not.toContain("redirect:fast_forwarded"); // NOT skipped
    expect(r.trace?.capturedSlotKeys).toEqual(["name"]);
    expect(r.trace?.landedStepId).toBe("redirect");
    expect(r.nextState).not.toBeNull(); // routine parked at redirect, not completed yet
    expect(r.nextState?.path.at(-1)).toBe("redirect");
  });
});
