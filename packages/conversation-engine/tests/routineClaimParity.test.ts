import { describe, expect, it } from "vitest";

import type {
  AttemptRoutineInput,
  ConversationRoutineNextStepSelector,
  ConversationRoutineRunner,
  ConversationRoutineTurnClaim,
  ConversationRoutineStepRenderer,
  ProcessTurnResult,
  Routine,
  RoutineNextStepDecision,
  RoutineState,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine, DefaultRoutineRunner } from "../src/index.js";
import { RoutineActivationFailure } from "../src/routineActivation.js";

/**
 * Golden record of one routine turn through `attemptRoutine`: every port call in the
 * order it happens, and the turn result. Recorded on the code before the claim/render
 * split; claiming then rendering then settling must reproduce it exactly, because a
 * host's per-call usage keys follow model-call order.
 */

const routine: Routine = {
  id: "contact",
  rootStepId: "ask_email",
  slots: [
    { id: "slot_email", key: "email", type: "email", required: true },
    { id: "slot_message", key: "message", type: "text", required: true },
  ],
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask for the visitor's email.", metadata: { collectsSlots: ["email"] } },
    {
      id: "ask_message",
      kind: "chat",
      action: "Ask what {{slot.email}} wants to tell us.",
      metadata: { collectsSlots: ["message"] },
    },
    { id: "lookup", kind: "skill", skillName: "retrieval.context" },
    { id: "answer_from_docs", kind: "chat", action: "Answer from the retrieved excerpts." },
    { id: "notify", kind: "action", actionType: "contact.notify" },
    {
      id: "done",
      kind: "terminal",
      action: "Confirm we will be in touch.",
      metadata: { terminalKind: "complete", operatorNotice: { subject: "New contact" } },
    },
    { id: "to_person", kind: "terminal", action: "Say a person continues.", metadata: { terminalKind: "handoff" } },
    {
      id: "approve",
      kind: "await",
      action: "Say the request waits for approval.",
      decision: { captureKey: "approval", options: [{ id: "yes", label: "Approve" }] },
    },
  ],
  transitions: [
    { from: "ask_email", to: "ask_message", condition: "an email was given" },
    { from: "ask_email", to: "to_person", condition: "they want a person" },
    { from: "ask_message", to: "notify", condition: "a message was given" },
    { from: "ask_message", to: "lookup", condition: "they asked a question" },
    { from: "ask_message", to: "approve", condition: "the request needs approval" },
    { from: "notify", to: "done", condition: "always" },
    { from: "lookup", to: "answer_from_docs", condition: "always" },
    { from: "answer_from_docs", to: "done", condition: "the visitor is satisfied" },
  ],
  completionExport: { enabled: true, destinationRef: "dest_1", triggerKinds: ["complete"] },
};

const activeOn = (stepId: string, extra: Partial<RoutineState> = {}): RoutineState => ({
  sessionId: "session_1",
  routineId: "contact",
  executionId: "exec_1",
  path: stepId === "ask_email" ? [] : ["ask_email", "ask_message"],
  variables: stepId === "ask_email" ? {} : { email: "alex@example.com" },
  status: "active",
  ...extra,
});

interface ParityScenario {
  name: string;
  message: string;
  active?: RoutineState;
  completed?: RoutineState[];
  decisions?: RoutineNextStepDecision[];
  activation?: "activate" | "clarify";
  correction?: boolean;
}

const parityScenarios: ParityScenario[] = [
  { name: "slot ask on activation", message: "I want to contact you", activation: "activate", decisions: [{ nextStepId: "ask_email" }] },
  { name: "re-ask", message: "not sure", active: activeOn("ask_email"), decisions: [{ nextStepId: "ask_email" }] },
  {
    name: "exhausted re-ask",
    message: "still not sure",
    active: activeOn("ask_email", { reaskCount: 3 }),
    decisions: [{ nextStepId: "ask_email" }],
  },
  {
    name: "step instruction",
    message: "alex@example.com",
    active: activeOn("ask_email"),
    decisions: [{ nextStepId: "ask_message", variables: { email: "alex@example.com" } }],
  },
  {
    name: "terminal with action",
    message: "please call me back",
    active: activeOn("ask_message"),
    decisions: [{ nextStepId: "notify", variables: { message: "please call me back" } }],
  },
  {
    name: "handoff",
    message: "a person please",
    active: activeOn("ask_email"),
    decisions: [{ nextStepId: "to_person" }],
  },
  {
    name: "stuck",
    message: "no",
    active: activeOn("ask_email", { reaskCount: 4 }),
    decisions: [{ nextStepId: "ask_email" }],
  },
  {
    name: "approval",
    message: "this needs a sign-off",
    active: activeOn("ask_message"),
    decisions: [{ nextStepId: "approve" }],
  },
  {
    name: "grounded step",
    message: "what are your hours?",
    active: activeOn("ask_message"),
    decisions: [{ nextStepId: "lookup" }],
  },
  {
    name: "activation clarification",
    message: "help",
    activation: "clarify",
  },
  {
    name: "slot correction",
    message: "my email is actually new@example.com",
    completed: [{ ...activeOn("ask_message"), status: "completed" }],
    correction: true,
  },
];

