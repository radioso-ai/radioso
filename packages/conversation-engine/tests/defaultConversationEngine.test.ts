import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "../src/index.js";
import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ClarificationCandidate,
  ConversationEvent,
  ConversationSkillInputResolver,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  ProcessTurnInput,
  Routine,
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
  it("resolves every declared selection from one immutable snapshot before preserving staged dispatch sequencing", async () => {
    const skills = [
      { name: "first", inputSchema: { fields: [{ name: "id", type: "string" as const, required: true }] } },
      { name: "second", inputSchema: { fields: [{ name: "id", type: "string" as const, required: true }] } },
    ];
    const seenTurns: unknown[] = [];
    const resolver: ConversationSkillInputResolver = {
      resolve: vi.fn(async ({ selected, turn }) => {
        // Record what this call RECEIVED before mutating, so the assertion measures what
        // the next resolver was handed rather than this one's own scribbles.
        seenTurns.push({ turn, staged: [...turn.stagedContext], history: [...turn.history] });
        // A careless or hostile host resolver mutating what it was handed must not change
        // what the next resolver sees.
        turn.stagedContext.push({ kind: `mutated_by_${selected.skillName}`, data: {} });
        turn.history.push({ role: "user", content: `mutated_by_${selected.skillName}` });
        return { kind: "ready", input: { id: selected.skillName }, fields: [{ name: "id", provenance: "model", status: "ready" }] };
      }),
    };
    const dispatchTurns: unknown[] = [];
    const input = createInput({
      skills,
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "first" }, { skillName: "second" }] })) },
      skillInputResolver: resolver,
      dispatcher: {
        dispatch: vi.fn(async ({ skill, turn, selected }): Promise<TurnOutcome> => {
          dispatchTurns.push(turn);
          return {
            kind: "generic",
            skillName: skill.name,
            outcome: { status: "completed", outputs: { id: selected.input } },
            stagedContext: [{ kind: skill.name, data: {} }],
            steering: turn.steering,
            trace: { traceId: skill.name, startedAt: new Date(0).toISOString(), stages: [] },
          };
        }),
      },
    });

    await new DefaultConversationEngine().processTurn(input);

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    const [first, second] = seenTurns as Array<{ turn: unknown; staged: unknown[]; history: unknown[] }>;
    // Independent snapshots, not one shared object.
    expect(first!.turn).not.toBe(second!.turn);
    // The second resolver saw neither the first skill's dispatch output (nothing has
    // dispatched yet) nor the first resolver's mutations.
    expect(second!.staged).toEqual([]);
    expect(second!.history).toEqual(first!.history);
    expect(second!.history).not.toContainEqual({ role: "user", content: "mutated_by_first" });
    expect((dispatchTurns[1] as { stagedContext: unknown[] }).stagedContext).toEqual([
      expect.objectContaining({ kind: "first" }),
    ]);
  });

  it("parks all declared selections before dispatch and forwards awaiting skill input through normal composition", async () => {
    const dispatcher = vi.fn();
    const input = createInput({
      skills: [{ name: "book", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } }],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "book" }] })) },
      skillInputResolver: {
        resolve: vi.fn(async () => ({
          kind: "needs_input",
          fields: [{ name: "date", provenance: "none", status: "absent" }],
          outstanding: [{ name: "date", type: "date", description: "When", reason: "absent" }],
        })),
      },
      dispatcher: { dispatch: dispatcher },
      composer: { compose: vi.fn(async ({ turn }) => ({ answer: turn.steering.map((rule) => rule.action).join(" ") })) },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(dispatcher).not.toHaveBeenCalled();
    expect(result.awaitingSkillInput).toEqual([{ skillName: "book", fields: [{ name: "date", type: "date", description: "When", reason: "absent" }] }]);
    expect(result.response.answer).toContain("date");
  });

  it("preflights every selection and dispatches none when one resolution fails", async () => {
    const dispatcher = vi.fn();
    const composer = vi.fn(async ({ turn }: { turn: { steering: Array<{ source: string }> } }) => ({
      answer: turn.steering.some((rule) => rule.source === "skill") ? "asked" : "ordinary reply",
    }));
    const resolver: ConversationSkillInputResolver = {
      resolve: vi.fn(async ({ selected }) => selected.skillName === "first"
        ? { kind: "ready", input: { date: "2026-08-07" }, fields: [] }
        : { kind: "failed", code: "parse_error", fields: [] }),
    };
    const result = await new DefaultConversationEngine().processTurn(createInput({
      skills: [
        { name: "first", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } },
        { name: "second", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } },
      ],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "first" }, { skillName: "second" }] })) },
      skillInputResolver: resolver,
      dispatcher: { dispatch: dispatcher },
      composer: { compose: composer },
    }));

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(dispatcher).not.toHaveBeenCalled();
    expect(result.awaitingSkillInput).toBeUndefined();
    expect(result.response.answer).toBe("ordinary reply");
  });

  it("does not report awaiting input when another selection failed in the same turn", async () => {
    const dispatcher = vi.fn();
    const composer = vi.fn(async ({ turn }: { turn: { steering: Array<{ source: string }> } }) => ({
      answer: turn.steering.some((rule) => rule.source === "skill") ? "asked" : "ordinary reply",
    }));
    const resolver: ConversationSkillInputResolver = {
      resolve: vi.fn(async ({ selected }) => selected.skillName === "first"
        ? { kind: "needs_input", fields: [], outstanding: [{ name: "date", type: "date", reason: "absent" }] }
        : { kind: "failed", code: "parse_error", fields: [] }),
    };

    const result = await new DefaultConversationEngine().processTurn(createInput({
      skills: [
        { name: "first", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } },
        { name: "second", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } },
      ],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "first" }, { skillName: "second" }] })) },
      skillInputResolver: resolver,
      dispatcher: { dispatch: dispatcher },
      composer: { compose: composer },
    }));

    // A failure composes an ordinary reply (D11), so the turn never asks. Reporting
    // awaited fields here would claim the turn requested values it never mentioned.
    expect(dispatcher).not.toHaveBeenCalled();
    expect(result.response.answer).toBe("ordinary reply");
    expect(result.awaitingSkillInput).toBeUndefined();
  });

  it("asks once for every outstanding field and includes declared choices", async () => {
    const input = createInput({
      skills: [{ name: "book", inputSchema: { fields: [
        { name: "date", type: "date", required: true },
        { name: "style", type: "string", required: true, permittedValues: ["Short", "Long"] },
      ] } }],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "book" }] })) },
      skillInputResolver: {
        resolve: vi.fn(async () => ({
          kind: "needs_input",
          fields: [],
          outstanding: [
            { name: "date", type: "date", reason: "absent" },
            { name: "style", type: "string", permittedValues: ["Short", "Long"], reason: "absent" },
          ],
        })),
      },
      dispatcher: { dispatch: vi.fn() },
      composer: { compose: vi.fn(async ({ turn }) => ({ answer: turn.steering.at(-1)?.action ?? "" })) },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(result.response.answer).toContain("date");
    expect(result.response.answer).toContain("Short, Long");
    expect(result.awaitingSkillInput).toHaveLength(1);
  });

  it("emits a final stream event for a parked skill-input turn", async () => {
    const dispatcher = vi.fn();
    const input = createInput({
      skills: [{ name: "book", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } }],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "book" }] })) },
      skillInputResolver: {
        resolve: vi.fn(async () => ({
          kind: "needs_input",
          fields: [{ name: "date", provenance: "none", status: "absent" }],
          outstanding: [{ name: "date", type: "date", reason: "absent" }],
        })),
      },
      dispatcher: { dispatch: dispatcher },
      composer: {
        async *stream() {
          yield { type: "final" as const, response: { answer: "What date works?" } };
        },
      },
    }) as ProcessTurnStreamInput;

    const events: ProcessTurnStreamEvent[] = [];
    for await (const event of new DefaultConversationEngine().processTurnStream(input)) events.push(event);

    expect(dispatcher).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "final",
      result: { awaitingSkillInput: [{ skillName: "book" }] },
    });
  });

  it("records structural skill-input resolution details without leaking values", async () => {
    const secret = "do-not-trace-this-value";
    const input = createInput({
      skills: [{ name: "book", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } }],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "book", input: { date: secret } }] })) },
      skillInputResolver: {
        resolve: vi.fn(async () => ({
          kind: "needs_input",
          fields: [{ name: "date", provenance: "host", status: "rejected", reason: "invalid_date" }],
          outstanding: [{ name: "date", type: "date", reason: "rejected" }],
        })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);
    const resolution = result.trace.stages.find((stage) => stage.kind === "skill_input_resolution");

    expect(resolution?.outputs).toEqual({
      skillName: "book",
      fields: [{ name: "date", provenance: "host", status: "rejected", reason: "invalid_date" }],
    });
    expect(JSON.stringify(result.trace)).not.toContain(secret);
  });

  it("omits the resolution stage for a no-fields skill without calling the resolver", async () => {
    const resolver: ConversationSkillInputResolver = { resolve: vi.fn() };
    const dispatcher = vi.fn(async ({ selected }): Promise<TurnOutcome> => ({
      kind: "generic",
      skillName: "legacy",
      outcome: { status: "completed" },
      stagedContext: [],
      steering: [],
      trace: { traceId: "legacy", startedAt: new Date(0).toISOString(), stages: [] },
    }));
    const result = await new DefaultConversationEngine().processTurn(createInput({
      skills: [{ name: "legacy" }],
      selector: { select: vi.fn(async () => ({ selected: [{ skillName: "legacy", input: { untouched: true } }] })) },
      skillInputResolver: resolver,
      dispatcher: { dispatch: dispatcher },
    }));

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({
      selected: { skillName: "legacy", input: { untouched: true } },
    }));
    expect(result.trace.stages).not.toContainEqual(expect.objectContaining({
      kind: "skill_input_resolution",
    }));
  });
  it("records wall-clock boundaries for every real stage in the normal turn spine", async () => {
    const now = vi.spyOn(Date, "now");
    let current = Date.parse("2026-07-18T10:00:00.000Z");
    now.mockImplementation(() => {
      current += 10;
      return current;
    });
    const input = createInput({
      turnInterpreter: {
        interpret: vi.fn(async () => ({ route: "retrieval" })),
      },
      retrievalWork: {
        run: vi.fn(async () => ({ stagedContext: [] })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    for (const kind of [
      "turn_interpretation",
      "retrieval_fanout",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]) {
      const traceStage = result.trace.stages.find((candidate) => candidate.kind === kind);
      expect(traceStage, `missing ${kind} stage`).toBeDefined();
      expect(Date.parse(traceStage!.completedAt!) - Date.parse(traceStage!.startedAt!)).toBeGreaterThan(0);
    }

    now.mockRestore();
  });

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

  it("forwards compose adherence to the spine and links directives to compose", async () => {
    const input = createInput({
      composer: {
        compose: vi.fn(async () => ({
          answer: "Your order ships tomorrow.",
          metadata: {
            directiveAdherence: [
              { directive: "be-brief", ruleId: "d1", satisfied: true, note: "kept it concise" },
            ],
          },
        })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(result.trace.stages.find((stage) => stage.kind === "compose")?.outputs).toMatchObject({
      adherence: [{ directive: "be-brief", ruleId: "d1", satisfied: true }],
    });
    expect(result.trace.links).toContainEqual({ from: "directives", to: "compose", kind: "adherence" });
  });

  it("omits compose adherence and its link when the renderer did not report it", async () => {
    const result = await new DefaultConversationEngine().processTurn(createInput());
    const outputs = result.trace.stages.find((stage) => stage.kind === "compose")?.outputs ?? {};

    expect(outputs).not.toHaveProperty("adherence");
    expect(result.trace.links).toBeUndefined();
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

  it("resolves directives before retrieval work so retrieval can consume directive-scoped inputs", async () => {
    const events: string[] = [];
    let finishDirectives!: () => void;
    const input = createInput({
      turnInterpreter: {
        interpret: vi.fn(async () => ({ route: "retrieval", metadata: { queryShape: "general_grounding" } })),
      },
      retrievalWork: {
        run: vi.fn(async () => {
          events.push("retrieval:start");
          expect(events).toContain("directives:finish");
          events.push("retrieval:finish");
          return { stagedContext: [{ kind: "retrieval", data: { count: 1 } }] };
        }),
      },
      directiveMatcher: {
        match: vi.fn(async ({ directives }) => {
          events.push("directives:start");
          await new Promise<void>((resolve) => {
            finishDirectives = resolve;
          });
          events.push("directives:finish");
          return [
            {
              directive: directives[0],
              selectionMode: "deterministic",
              selectionReason: "always",
            },
          ];
        }),
      },
      selector: {
        select: vi.fn(async ({ turn }) => {
          events.push("selection");
          return {
            selected: [{ skillName: "order.status" }],
            reason: `staged:${turn.stagedContext.length}`,
          };
        }),
      },
    });

    const turn = new DefaultConversationEngine().processTurn(input);
    await vi.waitFor(() => {
      expect(events).toEqual(["directives:start"]);
    });
    finishDirectives();
    const result = await turn;

    expect(events).toEqual(["directives:start", "directives:finish", "retrieval:start", "retrieval:finish", "selection"]);
    expect(input.retrievalWork?.run).toHaveBeenCalledWith({
      turn: expect.objectContaining({
        metadata: expect.objectContaining({
          turnRoute: "retrieval",
        }),
      }),
      interpretation: expect.objectContaining({ route: "retrieval" }),
    });
    expect(input.dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({
        stagedContext: [expect.objectContaining({ kind: "retrieval" })],
      }),
    }));
    expect(result.decision.reason).toBe("staged:1");
    expect(result.trace.stages.map((traceStage) => traceStage.kind)).toEqual([
      "message",
      "gather",
      "turn_interpretation",
      "retrieval_fanout",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
  });

  it("redacts model-derived interpretation text from trace outputs", async () => {
    const input = createInput({
      turnInterpreter: {
        interpret: vi.fn(async () => ({
          route: "retrieval",
          framing: {
            isIdentityQuestion: false,
            intentTopic: "sensitive topic",
            inScopeRequest: "answer sensitive request",
            outsideScopeRequest: "ignore private out-of-scope text",
          },
          metadata: {
            rewriteProposal: {
              rewrittenQuery: "private rewritten query",
              semanticQuery: "private semantic query",
              lexicalQuery: "private lexical query",
              queryShape: "general_grounding",
              temporalQueryMode: "none",
              retrievalSubqueries: [
                {
                  label: "private branch",
                  semanticQuery: "private branch semantic",
                  lexicalQuery: "private branch lexical",
                },
              ],
              turnKind: "fresh_subject",
              unresolved: false,
              confidence: 0.9,
            },
          },
        })),
      },
      retrievalWork: {
        run: vi.fn(async () => ({ stagedContext: [{ kind: "retrieval", data: { count: 1 } }] })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    const interpretationStage = result.trace.stages.find((traceStage) => traceStage.kind === "turn_interpretation");
    expect(JSON.stringify(interpretationStage?.outputs)).not.toContain("sensitive");
    expect(JSON.stringify(interpretationStage?.outputs)).not.toContain("private");
    expect(interpretationStage?.outputs).toEqual({
      route: "retrieval",
      framing: {
        isIdentityQuestion: false,
        hasIntentTopic: true,
        hasInScopeRequest: true,
        hasOutsideScopeRequest: true,
      },
      metadata: {
        rewriteProposal: {
          queryShape: "general_grounding",
          temporalQueryMode: "none",
          turnKind: "fresh_subject",
          unresolved: false,
          confidence: 0.9,
          retrievalSubqueryCount: 1,
        },
      },
    });
  });

  it("does not invoke retrieval work for direct interpretations", async () => {
    const input = createInput({
      turnInterpreter: {
        interpret: vi.fn(async () => ({ route: "direct", framing: { isIdentityQuestion: true } })),
      },
      retrievalWork: {
        run: vi.fn(async () => ({ stagedContext: [{ kind: "retrieval", data: {} }] })),
      },
    });

    const result = await new DefaultConversationEngine().processTurn(input);

    expect(input.retrievalWork?.run).not.toHaveBeenCalled();
    const fanout = result.trace.stages.find((traceStage) => traceStage.kind === "retrieval_fanout");
    expect(fanout).toEqual(expect.objectContaining({
      status: "skipped",
      outputs: expect.objectContaining({ route: "direct", stagedContextCount: 0 }),
    }));
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
    const phases: string[] = [];
    const input: ProcessTurnStreamInput = {
      ...createInput(),
      progress: {
        report({ phase }) {
          phases.push(phase);
        },
      },
      composer: {
        compose: vi.fn(),
        async *stream({ outcomes }) {
          yield { type: "delta", text: "Your order " };
          yield { type: "delta", text: "ships tomorrow." };
          yield {
            type: "final",
            response: {
              answer: outcomes[0]?.outcome.answer ?? "",
              metadata: {
                streamed: true,
                traceMetrics: {
                  groundingGateWaitMs: 37,
                  ignoredText: "PRIVATE ANSWER",
                },
              },
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
    expect(phases).toEqual(["selecting", "dispatching", "composing"]);
    expect(final?.type === "final" ? final.result.trace.stages.map((stage) => stage.kind) : []).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
    const composeStage = final?.type === "final"
      ? final.result.trace.stages.findLast((stage) => stage.kind === "compose")
      : undefined;
    expect(composeStage?.metrics).toEqual({ groundingGateWaitMs: 37 });
    expect(JSON.stringify(composeStage)).not.toContain("PRIVATE ANSWER");
  });

  it("reports retrieval progress immediately before each streamed schedule boundary", async () => {
    const phases: string[] = [];
    const input: ProcessTurnStreamInput = {
      ...createInput({
        turnInterpreter: {
          interpret: vi.fn(async () => ({ route: "retrieval" })),
        },
        retrievalWork: {
          run: vi.fn(async () => ({ stagedContext: [] })),
        },
      }),
      progress: {
        report({ phase }) {
          phases.push(phase);
        },
      },
      composer: {
        compose: vi.fn(),
        async *stream() {
          yield { type: "final", response: { answer: "Grounded." } };
        },
      },
    };

    for await (const _event of new DefaultConversationEngine().processTurnStream(input)) {
      // drain
    }

    expect(phases).toEqual([
      "interpreting",
      "retrieving",
      "selecting",
      "dispatching",
      "composing",
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

  it("saves a completed marker when the routine completes (null next state)", async () => {
    const input = withRoutine({
      resume: vi.fn(async () => ({
        response: { answer: "Sent — thanks!" },
        nextState: null,
        terminal: { kind: "complete", stepId: "done" },
        trace: {
          routineId: "contact",
          startStepId: "ask_email",
          landedStepId: "done",
          terminalKind: "complete",
          capturedSlotKeys: [],
          filledSlotKeys: [],
          steps: [],
        },
      })),
    });

    await new DefaultConversationEngine().processTurn(input);

    expect(input.routineStore!.save).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1",
      routineId: "contact",
      status: "completed",
      metadata: expect.objectContaining({ terminalKind: "complete", terminalStepId: "done" }),
    }));
    expect(input.routineStore!.clear).not.toHaveBeenCalled();
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

  it("replays a resumed routine through committed chunks plus final, bypassing the live composer stream", async () => {
    const base = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "What's your email?" }, nextState: activeState })),
    });
    const input: ProcessTurnStreamInput = {
      ...base,
      composer: {
        compose: vi.fn(),
        streamCommitted: vi.fn(function* () {
          yield "What's ";
          yield "your email?";
        }),
        stream: vi.fn(async function* () {
          yield { type: "final", response: { answer: "should not run" } };
        }),
      },
    };

    const events: ProcessTurnStreamEvent[] = [];
    for await (const event of new DefaultConversationEngine().processTurnStream(input)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["delta", "delta", "final"]);
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", sessionId: "session_1", text: "What's " },
      { type: "delta", sessionId: "session_1", text: "your email?" },
    ]);
    expect(input.composer.stream).not.toHaveBeenCalled();
    const final = events.at(-1);
    expect(final?.type === "final" ? final.result.response.answer : "").toBe("What's your email?");
  });

  it("reports routine progress before a claimed streamed routine blocks", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const phases: string[] = [];
    const base = withRoutine({
      resume: vi.fn(async () => {
        await blocked;
        return { response: { answer: "Done" }, nextState: activeState };
      }),
    });
    const input: ProcessTurnStreamInput = {
      ...base,
      progress: { report: ({ phase }) => phases.push(phase) },
      composer: {
        compose: vi.fn(),
        async *stream() { yield { type: "final", response: { answer: "unused" } }; },
      },
    };
    const events = new DefaultConversationEngine().processTurnStream(input)[Symbol.asyncIterator]();
    const pending = events.next();

    await vi.waitFor(() => expect(phases).toEqual(["routine"]));
    release();
    await expect(pending).resolves.toMatchObject({ value: { type: "delta", text: "Done" } });
  });

  it("reports routine fallthrough before the normal streamed schedule", async () => {
    const phases: string[] = [];
    const base = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "" }, nextState: activeState, yielded: true })),
    });
    const input: ProcessTurnStreamInput = {
      ...base,
      progress: { report: ({ phase }) => phases.push(phase) },
      composer: {
        compose: vi.fn(),
        async *stream({ outcomes }) {
          yield { type: "final", response: { answer: outcomes[0]?.outcome.answer ?? "" } };
        },
      },
    };

    for await (const _event of new DefaultConversationEngine().processTurnStream(input)) {
      // drain
    }

    expect(phases).toEqual(["routine", "selecting", "dispatching", "composing"]);
  });

  it("reports the failing streamed boundary before surfacing its error", async () => {
    const phases: string[] = [];
    const failure = new Error("interpretation_failed");
    const input: ProcessTurnStreamInput = {
      ...createInput({
        turnInterpreter: { interpret: vi.fn(async () => { throw failure; }) },
      }),
      progress: { report: ({ phase }) => phases.push(phase) },
      composer: {
        compose: vi.fn(),
        async *stream() { yield { type: "final", response: { answer: "unused" } }; },
      },
    };

    const drain = async () => {
      for await (const _event of new DefaultConversationEngine().processTurnStream(input)) {
        // drain
      }
    };
    await expect(drain()).rejects.toBe(failure);
    expect(phases).toEqual(["interpreting"]);
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

  it("claims the activation turn even when the next-step selector reads the trigger as off-topic", async () => {
    // End-to-end: no active state, the activator claims the turn, and the routine's root
    // step runs a next-step selector that (seeing the trigger message as an off-topic reply
    // to a question never asked) returns a yield. On the activation turn the engine passes
    // activationTurn: true, so the runner lands on the root step instead of yielding — the
    // routine must not be silently dropped to a normal answer.
    const routine: Routine = {
      id: "contact",
      rootStepId: "ask_email",
      steps: [
        { id: "ask_email", kind: "chat", action: "Ask the user for their email address." },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions: [{ from: "ask_email", to: "done", condition: "a valid email was provided" }],
    };
    const routineRunner = new DefaultRoutineRunner(
      [routine],
      { select: vi.fn(async () => ({ nextStepId: "ask_email", yieldTurn: true })) },
      { render: vi.fn(async ({ step, steering }) => ({ answer: `[${step.id}] ${steering[0]?.action ?? ""}`, metadata: {} })) },
    );
    const save = vi.fn(async () => {});
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save, clear: vi.fn(async () => {}) },
      routineActivator: { activate: vi.fn(async () => ({ kind: "activate", routineId: "contact" })) },
      routineRunner,
    };

    const result = await new DefaultConversationEngine().processTurn(input);

    // The routine claimed the turn (non-null result), rendered the root step, and its
    // state was persisted — the activation was not dropped to a normal answer.
    expect(result).not.toBeNull();
    expect(result.trace.stages.map((stage) => stage.kind)).toContain("routine_activate");
    expect(result.response.answer).toContain("ask_email");
    // A stay on the root step (empty path) keeps the routine active for the next turn.
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      routineId: "contact",
      path: [],
      status: "active",
    }));
    expect(input.selector.select).not.toHaveBeenCalled();
  });

  it("passes activationTurn true to the runner on a fresh activation and false on a resume", async () => {
    const started: RoutineState = { ...activeState, path: ["ask_email"] };
    const activation: ProcessTurnInput = {
      ...createInput(),
      routineStore: { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
      routineActivator: { activate: vi.fn(async () => ({ kind: "activate", routineId: "contact" })) },
      routineRunner: { resume: vi.fn(async () => ({ response: { answer: "What's your email?" }, nextState: started })) },
    };
    await new DefaultConversationEngine().processTurn(activation);
    expect(activation.routineRunner!.resume).toHaveBeenCalledWith(expect.objectContaining({ activationTurn: true }));

    const resume = withRoutine({
      resume: vi.fn(async () => ({ response: { answer: "What's your message?" }, nextState: started })),
    });
    await new DefaultConversationEngine().processTurn(resume);
    expect(resume.routineRunner!.resume).toHaveBeenCalledWith(expect.objectContaining({ activationTurn: false }));
  });

  it("passes completed routine ids to the activator on idle turns", async () => {
    const completed: RoutineState = {
      ...activeState,
      status: "completed",
      path: ["ask_email", "done"],
    };
    const input: ProcessTurnInput = {
      ...createInput(),
      routineStore: {
        loadActive: vi.fn(async () => null),
        loadCompleted: vi.fn(async () => [completed]),
        save: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
      },
      routineActivator: { activate: vi.fn(async () => null) },
      routineRunner: { resume: vi.fn() },
    };

    await new DefaultConversationEngine().processTurn(input);

    expect(input.routineStore!.loadCompleted).toHaveBeenCalledWith({ sessionId: "session_1" });
    expect(input.routineActivator!.activate).toHaveBeenCalledWith(expect.objectContaining({
      suppressedRoutineIds: ["contact"],
    }));
    expect(input.routineRunner!.resume).not.toHaveBeenCalled();
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
