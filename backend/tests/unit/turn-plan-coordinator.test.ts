import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  ConversationTurnInterpreter,
  Directive,
  TurnContext,
} from "@radioso/conversation-contract";
import type { RankableRoutineCandidates } from "@radioso/conversation-defaults";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";

import {
  contextualDirectiveCandidates,
  createTurnPlanHandle,
  createTurnPlanningGate,
  lazyPromise,
  parseWorkspaceAllowlist,
  planAwareDirectiveClassifications,
  planAwareResponseLanguage,
  planAwareRoutineReentryGate,
  planAwareRoutineActivator,
  planAwareRoutineSlotCorrection,
  planAwareTurnInterpreter,
  startTurnPlan,
  TurnPlanCoordinator,
  type PlanAwareRoutineRegistrySeams,
  type TurnPlanInputs,
  type TurnPlanOutcome,
} from "../../src/modules/chat/services/turnPlanCoordinator.js";
import type { TurnPlan, TurnPlanService } from "../../src/modules/chat/services/turnPlanService.js";

const turn = { agent: { id: "a" }, sessionId: "s", inputEvent: { id: "i", kind: "message", content: "q" }, history: [], stagedContext: [], steering: [] } as unknown as TurnContext;

const plan = (overrides: Partial<TurnPlan> = {}): TurnPlan => ({
  route: "retrieval",
  framing: { isIdentityQuestion: false },
  responseLanguage: "English",
  routineRankings: [{ routineId: "r1", confidence: 0.9, variables: { company: "Acme" } }],
  directiveClassifications: [
    { name: "d1", matched: true, confidence: 0.7 },
    { name: "d2", matched: false, confidence: 0.1 },
  ],
  ...overrides,
});

const preparedRank: RankableRoutineCandidates = {
  kind: "rank",
  registrations: [
    { routine: { id: "r1", rootStepId: "s", steps: [], transitions: [] }, trigger: { description: "d", priority: 0 } },
  ],
  candidates: [{ routineId: "r1", title: "R1", triggerSummary: "d", priority: 0 }],
};

const handleFor = (outcome: TurnPlanOutcome | undefined) => () =>
  outcome === undefined ? undefined : Promise.resolve(outcome);

describe("createTurnPlanningGate", () => {
  it("is disabled when the switch is off", () => {
    expect(createTurnPlanningGate({ enabled: false }).isEnabledForWorkspace("w1")).toBe(false);
  });

  it("allows all workspaces when enabled with no allowlist", () => {
    expect(createTurnPlanningGate({ enabled: true }).isEnabledForWorkspace("w1")).toBe(true);
  });

  it("restricts to the allowlist when enabled with one", () => {
    const gate = createTurnPlanningGate({ enabled: true, workspaceAllowlist: ["w1"] });
    expect(gate.isEnabledForWorkspace("w1")).toBe(true);
    expect(gate.isEnabledForWorkspace("w2")).toBe(false);
  });
});

describe("parseWorkspaceAllowlist", () => {
  it("splits and trims a comma list", () => {
    expect(parseWorkspaceAllowlist(" w1 , w2 ,")).toEqual(["w1", "w2"]);
  });
  it("returns undefined for empty input", () => {
    expect(parseWorkspaceAllowlist(undefined)).toBeUndefined();
  });
});

const inputs = (overrides: Partial<TurnPlanInputs> = {}): TurnPlanInputs => ({
  query: "q",
  history: [],
  answerScopeReference: "scope",
  routinePreparation: preparedRank,
  directiveCandidates: [{ name: "d1", condition: "c1" }],
  workspaceContext: { workspaceId: "w1" },
  usageContext: { workspaceId: "w1", surface: "assistant", operation: "turn_planning", attemptKey: "k" },
  ...overrides,
});

const serviceReturning = (value: TurnPlan | null): TurnPlanService & { plan: ReturnType<typeof vi.fn> } =>
  ({ plan: vi.fn(async () => value) }) as unknown as TurnPlanService & { plan: ReturnType<typeof vi.fn> };