const yieldScenario: ParityScenario = {
  name: "yield",
  message: "what's the weather?",
  active: activeOn("ask_message"),
  decisions: [{ nextStepId: "ask_message", yieldTurn: true }],
};

interface Recorded {
  calls: string[];
  result: unknown;
}

const harness = (scenario: ParityScenario) => {
  const calls: string[] = [];
  const decisions = [...(scenario.decisions ?? [])];
  const selector: ConversationRoutineNextStepSelector = {
    select: async ({ currentStep }) => {
      calls.push(`select:${currentStep.id}`);
      return decisions.shift() ?? { nextStepId: currentStep.id };
    },
  };
  const renderer: ConversationRoutineStepRenderer = {
    render: async ({ step, steering, turn, reask, stuckHandoff }) => {
      calls.push(
        `render:${step.id}${reask ? `:reask(${reask.missingSlots.map((slot) => slot.key).join(",")})` : ""}`
          + `${reask?.exhausted ? ":exhausted" : ""}${stuckHandoff ? ":stuck" : ""}`
          + `:steering=${steering.length}:staged=${turn.stagedContext.length}`,
      );
      return { answer: `reply:${step.id}`, metadata: { renderedStep: step.id } };
    },
  };
  const runner = new DefaultRoutineRunner([routine], selector, renderer, {
    dispatch: async ({ skillName }) => {
      calls.push(`dispatch:${skillName}`);
      return { status: "success", outputs: { contexts: [{ title: "Hours", content: "9 to 5" }] } };
    },
  });
  const input: AttemptRoutineInput = {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: scenario.message },
    stores: {
      loadHistory: async () => {
        calls.push("loadHistory");
        return [];
      },
      appendEvent: async (event) => {
        calls.push(`appendEvent:${event.role ?? event.kind}`);
      },
    },
    directives: [],
    directiveMatcher: {
      match: async ({ turn }) => {
        calls.push(`directiveMatcher:${turn.activeStepId ?? "-"}`);
        return [];
      },
    },
    routineStore: {
      loadActive: async () => {
        calls.push("loadActive");
        return scenario.active ?? null;
      },
      loadCompleted: async () => {
        calls.push("loadCompleted");
        return scenario.completed ?? [];
      },
      save: async (state) => {
        calls.push(`save:${state.status}:${state.path.join(">")}:${Object.keys(state.variables).sort().join(",")}`);
      },
      clear: async () => {
        calls.push("clear");
      },
    },
    routineRunner: runner,
    routineActivator: {
      activate: async () => {
        calls.push("activate");
        if (scenario.activation === "activate") {
          return { kind: "activate", routineId: "contact" };
        }
        if (scenario.activation === "clarify") {
          return {
            kind: "clarify",
            candidates: [{ id: "contact", label: "Contact", confidence: 0.5, payload: { routineId: "contact" } }],
          };
        }
        return null;
      },
    },
    ...(scenario.correction
      ? {
          routineSlotCorrection: {
            detect: async () => {
              calls.push("correction.detect");
              return {
                slots: [{ id: "slot_email", key: "email", type: "email", required: true, mutable: true }],
                slotKey: "email",
                rawValue: "new@example.com",
              };
            },
            confirm: async () => {
              calls.push("correction.confirm");
              return "Updated your email.";
            },
            rejectInvalid: async () => {
              calls.push("correction.rejectInvalid");
              return "That is not an email.";
            },
          },
        }
      : {}),
    clarifier: {
      phraseQuestion: async () => {
        calls.push("clarifier.phraseQuestion");
        return "Which one did you mean?";
      },
      mapReply: async () => {
        throw new Error("not used");
      },
    },
    clarificationStore: {
      loadPending: async () => null,
      save: async (pending) => {
        calls.push(`clarificationStore.save:${pending.status}`);
      },
      clear: async () => {},
    },
    progress: { report: ({ phase }) => calls.push(`progress:${phase}`) },
    routineYieldSink: {
      yielded: (routineYield) => {
        calls.push(`yielded:${routineYield.pendingStep?.stepId ?? "-"}`);
      },
    },
  };
  return { calls, input, runner, renderer };
};

