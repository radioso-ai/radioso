import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineStepRenderer,
  Routine,
  RoutineState,
  RoutineStepReplyInput,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * A step reply is told which values the routine holds in its declared slots (#1666), so it can
 * tell a value that was noted from one it only heard or offered. Without the list, the reply
 * said "per il rientro segno il 1° novembre" while no slot held a departure.
 */

const bookingRoutine: Routine = {
  id: "booking",
  rootStepId: "program",
  slots: [
    { id: "slot_program", key: "program", type: "text", required: true },
    { id: "slot_arrival", key: "arrival", type: "date", required: true },
    { id: "slot_departure", key: "departure", type: "date", required: true },
    { id: "slot_email", key: "email", type: "email", required: false, sensitivity: "sensitive" },
  ],
  steps: [
    { id: "program", kind: "chat", action: "Ask which program: {{slot.program}}", metadata: { collectsSlots: ["program"] } },
    {
      id: "dates",
      kind: "chat",
      action: "Ask for {{slot.arrival}} and {{slot.departure}}.",
      metadata: { collectsSlots: ["arrival", "departure"] },
    },
    { id: "done", kind: "terminal", action: "Tell them the team will be in touch." },
  ],
  transitions: [
    { from: "program", to: "dates", condition: "The user provided {{slot.program}}." },
    { from: "dates", to: "done", condition: "The user provided {{slot.arrival}} and {{slot.departure}}." },
  ],
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "Mi chiamo Giulia" },
  history: [],
  stagedContext: [],
  steering: [],
};

const state = (routineId: string, path: string[], variables: Record<string, unknown> = {}): RoutineState => ({
  sessionId: "session_1",
  routineId,
  path,
  variables,
  status: "active",
});

const freshRenderer = (): ConversationRoutineStepRenderer => ({
  render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]` })),
});

const replyInput = (renderer: ConversationRoutineStepRenderer): RoutineStepReplyInput | undefined =>
  vi.mocked(renderer.render).mock.calls[0]?.[0];

describe("DefaultRoutineRunner hands the step reply the slots it holds (#1666)", () => {
  it("gives a step's first ask the declared slots the routine holds, with their values", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: { program: "Ognissanti" } })) },
      renderer,
    );

    await runner.resume({ turn, state: state("booking", ["program"]) });

    const input = replyInput(renderer);
    expect(input?.step.id).toBe("dates");
    expect(input).not.toHaveProperty("reask");
    expect(input?.heldSlots).toEqual({ program: "Ognissanti" });
  });

  it("gives a re-asked step the slots held after this turn, never one the turn left empty", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: {}, selection: { outcome: "stay" as const, returnedSlotKeys: [] } })) },
      renderer,
    );

    await runner.resume({ turn, state: state("booking", ["program", "dates"], { program: "Ognissanti", arrival: "2026-10-30" }) });

    const input = replyInput(renderer);
    expect(input?.reask).toBeDefined();
    expect(input?.heldSlots).toEqual({ program: "Ognissanti", arrival: "2026-10-30" });
    expect(input?.heldSlots).not.toHaveProperty("departure");
  });

  it("lists only declared slots, in declared order, with a sensitive one masked", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: {} })) },
      renderer,
    );

    // A tool step's output can sit in the routine's variables under a key no slot declares.
    await runner.resume({
      turn,
      state: state("booking", ["program", "dates"], {
        availability: { rooms: 3 },
        email: "giulia@example.com",
        arrival: "2026-10-30",
        program: "Ognissanti",
      }),
    });

    const heldSlots = replyInput(renderer)?.heldSlots ?? {};
    expect(Object.keys(heldSlots)).toEqual(["program", "arrival", "email"]);
    expect(heldSlots.email).toBe("[redacted]");
    expect(heldSlots).not.toHaveProperty("availability");
  });

  it("tells a routine's first ask that it holds nothing yet", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "program", variables: {} })) },
      renderer,
    );

    await runner.resume({ turn, state: state("booking", ["program"]), activationTurn: true });

    expect(replyInput(renderer)?.heldSlots).toEqual({});
  });

  it("hands no list for a routine that declares no slots, since it has none to check against", async () => {
    const untyped: Routine = {
      id: "contact",
      rootStepId: "ask_email",
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask for their email address." },
        { id: "ask_message", kind: "chat", action: "Ask for their message." },
      ],
      transitions: [{ from: "ask_email", to: "ask_message", condition: "an email was provided" }],
    };
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [untyped],
      { select: vi.fn(async () => ({ nextStepId: "ask_message", variables: { email: "alex@example.com" } })) },
      renderer,
    );

    await runner.resume({ turn, state: state("contact", ["ask_email"]) });

    expect(replyInput(renderer)).not.toHaveProperty("heldSlots");
  });

  it("never puts a held value in the turn's trace unless slot values were asked for", async () => {
    const renderer = freshRenderer();
    const runner = new DefaultRoutineRunner(
      [bookingRoutine],
      { select: vi.fn(async () => ({ nextStepId: "dates", variables: { program: "Ognissanti" } })) },
      renderer,
    );

    const result = await runner.resume({ turn, state: state("booking", ["program"]) });

    expect(JSON.stringify(result.trace)).not.toContain("Ognissanti");
  });
});
