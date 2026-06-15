import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import type {
  ClarificationCandidate,
  ConversationEvent,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  ProcessTurnInput,
  RoutineState,
  TurnOutcome,
} from "@radioso/conversation-contract";

const createInput = (overrides: Partial<ProcessTurnInput> = {}): ProcessTurnInput => {
  const events: ConversationEvent[] = [];
  return {
    agent: { id: "agent_1", name: "Assistant" },
    sessionId: "session_1",
    inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
    skills: [
      { name: "order.status", description: "Looks up order status", outcomeKinds: ["generic"] },
    ],
    directives: [
      {
        name: "be-brief",
        condition: { kind: "always" },
        action: "Keep the response concise.",
        priority: 10,
      },
    ],
    stores: {
      loadHistory: vi.fn().mockResolvedValue([{ role: "user", content: "Previous turn" }]),
      appendEvent: vi.fn(async (event: ConversationEvent) => {
        events.push(event);
      }),
    },
    modelGateway: {
      complete: vi.fn(),
    },
    directiveMatcher: {
      match: vi.fn(async ({ directives }) => [
        {
          directive: directives[0],
          selectionMode: "deterministic",
          selectionReason: "always",
        },
      ]),
    },
    selector: {
      select: vi.fn(async () => ({
        selected: [{ skillName: "order.status", input: { orderId: "A1" }, reason: "selected_by_test" }],
        reason: "test selector",
      })),
    },
    dispatcher: {
      dispatch: vi.fn(async ({ skill, turn, selected }): Promise<TurnOutcome> => ({
        kind: "generic",
        skillName: skill.name,
        outcome: {
          status: "completed",
          answer: "Your order ships tomorrow.",
          outputs: { orderId: selected.input },
          guidance: [{ action: "Mention shipment timing.", priority: 5 }],
        },
        stagedContext: [{ kind: "order", data: { status: "shipping" } }],
        steering: turn.steering,
        trace: {
          traceId: "skill-trace",
          startedAt: new Date(0).toISOString(),
          stages: [],
        },
      })),
    },
    composer: {
      compose: vi.fn(async ({ turn, outcomes }) => ({
        answer: outcomes[0]?.outcome.answer ?? "",
        metadata: {
          steeringCount: turn.steering.length,
          stagedContextCount: turn.stagedContext.length,
        },
      })),
    },
    ...overrides,
  };
};