const VOLATILE_KEYS = new Set(["startedAt", "completedAt", "createdAt", "traceId", "expiresAt"]);

/** Drops wall-clock values and random ids so two runs of the same turn compare equal. */
const normalize = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value, (key, entry: unknown) => {
        if (VOLATILE_KEYS.has(key)) {
          return "<volatile>";
        }
        if (key === "id" && typeof entry === "string" && entry.startsWith("assistant-")) {
          return "<assistant-event>";
        }
        if (key === "executionId" && typeof entry === "string" && entry !== "exec_1") {
          return "<new-execution>";
        }
        return entry;
      }));

const normalizeTurnResult = (result: ProcessTurnResult | null): unknown => (result === null ? null : normalize(result));

const attempt = async (scenario: ParityScenario): Promise<Recorded> => {
  const { calls, input } = harness(scenario);
  const result = await new DefaultConversationEngine().attemptRoutine(input);
  return { calls, result: normalizeTurnResult(result) };
};

describe("routine turn golden record (attemptRoutine)", () => {
  for (const scenario of parityScenarios) {
    it(`records the same port calls and result for: ${scenario.name}`, async () => {
      expect(await attempt(scenario)).toMatchSnapshot();
    });
  }

  it("records a yielded turn without rendering", async () => {
    const recorded = await attempt(yieldScenario);
    expect(recorded.result).toBeNull();
    expect(recorded.calls.some((call) => call.startsWith("render:"))).toBe(false);
    expect(recorded).toMatchSnapshot();
  });
});

const claimRenderSettle = async (
  scenario: ParityScenario,
  adjust: (prepared: ReturnType<typeof harness>) => void = () => {},
): Promise<Recorded & { callsAtClaim: string[]; claim: ConversationRoutineTurnClaim | null }> => {
  const prepared = harness(scenario);
  adjust(prepared);
  const claim = await new DefaultConversationEngine().claimRoutine(prepared.input);
  const callsAtClaim = [...prepared.calls];
  if (!claim) {
    return { calls: prepared.calls, callsAtClaim, claim, result: null };
  }
  const result = await claim.settle(await claim.reply.render());
  return { calls: prepared.calls, callsAtClaim, claim, result: normalizeTurnResult(result) };
};

const REPLY_GENERATION_CALLS = ["render:", "stream:", "clarifier.phraseQuestion", "correction.confirm", "correction.rejectInvalid"];
const generatesReply = (call: string): boolean => REPLY_GENERATION_CALLS.some((prefix) => call.startsWith(prefix));

