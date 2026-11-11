import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineConsentPort,
  ConversationRoutineNextStepSelector,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineConsentDecision,
  RoutineConsentDeclineChoice,
  RoutineConsentReading,
  RoutineState,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "../src/routineRunner.js";

// The shape the compiler gives a routine with a consent (#1544): a `consent` step sits before the
// step that collects a covered slot, every edge into that step goes to the consent step instead,
// and the consent step's default exit leads on to it.
const GATE = "consent:health:ask_health";

const intake = (onDecline: RoutineConsentDeclineChoice = "continue", options: {
  rootStepId?: string;
  healthExits?: RoutineTransition[];
} = {}): Routine => ({
  id: "intake",
  rootStepId: options.rootStepId ?? "ask_name",
  slots: [
    { id: "slot_name", key: "name", type: "text", required: true },
    { id: "slot_pregnant", key: "pregnant", type: "boolean", required: true, sensitivity: "sensitive" },
  ],
  consents: [{ key: "health", slotKeys: ["pregnant"], onDecline }],
  steps: [
    { id: "ask_name", kind: "chat", action: "Ask for the visitor's name.", metadata: { collectsSlots: ["name"] } },
    { id: GATE, kind: "consent", consentKey: "health" },
    { id: "ask_health", kind: "chat", action: "Ask whether the visitor is pregnant.", metadata: { collectsSlots: ["pregnant"] } },
    { id: "prenatal", kind: "terminal", action: "Offer the prenatal programme." },
    { id: "done", kind: "terminal", action: "Confirm the booking." },
  ],
  transitions: [
    { from: "ask_name", to: GATE, condition: "a name was given", guard: { kind: "slot_filled", slots: ["name"] } },
    { from: GATE, to: "ask_health", condition: "", guard: { kind: "default" } },
    ...(options.healthExits ?? [
      { from: "ask_health", to: "prenatal", condition: "", guard: { kind: "field", ref: "pregnant", op: "is_true" } },
      { from: "ask_health", to: "done", condition: "", guard: { kind: "default" } },
    ]),
  ],
});

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
});

const state = (path: string[], variables: Record<string, unknown> = {}, reaskCount?: number): RoutineState => ({
  sessionId: "session_1",
  routineId: "intake",
  path,
  variables,
  status: "active",
  ...(reaskCount !== undefined ? { reaskCount } : {}),
});

const renderer = (): ConversationRoutineStepRenderer => ({
  render: vi.fn(async ({ step, stuckHandoff }) => ({ answer: stuckHandoff ? `[${step.id}] a person continues` : `[${step.id}]` })),
});

// A selector that reads the message as stating the given values, whatever the step.
const reading = (variables: Record<string, unknown>): ConversationRoutineNextStepSelector => ({
  select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id, variables })),
});

interface Wording { version: string; reask: boolean }

const consentPort = (options: {
  asks?: boolean;
  decisions?: Record<string, RoutineConsentDecision>;
  reply?: { decision: RoutineConsentReading; method: "button" | "reply" } | null;
  wordingAvailable?: boolean;
} = {}) => {
  const port = {
    standing: vi.fn(async () => ({ asks: options.asks ?? true, decisions: options.decisions ?? {} })),
    read: vi.fn(async () => (options.reply ? { ...options.reply, wording: { version: "v1", reask: false } } : null)),
    prompt: vi.fn(async ({ consent, reask }: { consent: { key: string }; reask: boolean }) =>
      options.wordingAvailable === false
        ? null
        : {
            reply: { render: async () => ({ answer: `${reask ? "Only the text says. " : ""}[wording ${consent.key}] Agree / Decline` }) },
            wording: { version: "v1", reask },
          }),
  };
  return port satisfies ConversationRoutineConsentPort<Wording>;
};

const runnerWith = (
  routine: Routine,
  port: ConversationRoutineConsentPort | undefined,
  selector: ConversationRoutineNextStepSelector = reading({}),
  render: ConversationRoutineStepRenderer = renderer(),
  options: { openingMessageStatesSlotValues?: boolean } = {},
) => new DefaultRoutineRunner([routine], selector, render, undefined, { ...options, ...(port ? { consent: port } : {}) });