describe("DefaultConversationEngine", () => {
  it("runs a pure gather-select-dispatch-compose turn through contract ports", async () => {
    const input = createInput();
    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.stores.loadHistory).toHaveBeenCalledWith({ sessionId: "session_1" });
    expect(input.directiveMatcher.match).toHaveBeenCalledWith({
      turn: expect.objectContaining({ sessionId: "session_1", steering: [] }),
      directives: input.directives,
    });
    expect(input.selector.select).toHaveBeenCalledWith({
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive", action: "Keep the response concise." })],
      }),
      skills: input.skills,
      directives: [expect.objectContaining({ selectionReason: "always" })],
    });
    expect(input.dispatcher.dispatch).toHaveBeenCalledWith({
      skill: input.skills[0],
      selected: expect.objectContaining({ skillName: "order.status" }),
      turn: expect.objectContaining({
        steering: [expect.objectContaining({ source: "directive" })],
      }),
    });
    expect(input.composer.compose).toHaveBeenCalledWith({
      turn: expect.objectContaining({
        stagedContext: [expect.objectContaining({ kind: "order" })],
        steering: [
          expect.objectContaining({ source: "directive" }),
          expect.objectContaining({ source: "skill", action: "Mention shipment timing." }),
        ],
      }),
      outcomes: [expect.objectContaining({ skillName: "order.status" })],
      decision: expect.objectContaining({
        steeringConsidered: [
          expect.objectContaining({ source: "directive" }),
          expect.objectContaining({ source: "skill" }),
        ],
      }),
    });
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
    expect(result.response.answer).toBe("Your order ships tomorrow.");
    expect(result.events).toHaveLength(2);
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });

  it("copies a capability sub-trace from the outcome onto its dispatch stage", async () => {
    const subTrace = { namespace: "retrieval", version: 1, payload: { candidates: 3 } };
    const input = createInput({
      dispatcher: {
        dispatch: vi.fn(async ({ skill, turn }): Promise<TurnOutcome> => ({
          kind: "generic",
          skillName: skill.name,
          outcome: { status: "completed", answer: "ok" },
          stagedContext: [],
          steering: turn.steering,
          trace: { traceId: "skill-trace", startedAt: new Date(0).toISOString(), stages: [] },
          subTrace,
        })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    const dispatchStage = result.trace.stages.find((stage) => stage.kind === "skill_dispatch");
    expect(dispatchStage?.subTrace).toEqual(subTrace);
  });

  it("leaves the dispatch stage sub-trace absent when the outcome has none", async () => {
    const result = await new DefaultConversationEngine().processTurn(createInput());
    const dispatchStage = result.trace.stages.find((stage) => stage.kind === "skill_dispatch");
    expect(dispatchStage).toBeDefined();
    expect(dispatchStage?.subTrace).toBeUndefined();
  });

  it("records a failed outcome when selection names an unregistered skill", async () => {
    const input = createInput({
      selector: {
        select: vi.fn(async () => ({
          selected: [{ skillName: "missing.skill" }],
        })),
      },
      composer: {
        compose: vi.fn(async ({ outcomes }) => ({
          answer: outcomes[0]?.outcome.error?.message ?? "",
        })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        skillName: "missing.skill",
        outcome: expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({ code: "skill_not_found" }),
        }),
      }),
    ]);
    expect(result.response.answer).toContain("missing.skill");
    expect(result.trace.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill_dispatch", status: "failed" }),
      ]),
    );
  });

  it("streams a turn through the same gather-select-dispatch stages and yields a final result", async () => {
    const input: ProcessTurnStreamInput = {
      ...createInput(),
      composer: {
        compose: vi.fn(),
        async *stream({ outcomes }) {
          yield { type: "delta", text: "Your order " };
          yield { type: "delta", text: "ships tomorrow." };
          yield {
            type: "final",
            response: {
              answer: outcomes[0]?.outcome.answer ?? "",
              metadata: { streamed: true },
            },
          };
        },
      },
    };

    const events: ProcessTurnStreamEvent[] = [];
    for await (const event of new DefaultConversationEngine().processTurnStream(input)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["delta", "delta", "final"]);
    expect(events[0]).toMatchObject({ type: "delta", text: "Your order " });
    const final = events.at(-1);
    expect(final).toMatchObject({
      type: "final",
      result: {
        sessionId: "session_1",
        response: { answer: "Your order ships tomorrow." },
      },
    });
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
    expect(input.composer.compose).not.toHaveBeenCalled();
    expect(final?.type === "final" ? final.result.trace.stages.map((stage) => stage.kind) : []).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });
});