describe("DefaultConversationEngine.claimRoutine", () => {
  for (const scenario of [...parityScenarios, yieldScenario]) {
    it(`claim, render, settle reproduces attemptRoutine for: ${scenario.name}`, async () => {
      const { calls, result } = await claimRenderSettle(scenario);
      expect({ calls, result }).toEqual(await attempt(scenario));
    });
  }

  for (const scenario of parityScenarios) {
    it(`claims without generating the reply, reporting the effects the turn settles with: ${scenario.name}`, async () => {
      const { callsAtClaim, claim, result } = await claimRenderSettle(scenario);
      expect(callsAtClaim.some(generatesReply)).toBe(false);
      const settled = result as ProcessTurnResult;
      const routineStage = settled.trace.stages.find((stage) => stage.kind.startsWith("routine_") && stage.id.startsWith("routine:"));
      expect(normalize(claim?.effects)).toEqual(normalize({
        routineExecution: settled.routineExecution,
        terminalKind: routineStage?.outputs?.terminalKind,
        actions: settled.actions,
        awaitingDecision: settled.awaitingDecision,
        handoff: settled.handoff,
        operatorNotice: settled.operatorNotice,
      }));
    });
  }

  it("never touches the step renderer when the routine yields the turn", async () => {
    const { calls, claim } = await claimRenderSettle(yieldScenario, ({ renderer }) => {
      renderer.prepare = () => {
        throw new Error("a yielded turn must not prepare a reply");
      };
    });
    expect(claim).toBeNull();
    expect(calls.some(generatesReply)).toBe(false);
    expect(calls).toContain("yielded:ask_message");
  });

  it("claims through a runner that can only resume, with the reply it already rendered", async () => {
    for (const scenario of parityScenarios) {
      const recorded = await claimRenderSettle(scenario, (prepared) => {
        const resumeOnly: ConversationRoutineRunner = { resume: (input) => prepared.runner.resume(input) };
        prepared.input.routineRunner = resumeOnly;
      });
      expect({ calls: recorded.calls, result: recorded.result }).toEqual(await attempt(scenario));
      expect(recorded.claim?.reply.stream).toBeUndefined();
    }
  });

  it("streams the reply when the step renderer can, and settles the streamed turn like a rendered one", async () => {
    const scenario = parityScenarios.find((candidate) => candidate.name === "step instruction")!;
    const prepared = harness(scenario);
    prepared.renderer.prepare = (input) => ({
      render: () => prepared.renderer.render(input),
      stream: async function* () {
        prepared.calls.push(`stream:${input.step.id}`);
        yield "reply:";
        yield input.step.id;
        return { answer: `reply:${input.step.id}`, metadata: { renderedStep: input.step.id } };
      },
    });
    const claim = (await new DefaultConversationEngine().claimRoutine(prepared.input))!;
    const deltas: string[] = [];
    const stream = claim.reply.stream!();
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value);
      next = await stream.next();
    }
    const result = normalizeTurnResult(await claim.settle(next.value));

    expect(deltas).toEqual(["reply:", "ask_message"]);
    const rendered = await attempt(scenario);
    expect(result).toEqual(rendered.result);
    expect(prepared.calls).toEqual(rendered.calls.map((call) => (call.startsWith("render:") ? "stream:ask_message" : call)));
  });

  it("reports a reply that fails to generate as a failed routine resume, as attemptRoutine does", async () => {
    const scenario = parityScenarios.find((candidate) => candidate.name === "re-ask")!;
    const failing = (prepared: ReturnType<typeof harness>) => {
      prepared.renderer.render = async () => {
        throw new Error("model unavailable");
      };
    };
    const prepared = harness(scenario);
    failing(prepared);
    const claim = (await new DefaultConversationEngine().claimRoutine(prepared.input))!;
    await expect(claim.reply.render()).rejects.toMatchObject({ name: "RoutineActivationFailure", phase: "resume" });

    const attempted = harness(scenario);
    failing(attempted);
    await expect(new DefaultConversationEngine().attemptRoutine(attempted.input)).rejects.toBeInstanceOf(RoutineActivationFailure);
  });
});

describe("DefaultRoutineRunner.claim", () => {
  const resumeInput = (scenario: ParityScenario) => ({
    turn: {
      agent: { id: "agent_1", name: "Assistant" },
      sessionId: "session_1",
      inputEvent: { id: "input_1", kind: "message" as const, content: scenario.message },
      history: [],
      stagedContext: [],
      steering: [],
    },
    state: scenario.active!,
  });
  const resumed = parityScenarios.filter((scenario) => scenario.active);

  for (const scenario of resumed) {
    it(`resumes as claim then render: ${scenario.name}`, async () => {
      const viaResume = harness(scenario);
      const expected = await viaResume.runner.resume(resumeInput(scenario));

      const viaClaim = harness(scenario);
      const claim = await viaClaim.runner.claim(resumeInput(scenario));
      const callsAtClaim = [...viaClaim.calls];
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") return;
      const response = await claim.reply.render();

      expect(callsAtClaim.some(generatesReply)).toBe(false);
      expect({ response, ...claim.effects }).toEqual(expected);
      expect(viaClaim.calls).toEqual(viaResume.calls);
    });
  }

  it("prepares the reply through the step renderer and generates it only when asked", async () => {
    const scenario = parityScenarios.find((candidate) => candidate.name === "terminal with action")!;
    const prepared = harness(scenario);
    prepared.renderer.prepare = (input) => {
      prepared.calls.push(`prepare:${input.step.id}`);
      return { render: () => prepared.renderer.render(input) };
    };
    const claim = await prepared.runner.claim(resumeInput(scenario));
    expect(prepared.calls).toEqual(["select:ask_message", "prepare:done"]);
    expect(claim.kind === "claimed" && claim.reply.stream).toBeUndefined();
  });

  it("yields without preparing a reply", async () => {
    const prepared = harness(yieldScenario);
    prepared.renderer.prepare = () => {
      throw new Error("a yielded turn must not prepare a reply");
    };
    expect(await prepared.runner.claim(resumeInput(yieldScenario))).toEqual({
      kind: "yielded",
      pendingStep: { stepId: "ask_message", instruction: "Ask what [email] wants to tell us.", missingSlotKeys: ["message"] },
    });
  });
});