describe("TurnPlanCoordinator.plan", () => {
  it("returns planned with the prepared rank set on success", async () => {
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(inputs());
    expect(outcome).toMatchObject({ status: "planned", prepared: preparedRank });
    expect(service.plan).toHaveBeenCalledTimes(1);
  });

  it("bypasses on a routine claim without calling the service", async () => {
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(
      inputs({ routinePreparation: { kind: "claim", activation: { kind: "activate", routineId: "r1" } } }),
    );
    expect(outcome).toEqual({ status: "bypassed", reason: "routine_claim" });
    expect(service.plan).not.toHaveBeenCalled();
  });

  it("passes prepared=null through to a planned outcome when there are no routine candidates", async () => {
    const service = serviceReturning(plan({ routineRankings: [] }));
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({ routinePreparation: { kind: "none" } }));
    expect(outcome).toMatchObject({ status: "planned", prepared: null });
  });

  it("passes only the configured recent history tail to the planner", async () => {
    const service = serviceReturning(plan());
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-${index}`,
    } as MessageRecord));

    await new TurnPlanCoordinator(service).plan(inputs({ history }));

    expect(service.plan).toHaveBeenCalledWith(expect.objectContaining({
      history: history.slice(-10),
    }));
  });

  it("bypasses when routine candidates exceed the bound", async () => {
    const many: RankableRoutineCandidates = {
      kind: "rank",
      registrations: [],
      candidates: Array.from({ length: 9 }, (_v, index) => ({ routineId: `r${index}`, title: "t", triggerSummary: "s", priority: 0 })),
    };
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({ routinePreparation: many }));
    expect(outcome).toEqual({ status: "bypassed", reason: "routine_candidates_over_bound" });
    expect(service.plan).not.toHaveBeenCalled();
  });

  it("bypasses when directive candidates exceed the bound", async () => {
    const service = serviceReturning(plan());
    const directiveCandidates = Array.from({ length: 41 }, (_v, index) => ({ name: `d${index}`, condition: "c" }));
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({ directiveCandidates }));
    expect(outcome).toEqual({ status: "bypassed", reason: "directive_candidates_over_bound" });
  });

  it("bypasses when the estimated prompt exceeds the token budget", async () => {
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({ query: "x".repeat(25_000) }));
    expect(outcome).toEqual({ status: "bypassed", reason: "prompt_tokens_over_budget" });
  });

  it("counts custom rewrite guidance and the rolling summary in the prompt budget", async () => {
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({
      query: "x".repeat(11_000),
      semanticRewriteInstructions: "s".repeat(2_000),
      lexicalRewriteInstructions: "l".repeat(2_000),
      conversationSummary: "c".repeat(1_000),
    }));
    expect(outcome).toEqual({ status: "bypassed", reason: "prompt_tokens_over_budget" });
    expect(service.plan).not.toHaveBeenCalled();
  });

  it("counts the rendered template and serialization overhead near the prompt limit", async () => {
    const service = serviceReturning(plan());
    const outcome = await new TurnPlanCoordinator(service).plan(inputs({ query: "x".repeat(16_000) }));
    expect(outcome).toEqual({ status: "bypassed", reason: "prompt_tokens_over_budget" });
    expect(service.plan).not.toHaveBeenCalled();
  });

  it("fails when the service returns no plan", async () => {
    const service = serviceReturning(null);
    const outcome = await new TurnPlanCoordinator(service).plan(inputs());
    expect(outcome).toEqual({ status: "failed", reason: "invalid_or_error" });
  });

  it("does not enter staged fallback after the caller cancels planning", async () => {
    const controller = new AbortController();
    const service = {
      plan: vi.fn(async () => {
        controller.abort(new Error("turn superseded"));
        return null;
      }),
    } as unknown as TurnPlanService;
    await expect(
      new TurnPlanCoordinator(service).plan(inputs({ signal: controller.signal })),
    ).rejects.toThrow("turn superseded");
  });

  it("records bounded outcome and latency metrics", async () => {
    const metrics = {
      incrementCounter: vi.fn(),
      observeHistogram: vi.fn(),
    };
    await new TurnPlanCoordinator(serviceReturning(plan()), undefined, metrics).plan(inputs());
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_turn_planning_outcomes_total",
      expect.objectContaining({ labels: { outcome: "fastpath" } }),
    );
    expect(metrics.observeHistogram).toHaveBeenCalledWith(
      "chat_turn_planning_latency_ms",
      expect.objectContaining({ value: expect.any(Number) }),
    );
  });

  it("labels fallback and bypass metrics with typed low-cardinality reasons", async () => {
    const metrics = {
      incrementCounter: vi.fn(),
      observeHistogram: vi.fn(),
    };
    await new TurnPlanCoordinator(serviceReturning(null), undefined, metrics).plan(inputs());
    await new TurnPlanCoordinator(serviceReturning(plan()), undefined, metrics).plan(
      inputs({ query: "x".repeat(25_000) }),
    );
    expect(metrics.incrementCounter).toHaveBeenNthCalledWith(
      1,
      "chat_turn_planning_outcomes_total",
      expect.objectContaining({ labels: { outcome: "fallback", reason: "invalid_or_error" } }),
    );
    expect(metrics.incrementCounter).toHaveBeenNthCalledWith(
      2,
      "chat_turn_planning_outcomes_total",
      expect.objectContaining({ labels: { outcome: "bypass", reason: "prompt_tokens_over_budget" } }),
    );
  });
});

describe("createTurnPlanHandle", () => {
  it("computes once on first resolve and memoizes for later consumers", async () => {
    const compute = vi.fn(async (): Promise<TurnPlanOutcome> => ({ status: "planned", plan: plan(), prepared: preparedRank }));
    const handle = createTurnPlanHandle(compute);
    const first = await handle.resolve(preparedRank);
    const second = await handle.resolve(null);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith(preparedRank);
    expect(second).toBe(first);
  });

  it("bypass pins a bypassed outcome before any computation", async () => {
    const compute = vi.fn();
    const handle = createTurnPlanHandle(compute as never);
    handle.bypass("routine_claim");
    await expect(handle.resolve(null)).resolves.toEqual({ status: "bypassed", reason: "routine_claim" });
    expect(compute).not.toHaveBeenCalled();
  });

  it("bypass after computation started is a no-op", async () => {
    const handle = createTurnPlanHandle(async () => ({ status: "planned", plan: plan(), prepared: null }) as TurnPlanOutcome);
    const first = handle.resolve(null);
    handle.bypass("routine_claim");
    await expect(first).resolves.toMatchObject({ status: "planned" });
  });
});

describe("lazyPromise", () => {
  it("does not start until first consumption, then computes once", async () => {
    const compute = vi.fn(async () => "value");
    const promise = lazyPromise(compute);
    expect(compute).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("value");
    await expect(promise).resolves.toBe("value");
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe("planAwareRoutineActivator", () => {
  const stagedActivate = vi.fn(
    async (): Promise<{ kind: "activate"; routineId: string }> => ({ kind: "activate", routineId: "fb" }),
  );
  const fallback: ConversationRoutineActivator = { activate: stagedActivate };

  const registryWith = (input: {
    prepared: Awaited<ReturnType<PlanAwareRoutineRegistrySeams["prepareCandidates"]>>;
    decision?: Awaited<ReturnType<PlanAwareRoutineRegistrySeams["applyRankedDecision"]>>;
  }) => ({
    prepareCandidates: vi.fn(async () => input.prepared),
    applyRankedDecision: vi.fn(async () => input.decision ?? null),
  });

  it("prepares once, feeds the plan, and applies precomputed rankings when planned", async () => {
    const registry = registryWith({ prepared: preparedRank, decision: { kind: "activate", routineId: "r1" } });
    const resolve = vi.fn(async (): Promise<TurnPlanOutcome> => ({ status: "planned", plan: plan(), prepared: preparedRank }));
    const activator = planAwareRoutineActivator({
      handle: { resolve, bypass: vi.fn() },
      registry,
      fallback,
    });
    const result = await activator.activate({ turn, suppressedRoutineIds: ["done"] });
    expect(registry.prepareCandidates).toHaveBeenCalledWith(turn, { suppressedRoutineIds: ["done"] });
    expect(resolve).toHaveBeenCalledWith(preparedRank);
    expect(registry.applyRankedDecision).toHaveBeenCalledWith(
      preparedRank,
      [{ routineId: "r1", confidence: 0.9, variables: { company: "Acme" } }],
      { turn },
    );
    expect(result).toMatchObject({ routineId: "r1" });
    expect(stagedActivate).not.toHaveBeenCalled();
  });

  it("short-circuits an explicit claim and pins the plan bypassed", async () => {
    const claim = { kind: "claim" as const, activation: { kind: "activate" as const, routineId: "claimed" } };
    const registry = registryWith({ prepared: claim });
    const bypass = vi.fn();
    const resolve = vi.fn();
    const activator = planAwareRoutineActivator({
      handle: { resolve: resolve as never, bypass },
      registry,
      fallback,
    });
    const result = await activator.activate({ turn });
    expect(result).toEqual({ kind: "activate", routineId: "claimed" });
    expect(bypass).toHaveBeenCalledWith("routine_claim");
    expect(resolve).not.toHaveBeenCalled();
    expect(stagedActivate).not.toHaveBeenCalled();
  });

  it("returns null on a none preparation without resolving the plan", async () => {
    const registry = registryWith({ prepared: { kind: "none" } });
    const resolve = vi.fn();
    const activator = planAwareRoutineActivator({
      handle: { resolve: resolve as never, bypass: vi.fn() },
      registry,
      fallback,
    });
    expect(await activator.activate({ turn })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(stagedActivate).not.toHaveBeenCalled();
  });

  it("falls back to the staged activator on a failed plan", async () => {
    const registry = registryWith({ prepared: preparedRank });
    const activator = planAwareRoutineActivator({
      handle: {
        resolve: vi.fn(async (): Promise<TurnPlanOutcome> => ({ status: "failed", reason: "invalid_or_error" })),
        bypass: vi.fn(),
      },
      registry,
      fallback,
    });
    await activator.activate({ turn, loopGuardCandidateIds: ["x"] });
    expect(stagedActivate).toHaveBeenCalledWith({ turn, loopGuardCandidateIds: ["x"] });
    expect(registry.applyRankedDecision).not.toHaveBeenCalled();
  });

  it("uses the staged activator directly when there is no handle", async () => {
    const registry = registryWith({ prepared: preparedRank });
    const activator = planAwareRoutineActivator({ handle: undefined, registry, fallback });
    await activator.activate({ turn });
    expect(stagedActivate).toHaveBeenCalled();
    expect(registry.prepareCandidates).not.toHaveBeenCalled();
  });
});

describe("completed-routine planner bypass adapters", () => {
  const handle = () => ({ resolve: vi.fn(), bypass: vi.fn() });

  it("pins a bypass before rendering a confirmed or invalid slot correction", async () => {
    const correction: ConversationRoutineSlotCorrection = {
      detect: vi.fn(async () => ({
        slots: [{ id: "email", key: "email", type: "email" as const, required: true, mutable: true }],
        slotKey: "email",
        rawValue: "new@example.com",
      })),
      confirm: vi.fn(async () => "Updated."),
      rejectInvalid: vi.fn(async () => "Use a valid email."),
    };
    const planned = handle();
    const wrapped = planAwareRoutineSlotCorrection({ handle: planned, fallback: correction });

    await wrapped.confirm({ turn, routineId: "r1", slotKey: "email", value: "new@example.com" });
    await wrapped.rejectInvalid({ turn, routineId: "r1", slotKey: "email" });

    expect(planned.bypass).toHaveBeenCalledTimes(2);
    expect(planned.bypass).toHaveBeenCalledWith("routine_claim");
    expect(planned.resolve).not.toHaveBeenCalled();
  });

  it("pins a bypass only when semantic reentry claims the completed routine", async () => {
    const planned = handle();
    const fallback: ConversationRoutineReentryGate = {
      decide: vi.fn()
        .mockResolvedValueOnce({ kind: "suppress" })
        .mockResolvedValueOnce({ kind: "resume_existing" })
        .mockResolvedValueOnce({ kind: "start_new" }),
    };
    const wrapped = planAwareRoutineReentryGate({ handle: planned, fallback });
    const completedState = {
      sessionId: "s",
      routineId: "r1",
      path: ["done"],
      variables: {},
      status: "completed" as const,
    };

    await wrapped.decide({ turn, completedState });
    expect(planned.bypass).not.toHaveBeenCalled();
    await wrapped.decide({ turn, completedState });
    await wrapped.decide({ turn, completedState });
    expect(planned.bypass).toHaveBeenCalledTimes(2);
    expect(planned.resolve).not.toHaveBeenCalled();
  });
});

describe("startTurnPlan", () => {
  const coordinator = { plan: vi.fn(async (): Promise<TurnPlanOutcome> => ({ status: "planned", plan: plan(), prepared: null })) };
  const basePlanInputs = {
    query: "q",
    history: [],
    answerScopeReference: "scope",
    directiveCandidates: [],
    workspaceContext: { workspaceId: "w1" },
    usageContext: {
      workspaceId: "w1",
      surface: "assistant" as const,
      operation: "turn_planning",
      attemptKey: "k",
    },
  };

  it("returns undefined when the gate is off or the workspace is not allowlisted", () => {
    expect(startTurnPlan({
      coordinator: coordinator as never,
      gate: createTurnPlanningGate({ enabled: false }),
      workspaceId: "w1",
      bypass: {},
      plan: () => basePlanInputs,
    })).toBeUndefined();
    expect(startTurnPlan({
      coordinator: coordinator as never,
      gate: createTurnPlanningGate({ enabled: true, workspaceAllowlist: ["other"] }),
      workspaceId: "w1",
      bypass: {},
      plan: () => basePlanInputs,
    })).toBeUndefined();
  });

  it("returns undefined on any pre-engine bypass signal", () => {
    const gate = createTurnPlanningGate({ enabled: true });
    for (const bypass of [
      { activeRoutine: true },
      { pendingClarification: true },
      { suspendedRoutine: true },
    ]) {
      expect(startTurnPlan({
        coordinator: coordinator as never,
        gate,
        workspaceId: "w1",
        bypass,
        plan: () => basePlanInputs,
      })).toBeUndefined();
    }
    expect(coordinator.plan).not.toHaveBeenCalled();
  });

  it("creates a lazy handle that plans with the first resolver's preparation", async () => {
    const handle = startTurnPlan({
      coordinator: coordinator as never,
      gate: createTurnPlanningGate({ enabled: true, workspaceAllowlist: ["w1"] }),
      workspaceId: "w1",
      bypass: {},
      plan: () => basePlanInputs,
    });
    expect(handle).toBeDefined();
    expect(coordinator.plan).not.toHaveBeenCalled();
    await handle!.resolve(preparedRank);
    expect(coordinator.plan).toHaveBeenCalledTimes(1);
    expect(coordinator.plan).toHaveBeenCalledWith(
      expect.objectContaining({ routinePreparation: preparedRank }),
    );
  });
});

describe("contextualDirectiveCandidates", () => {
  it("unions contextual candidates across routes by name", () => {
    const contextual = (name: string): Directive => ({
      name,
      condition: { kind: "contextual", description: `when ${name}` },
      action: "act",
    });
    const always: Directive = { name: "always", condition: { kind: "always" }, action: "act" };
    const candidates = contextualDirectiveCandidates({
      routes: ["direct", "retrieval", "direct"],
      directivesForRoute: (route) => (route === "direct" ? [contextual("a"), always] : [contextual("a"), contextual("b")]),
    });
    expect(candidates).toEqual([
      { name: "a", condition: "when a" },
      { name: "b", condition: "when b" },
    ]);
  });
});

describe("planAwareTurnInterpreter", () => {
  const fallback: ConversationTurnInterpreter = {
    interpret: vi.fn(async () => ({ route: "direct" as const })),
  };

  it("interprets from the plan and marks the source planned", async () => {
    const rewriteProposal = { rewrittenQuery: "rq" } as unknown as TurnPlan["rewriteProposal"];
    const interpreter = planAwareTurnInterpreter({
      handle: handleFor({ status: "planned", plan: plan({ rewriteProposal }), prepared: preparedRank }),
      fallback,
    });
    const result = await interpreter.interpret({ turn });
    expect(result.route).toBe("retrieval");
    expect(result.metadata).toMatchObject({ source: "planned", rewriteProposal });
    expect(fallback.interpret).not.toHaveBeenCalled();
  });

  it("falls back when bypassed", async () => {
    const interpreter = planAwareTurnInterpreter({
      handle: handleFor({ status: "bypassed", reason: "gate_disabled" }),
      fallback,
    });
    await interpreter.interpret({ turn });
    expect(fallback.interpret).toHaveBeenCalled();
  });
});

describe("planAwareResponseLanguage", () => {
  it("uses the plan language when planned", async () => {
    const fallback = vi.fn(async () => "fallback-lang");
    const language = await planAwareResponseLanguage({
      handle: handleFor({ status: "planned", plan: plan({ responseLanguage: "Spanish" }), prepared: preparedRank }),
      fallback,
    });
    expect(language).toBe("Spanish");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("awaits the detector fallback otherwise", async () => {
    const fallback = vi.fn(async () => "detected");
    const language = await planAwareResponseLanguage({ handle: handleFor(undefined), fallback });
    expect(language).toBe("detected");
  });
});

describe("planAwareDirectiveClassifications", () => {
  it("returns matched classifications when planned", async () => {
    const result = await planAwareDirectiveClassifications(
      handleFor({ status: "planned", plan: plan(), prepared: preparedRank }),
    );
    expect(result).toEqual([{ name: "d1", confidence: 0.7 }]);
  });

  it("returns null when not planned so the matcher runs its gateway", async () => {
    expect(await planAwareDirectiveClassifications(handleFor({ status: "failed", reason: "invalid_or_error" }))).toBeNull();
    expect(await planAwareDirectiveClassifications(handleFor(undefined))).toBeNull();
  });
});