describe("DefaultConversationEngine routines (resume-first substrate)", () => {
  const activeState: RoutineState = {
    sessionId: "session_1",
    routineId: "contact",
    path: ["ask_email"],
    variables: {},
    status: "active",
  };

  const withRoutine = (
    runner: ProcessTurnInput["routineRunner"],
    loaded: RoutineState | null = activeState,
  ): ProcessTurnInput => ({
    ...createInput(),
    routineStore: {
      loadActive: vi.fn(async () => loaded),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
    routineRunner: runner,
  });

  it("resumes an active routine before normal selection and short-circuits select/dispatch/compose", async () => {
    const nextState: RoutineState = { ...activeState, path: ["ask_email", "ask_message"], variables: { email: "x@y.z" } };
    const input = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "What's your message?" }, nextState })),
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.routineStore!.loadActive).toHaveBeenCalledWith({ sessionId: "session_1" });
    expect(input.routineRunner!.resume).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        sessionId: "session_1",
        activeRoutineId: "contact",
        activeStepId: "ask_email",
      }),
      state: activeState,
      steeringResolver: expect.objectContaining({ resolve: expect.any(Function) }),
    }));
    // Normal turn machinery is bypassed.
    expect(input.selector.select).not.toHaveBeenCalled();
    expect(input.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(input.composer.compose).not.toHaveBeenCalled();
    // Next state persisted; input + response events appended.
    expect(input.routineStore!.save).toHaveBeenCalledWith(nextState);
    expect(input.routineStore!.clear).not.toHaveBeenCalled();
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
    expect(result.response.answer).toBe("What's your message?");
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "routine_resume",
      "directive_steering",
    ]);
  });

  it("clears routine state when the routine completes (null next state)", async () => {
    const input = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "Sent — thanks!" }, nextState: null })),
    });

    await new DefaultConversationEngine().processTurn(input);

    expect(input.routineStore!.clear).toHaveBeenCalledWith({ sessionId: "session_1" });
    expect(input.routineStore!.save).not.toHaveBeenCalled();
  });

  it("falls through to the normal turn when no routine is active", async () => {
    const input = withRoutine(
      { resume: vi.fn() },
      null,
    );

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
    expect(input.selector.select).toHaveBeenCalled();
    expect(input.composer.compose).toHaveBeenCalled();
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });

  it("leaves behavior unchanged when no routine store is wired", async () => {
    const input = createInput();
    const result = await new DefaultConversationEngine().processTurn(input);
    expect(result.trace.stages.map((stage) => stage.kind)).toContain("compose");
  });

  it("streams a resumed routine as a single delta plus final, bypassing the composer stream", async () => {
    const base = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "What's your email?" }, nextState: activeState })),
    });
    const input: ProcessTurnStreamInput = {
      ...base,
      composer: {
        compose: vi.fn(),
        stream: vi.fn(async function* () {
          yield { type: "final", response: { answer: "should not run" } };
        }),
      },
    };

    const events: ProcessTurnStreamEvent[] = [];
    for await (const event of new DefaultConversationEngine().processTurnStream(input)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["delta", "final"]);
    expect(events[0]).toMatchObject({ type: "delta", text: "What's your email?" });
    expect(input.composer.stream).not.toHaveBeenCalled();
    const final = events.at(-1);
    expect(final?.type === "final" ? final.result.response.answer : "").toBe("What's your email?");
  });

  it("activates a new routine at its root when the activator claims an idle turn", async () => {
    const started: RoutineState = { ...activeState, path: ["ask_email"] };
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
      routineActivator: { activate: vi.fn(async () => ({ kind: "activate", routineId: "contact" })) },
      routineRunner: { resume: vi.fn(async () => ({ response: { answer: "What's your email?" }, nextState: started })) },
    };

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.routineActivator!.activate).toHaveBeenCalledWith({ turn: expect.objectContaining({ sessionId: "session_1" }) });
    expect(input.routineRunner!.resume).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        sessionId: "session_1",
        activeRoutineId: "contact",
        activeStepId: undefined,
      }),
      // A fresh routine starts at its root (empty path).
      state: expect.objectContaining({ routineId: "contact", path: [], status: "active" }),
      steeringResolver: expect.objectContaining({ resolve: expect.any(Function) }),
    }));
    expect(input.routineStore!.save).toHaveBeenCalledWith(started);
    expect(input.selector.select).not.toHaveBeenCalled();
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "routine_activate",
      "directive_steering",
    ]);
  });

  it("emits clarification trace metadata before routine activation for silent auto-picks", async () => {
    const started: RoutineState = { ...activeState, path: ["ask_email"] };
    const candidate: ClarificationCandidate = {
      id: "contact",
      label: "Contact",
      confidence: 0.91,
      payload: { routineId: "contact" },
    };
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
      routineActivator: {
        activate: vi.fn(async () => ({
          kind: "activate",
          routineId: "contact",
          decisionMetadata: {
            consideredCandidates: [
              candidate,
              { id: "demo", label: "Demo", confidence: 0.72, payload: { routineId: "demo" } },
            ],
            decision: { kind: "auto_pick", candidate, reason: "clear_margin" },
            reason: "clear_margin",
            margin: 0.19,
          },
        })),
      },
      routineRunner: { resume: vi.fn(async () => ({ response: { answer: "What's your email?" }, nextState: started })) },
    };

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "clarification",
      "routine_activate",
      "directive_steering",
    ]);
    expect(result.trace.stages.find((stage) => stage.kind === "clarification")?.outputs).toMatchObject({
      surface: "routine_activation",
      decision: "auto_picked",
      reason: "clear_margin",
      margin: 0.19,
      chosenCandidateId: "contact",
      candidates: [
        { id: "contact", label: "Contact", confidence: 0.91 },
        { id: "demo", label: "Demo", confidence: 0.72 },
      ],
    });
  });

  it("asks a clarification question when routine activation returns comparable candidates", async () => {
    const candidates: ClarificationCandidate[] = [
      {
        id: "demo",
        label: "Demo call",
        description: "User wants to book a demo.",
        confidence: 0.82,
        payload: { routineId: "demo", variables: { company: "Acme" } },
      },
      {
        id: "support",
        label: "Support call",
        description: "User wants help from support.",
        confidence: 0.79,
        payload: { routineId: "support", variables: { topic: "billing" } },
      },
    ];
    const clarificationStore = { loadPending: vi.fn(), save: vi.fn(async () => {}), clear: vi.fn() };
    const clarifier = {
      phraseQuestion: vi.fn(async () => "Do you want a demo call or a support call?"),
      mapReply: vi.fn(),
    };
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(), clear: vi.fn() },
      routineActivator: { activate: vi.fn(async () => ({ kind: "clarify", candidates })) },
      routineRunner: { resume: vi.fn() },
      clarifier,
      clarificationStore,
    };

    const result = await new DefaultConversationEngine().processTurn(input);

    // Global directives co-compose into the clarifying question: no routine is
    // active yet (we're disambiguating which to start), so the matched directive
    // reaches the clarifier as turn steering, exactly like the resume path.
    expect(clarifier.phraseQuestion).toHaveBeenCalledWith({
      candidates,
      turn: expect.objectContaining({
        sessionId: "session_1",
        steering: [expect.objectContaining({ source: "directive", action: "Keep the response concise." })],
      }),
    });
    expect(clarificationStore.save).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1",
      source: "routine_activation",
      candidates,
      status: "pending",
      askedEventId: expect.any(String),
      expiresAt: expect.any(Date),
    }));
    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
    expect(input.routineStore!.save).not.toHaveBeenCalled();
    expect(input.selector.select).not.toHaveBeenCalled();
    expect(input.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(input.composer.compose).not.toHaveBeenCalled();
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
    expect(result.response.answer).toBe("Do you want a demo call or a support call?");
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({
      role: "assistant",
      kind: "assistant.response",
      content: "Do you want a demo call or a support call?",
    });
    expect(result.decision.reason).toBe("routine_activation_clarification");
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "clarification",
      "directive_steering",
    ]);
    expect(result.trace.stages.at(-1)?.outputs).toMatchObject({
      matchCount: 1,
      directives: [expect.objectContaining({ action: "Keep the response concise." })],
    });
    expect(result.trace.stages.find((stage) => stage.kind === "clarification")?.outputs).toMatchObject({
      surface: "routine_activation",
      decision: "asked",
      candidates: [
        { id: "demo", label: "Demo call", confidence: 0.82 },
        { id: "support", label: "Support call", confidence: 0.79 },
      ],
    });
  });

  it("declines activation and runs the normal turn when the activator returns null", async () => {
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(), clear: vi.fn() },
      routineActivator: { activate: vi.fn(async () => null) },
      routineRunner: { resume: vi.fn() },
    };

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
    expect(input.selector.select).toHaveBeenCalled();
    expect(input.composer.compose).toHaveBeenCalled();
    expect(result.trace.stages.map((stage) => stage.kind)).toContain("compose");
  });

  it("yields an active routine to the normal turn without appending input or persisting", async () => {
    const input = withRoutine({ resume: vi.fn(async () => ({ yielded: true, response: { answer: "" }, nextState: null })) });

    const result = await new DefaultConversationEngine().processTurn(input);

    // Fell through to the normal turn; routine state left untouched for a later resume.
    expect(input.routineRunner!.resume).toHaveBeenCalled();
    expect(input.routineStore!.save).not.toHaveBeenCalled();
    expect(input.routineStore!.clear).not.toHaveBeenCalled();
    expect(input.selector.select).toHaveBeenCalled();
    expect(input.composer.compose).toHaveBeenCalled();
    expect(result.trace.stages.map((stage) => stage.kind)).toContain("compose");
    // The input event is appended exactly once (by the normal path, not twice).
    expect(input.stores.appendEvent).toHaveBeenCalledTimes(2);
  });

  it("seeds initial variables from the activator when starting a routine", async () => {
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
      routineActivator: { activate: vi.fn(async () => ({ kind: "activate", routineId: "contact", variables: { email: "a@b.c" } })) },
      routineRunner: {
        resume: vi.fn(async () => ({ response: { answer: "What's your message?" }, nextState: { ...activeState, variables: { email: "a@b.c" } } })),
      },
    };

    await new DefaultConversationEngine().processTurn(input);

    expect(input.routineRunner!.resume).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        sessionId: "session_1",
        activeRoutineId: "contact",
        activeStepId: undefined,
      }),
      state: expect.objectContaining({ routineId: "contact", path: [], variables: { email: "a@b.c" } }),
      steeringResolver: expect.objectContaining({ resolve: expect.any(Function) }),
    }));
  });

  it("surfaces routine action requests on the turn result for the host to persist", async () => {
    const input = withRoutine({
      resume: vi.fn(async () => ({
        response: { answer: "Your request has been received." },
        nextState: null,
        actions: [{ type: "contact.send", payload: { email: "a@b.c", message: "hi" } }],
      })),
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(result.actions).toEqual([{ type: "contact.send", payload: { email: "a@b.c", message: "hi" } }]);
  });
});