describe("DefaultRoutineRunner consent before a covered slot (#1544)", () => {
  describe("asking", () => {
    it("shows the consent wording, not the collecting step, when the routine reaches it undecided", async () => {
      const port = consentPort();
      const render = renderer();
      const runner = runnerWith(intake(), port, reading({ name: "Ada" }), render);

      const result = await runner.resume({ turn: turn("I'm Ada"), state: state(["ask_name"]) });

      expect(result.response.answer).toBe("[wording health] Agree / Decline");
      expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({ reask: false, consent: expect.objectContaining({ key: "health" }) }));
      expect(render.render).not.toHaveBeenCalled();
      expect(result.nextState).toMatchObject({ path: ["ask_name", GATE], variables: { name: "Ada" }, status: "active" });
      expect(result.nextState).not.toHaveProperty("reaskCount");
      expect(result.hostEffects?.consentEvents).toEqual([
        { kind: "asked", routineId: "intake", consentKey: "health", reask: false, wording: { version: "v1", reask: false } },
      ]);
      expect(result.trace?.steps.at(-1)).toEqual({ stepId: GATE, kind: "consent", event: "consent_asked", consent: { key: "health" } });
      expect(result.trace?.landedStepId).toBe(GATE);
    });

    it("asks a consent at the root step on the turn that starts the routine", async () => {
      const port = consentPort();
      const runner = runnerWith(intake("continue", { rootStepId: GATE }), port);

      const result = await runner.resume({ turn: turn("I want to book"), state: state([]), activationTurn: true });

      expect(result.response.answer).toBe("[wording health] Agree / Decline");
      expect(result.nextState).toMatchObject({ path: [GATE], status: "active" });
      expect(port.read).not.toHaveBeenCalled();
    });

    it("does not ask again a consent the conversation already granted, and asks the collecting step", async () => {
      const port = consentPort({ decisions: { health: "granted" } });
      const render = renderer();
      const runner = runnerWith(intake(), port, reading({ name: "Ada" }), render);

      const result = await runner.resume({ turn: turn("I'm Ada"), state: state(["ask_name"]) });

      expect(port.prompt).not.toHaveBeenCalled();
      expect(result.response.answer).toBe("[ask_health]");
      expect(result.nextState?.path).toEqual(["ask_name", GATE, "ask_health"]);
      expect(result.hostEffects).toBeUndefined();
      expect(result.trace?.steps).toContainEqual({ stepId: GATE, kind: "consent", event: "consent_reused", consent: { key: "health", decision: "granted" } });
    });
  });

  describe("a reply to the shown consent", () => {
    it.each(["button", "reply"] as const)("grants by %s and asks the collecting step next", async (method) => {
      const port = consentPort({ reply: { decision: "granted", method } });
      const render = renderer();
      const runner = runnerWith(intake(), port, reading({}), render);

      const result = await runner.resume({ turn: turn("Agree"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(result.response.answer).toBe("[ask_health]");
      expect(render.render).toHaveBeenCalledWith(expect.not.objectContaining({ reask: expect.anything() }));
      expect(result.nextState).toMatchObject({ path: ["ask_name", GATE, "ask_health"], status: "active" });
      expect(result.hostEffects?.consentEvents).toEqual([{
        kind: "decided",
        routineId: "intake",
        consentKey: "health",
        slotKeys: ["pregnant"],
        decision: "granted",
        method,
        defaulted: false,
        wording: { version: "v1", reask: false },
      }]);
      expect(result.trace?.steps).toContainEqual({ stepId: GATE, kind: "consent", event: "consent_decided", consent: { key: "health", decision: "granted" } });
    });

    it("never fills a covered slot from the message that grants it", async () => {
      const port = consentPort({ reply: { decision: "granted", method: "reply" } });
      const runner = runnerWith(intake(), port, reading({ pregnant: true }));

      const result = await runner.resume({ turn: turn("yes, and I'm pregnant"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(result.response.answer).toBe("[ask_health]");
      expect(result.nextState?.variables).toEqual({ name: "Ada" });
    });

    it("answers an unclear reply and shows the consent again, then counts a second unclear reply as declined", async () => {
      const port = consentPort({ reply: { decision: "unclear", method: "reply" } });
      const render = renderer();
      const runner = runnerWith(intake(), port, reading({}), render);

      const first = await runner.resume({ turn: turn("what do you do with it?"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(first.response.answer).toBe("Only the text says. [wording health] Agree / Decline");
      expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({ reask: true }));
      expect(first.nextState).toMatchObject({ path: ["ask_name", GATE], reaskCount: 1, status: "active" });
      expect(first.hostEffects?.consentEvents).toEqual([
        { kind: "asked", routineId: "intake", consentKey: "health", reask: true, wording: { version: "v1", reask: true } },
      ]);

      const second = await runner.resume({ turn: turn("ok"), state: first.nextState! });

      expect(second.hostEffects?.consentEvents).toEqual([expect.objectContaining({
        kind: "decided",
        decision: "declined",
        method: "reply",
        defaulted: true,
      })]);
      expect(port.prompt).toHaveBeenCalledTimes(1);
      // Declined with `continue`: the collecting step is never asked, and the routine goes on.
      expect(render.render).not.toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: "ask_health" }) }));
      expect(second.terminal).toMatchObject({ kind: "complete", stepId: "done" });
      expect(second.endedVariables).toEqual({ name: "Ada" });
      expect(second.trace?.steps).toContainEqual({
        stepId: GATE,
        kind: "consent",
        event: "consent_decided",
        consent: { key: "health", decision: "declined", defaulted: true },
      });
    });
  });

  describe("declining", () => {
    it("runs on without the covered slots when the decline choice is continue: their step is not asked and guards read them absent", async () => {
      const port = consentPort({ reply: { decision: "declined", method: "button" } });
      const render = renderer();
      const routine = intake("continue", {
        healthExits: [
          { from: "ask_health", to: "prenatal", condition: "", guard: { kind: "field", ref: "pregnant", op: "is_present" } },
          { from: "ask_health", to: "done", condition: "", guard: { kind: "default" } },
        ],
      });
      const runner = runnerWith(routine, port, reading({}), render);

      const result = await runner.resume({ turn: turn("Decline"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(render.render).toHaveBeenCalledTimes(1);
      expect(render.render).toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: "done" }) }));
      expect(result.terminal).toMatchObject({ kind: "complete", stepId: "done", collected: { name: "Ada" } });
      expect(result.hostEffects?.consentEvents).toEqual([expect.objectContaining({ kind: "decided", decision: "declined", defaulted: false })]);
    });

    it("hands the conversation to a person when the decline choice is handoff, holding no covered value", async () => {
      const port = consentPort({ reply: { decision: "declined", method: "reply" } });
      const render = renderer();
      const routine: Routine = {
        ...intake("handoff"),
        completionExport: { enabled: true, destinationRef: "dest_1", triggerKinds: ["complete", "handoff"] },
      };
      const runner = runnerWith(routine, port, reading({ pregnant: true }), render);

      const result = await runner.resume({ turn: turn("No, and I'm pregnant"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(result.nextState).toBeNull();
      expect(result.terminal).toEqual({ kind: "consent_declined", stepId: GATE, collected: { name: "Ada" } });
      expect(result.endedVariables).toEqual({ name: "Ada" });
      expect(result.actions).toBeUndefined();
      expect(result.response.answer).toBe(`[${GATE}] a person continues`);
      expect(render.render).toHaveBeenCalledWith(expect.objectContaining({ steering: [], stuckHandoff: true }));
      expect(result.trace).toMatchObject({ landedStepId: GATE, terminalKind: "consent_declined" });
      expect(result.hostEffects?.consentEvents).toEqual([expect.objectContaining({ kind: "decided", decision: "declined" })]);
    });

    it("reads a withdrawn grant as declined: the consent is not asked again and the erased value is not used", async () => {
      const port = consentPort({ decisions: { health: "declined" } });
      const render = renderer();
      const runner = runnerWith(intake(), port, reading({ name: "Ada" }), render);

      const result = await runner.resume({ turn: turn("I'm Ada"), state: state(["ask_name"], { pregnant: true }) });

      expect(port.prompt).not.toHaveBeenCalled();
      expect(result.terminal).toMatchObject({ kind: "complete", stepId: "done" });
      expect(result.endedVariables).toEqual({ name: "Ada" });
      expect(result.hostEffects).toBeUndefined();
      expect(result.trace?.steps).toContainEqual({ stepId: GATE, kind: "consent", event: "consent_reused", consent: { key: "health", decision: "declined" } });
    });
  });

  describe("a consent that cannot be asked takes the decline path and records no decision", () => {
    const cases = [
      { label: "a channel that asks no consent (voice, a calling agent)", port: () => consentPort({ asks: false }), reason: "channel" },
      { label: "wording the host cannot show", port: () => consentPort({ wordingAvailable: false }), reason: "wording_unavailable" },
      { label: "no consent port", port: () => undefined, reason: "no_port" },
    ] as const;

    it.each(cases)("continues without the covered slot on $label", async ({ port, reason }) => {
      const render = renderer();
      const runner = runnerWith(intake("continue"), port(), reading({ name: "Ada" }), render);

      const result = await runner.resume({ turn: turn("I'm Ada"), state: state(["ask_name"]) });

      expect(result.terminal).toMatchObject({ kind: "complete", stepId: "done" });
      expect(render.render).not.toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: "ask_health" }) }));
      expect(result.hostEffects?.consentEvents).toEqual([{ kind: "skipped", routineId: "intake", consentKey: "health", reason }]);
      expect(result.trace?.steps).toContainEqual({ stepId: GATE, kind: "consent", event: "consent_skipped", consent: { key: "health", reason } });
    });

    it.each(cases)("hands off on $label when the decline choice is handoff", async ({ port, reason }) => {
      const runner = runnerWith(intake("handoff"), port(), reading({ name: "Ada" }));

      const result = await runner.resume({ turn: turn("I'm Ada"), state: state(["ask_name"]) });

      expect(result.terminal).toEqual({ kind: "consent_declined", stepId: GATE, collected: { name: "Ada" } });
      expect(result.hostEffects?.consentEvents).toEqual([{ kind: "skipped", routineId: "intake", consentKey: "health", reason }]);
    });

    it("takes the decline path when the host cannot tell which wording a reply answers", async () => {
      const port = consentPort({ reply: null });
      const runner = runnerWith(intake("handoff"), port);

      const result = await runner.resume({ turn: turn("yes"), state: state(["ask_name", GATE], { name: "Ada" }) });

      expect(result.terminal?.kind).toBe("consent_declined");
      expect(result.hostEffects?.consentEvents).toEqual([
        { kind: "skipped", routineId: "intake", consentKey: "health", reason: "wording_unavailable" },
      ]);
    });
  });

  describe("a covered value given before the consent is granted", () => {
    it("is not kept from the message that starts the routine", async () => {
      const port = consentPort();
      const runner = runnerWith(intake(), port, reading({}));

      const result = await runner.resume({
        turn: turn("I'm Ada and I'm pregnant"),
        state: state([], { name: "Ada", pregnant: true }),
        activationTurn: true,
      });

      expect(result.response.answer).toBe("[wording health] Agree / Decline");
      expect(result.nextState?.variables).toEqual({ name: "Ada" });
      expect(result.trace?.steps[0]?.rejectedSlots).toEqual([{ key: "pregnant", reason: "consent" }]);
    });

    it("is not kept from a reply to an earlier step, and does not hold that step", async () => {
      const port = consentPort();
      const runner = runnerWith(intake(), port, reading({ name: "Ada", pregnant: true }));

      const result = await runner.resume({ turn: turn("Ada, and I'm pregnant"), state: state(["ask_name"]) });

      expect(result.nextState).toMatchObject({ path: ["ask_name", GATE], variables: { name: "Ada" } });
      expect(result.response.answer).toBe("[wording health] Agree / Decline");
    });

    it("is not kept from the input of a routine invoked as a tool", async () => {
      const port = consentPort({ asks: false });
      const runner = runnerWith(intake(), port, reading({}), renderer(), { openingMessageStatesSlotValues: false });

      const result = await runner.resume({
        turn: turn('{"name":"Ada","pregnant":true}'),
        state: state([], { name: "Ada", pregnant: true }),
        activationTurn: true,
      });

      expect(result.endedVariables).toEqual({ name: "Ada" });
      expect(result.trace?.steps[0]?.rejectedSlots).toEqual([{ key: "pregnant", reason: "consent" }]);
    });
  });

  it("asks a routine without consents nothing and reads no standing", async () => {
    const port = consentPort();
    const { consents: _none, ...routine } = intake();
    const plain: Routine = {
      ...routine,
      steps: routine.steps.filter((step) => step.kind !== "consent"),
      transitions: [
        { from: "ask_name", to: "ask_health", condition: "", guard: { kind: "slot_filled", slots: ["name"] } },
        ...routine.transitions.filter((transition) => transition.from === "ask_health"),
      ],
    };
    const runner = runnerWith(plain, port, reading({ name: "Ada" }));

    const result = await runner.resume({ turn: turn("Ada"), state: state(["ask_name"]) });

    expect(port.standing).not.toHaveBeenCalled();
    expect(result.response.answer).toBe("[ask_health]");
  });
});
