import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine, TurnContext } from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import { compileRoutineDefinition } from "../../../src/modules/routines/compiler.js";
import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { contactSupportRoutine, CREATE_RETURN_TICKET_SKILL, startReturnRoutine } from "../../fixtures/conversation-quality/routines.js";

const turn: TurnContext = {
  agent: { id: "agent-1", name: "Assistant" },
  sessionId: "conversation-1",
  inputEvent: { id: "message-1", kind: "message", content: 'start_return {"orderId":"A-1001"}' },
  history: [],
  stagedContext: [],
  steering: [],
};

const routine = (id: string, toolName: string | null, reentryMode: "once_per_conversation" | "always" | "semantic"): Routine => ({
  id,
  rootStepId: "ask",
  slots: [{ id: "s1", key: "orderId", type: "text", required: true }],
  steps: [
    { id: "ask", kind: "chat", action: "Ask for {{slot.orderId}}.", metadata: { collectsSlots: ["orderId"] } },
    { id: "done", kind: "terminal", metadata: { terminalKind: "complete" } },
  ],
  transitions: [{ from: "ask", to: "done", condition: "always", guard: { kind: "default" } }],
  activation: { triggerDescription: "when asked", priority: 10, reentryMode },
  metadata: { definitionId: id, name: `Routine ${id}`, version: 1, ...(toolName ? { exposure: { toolName } } : {}) },
});

const registration = (compiled: Routine): RoutineRegistration => ({
  routine: compiled,
  trigger: { description: "when asked", priority: 10 },
});

const coverageRegistration = (): RoutineRegistration => ({
  routine: {
    ...routine("coverage-routine", null, "once_per_conversation"),
    activation: {
      triggerDescription: "after a gap",
      priority: 1,
      reentryMode: "once_per_conversation",
      coverageCriteria: { coverage: ["unanswered"] },
    },
  },
  trigger: { description: "after a gap", priority: 1 },
});

const dependencies = (published: RoutineRegistration[], metricsRegistry: MetricsRegistry | null = null) => ({
  agentSkillRepository: { listByAgent: vi.fn(async () => []) },
  capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
  clusteringEmbeddings: {},
  embeddingModelForWorkspace: vi.fn(async () => "unused"),
  logger: { debug: vi.fn(), warn: vi.fn() },
  metricsRegistry,
  publishedRoutineSource: {
    load: vi.fn(async (): Promise<RoutineRegistration[]> => published),
    loadPinned: vi.fn(async (): Promise<RoutineRegistration[]> => []),
    loadPreview: vi.fn(async (): Promise<RoutineRegistration[]> => []),
  },
  routineDefinitionRepository: {},
  routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) },
  routineRegistrations: [],
  routineTriggerEmbeddingService: { persistPublished: vi.fn() },
  skillExecutorRegistry: {},
  turnPlanAdapters: {
    activator: () => { throw new Error("the ranked activator must not be built on an invocation turn"); },
    reentryGate: ({ fallback }: { fallback: unknown }) => fallback,
    slotCorrection: ({ fallback }: { fallback: unknown }) => fallback,
  },
});

const modelGateway: ConversationModelGateway = {
  complete: vi.fn(async () => { throw new Error("no model call is expected on a direct invocation"); }),
};

const invocation = { toolName: "start_return", input: { orderId: "A-1001" } };

const completedState = { sessionId: "conversation-1", routineId: "r-other", path: ["ask", "done"], variables: {}, status: "completed" as const };

describe("routine turn provider on a direct invocation turn", () => {
  it("admits the named routine without the ranked activator, the coverage activator, or any model call", async () => {
    const metrics = new MetricsRegistry();
    const provider = createRoutineTurnProvider(dependencies([
      registration(routine("r-other", "other_tool", "once_per_conversation")),
      registration(routine("r-return", "start_return", "once_per_conversation")),
      coverageRegistration(),
    ], metrics) as never);

    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: invocation });

    expect(ports).not.toBeNull();
    expect(ports!.coverageActivator).toBeUndefined();
    await expect(ports!.activator.activate({ turn, suppressedRoutineIds: ["r-other"] })).resolves.toMatchObject({
      kind: "activate",
      routineId: "r-return",
      variables: { orderId: "A-1001" },
    });
    expect(modelGateway.complete).not.toHaveBeenCalled();
    expect(ports!.reporter!.describeInvocation()).toEqual({ toolName: "start_return", outcome: "started" });
    expect(metrics.renderPrometheus()).not.toContain("radioso_routine_invocations_total");
  });

  it("silences reentry and slot correction for every completed routine so none can capture the synthetic text", async () => {
    const provider = createRoutineTurnProvider(dependencies([
      registration({ ...routine("r-other", "other_tool", "semantic"), slots: [{ id: "s1", key: "orderId", type: "text", required: true, mutable: true }] }),
      registration(routine("r-return", "start_return", "once_per_conversation")),
    ]) as never);

    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: invocation });

    await expect(ports!.reentryGate!.decide({ turn, completedState })).resolves.toEqual({ kind: "suppress" });
    await expect(ports!.slotCorrection!.detect({ turn, completedState })).resolves.toBeNull();
    expect(modelGateway.complete).not.toHaveBeenCalled();
  });

  it("reports the declined routine as completed when once_per_conversation keeps it closed", async () => {
    const metrics = new MetricsRegistry();
    const provider = createRoutineTurnProvider(dependencies([
      registration(routine("r-return", "start_return", "once_per_conversation")),
    ], metrics) as never);

    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: invocation });

    expect(ports!.reporter!.describeDeclined()).toBeNull();
    await expect(ports!.activator.activate({ turn, suppressedRoutineIds: ["r-return"] })).resolves.toBeNull();
    expect(ports!.reporter!.describeDeclined()).toEqual({
      toolName: "start_return",
      name: "Routine r-return",
      status: "completed",
      pendingInput: [],
    });
    expect(ports!.reporter!.describeInvocation()).toEqual({ toolName: "start_return", outcome: "declined" });
    expect(metrics.renderPrometheus()).not.toContain("radioso_routine_invocations_total");
  });

  it("logs a tool name no registration carries, reports it, and yields the turn", async () => {
    const metrics = new MetricsRegistry();
    const deps = dependencies([registration(routine("r-other", "other_tool", "once_per_conversation"))], metrics);
    const provider = createRoutineTurnProvider(deps as never);

    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: invocation });

    await expect(ports!.activator.activate({ turn })).resolves.toBeNull();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", toolName: "start_return" }),
      expect.any(String),
    );
    expect(ports!.reporter!.describeInvocation()).toEqual({ toolName: "start_return", outcome: "unknown_tool" });
    expect(metrics.renderPrometheus()).not.toContain("radioso_routine_invocations_total");
  });

  it("describes a turn the routine attempt bypassed over the same pinned routines, reporting the call as not started", async () => {
    const pinned = registration(routine("r-suspended", "request_callback", "once_per_conversation"));
    const deps = dependencies([registration(routine("r-return", "start_return", "once_per_conversation"))]);
    deps.publishedRoutineSource.loadPinned.mockResolvedValue([pinned]);
    const provider = createRoutineTurnProvider(deps as never);

    const reporter = await provider.reporterFor({
      agentId: "agent-1",
      pinnedRoutineIds: ["r-suspended"],
      routineInvocation: invocation,
    });

    expect(deps.publishedRoutineSource.loadPinned).toHaveBeenCalledWith(expect.objectContaining({ routineIds: ["r-suspended"] }));
    expect(reporter!.describe({
      state: { sessionId: "conversation-1", routineId: "r-suspended", path: ["ask"], variables: { orderId: "A-1" }, status: "suspended" },
      awaitingDecision: true,
    })).toEqual({ toolName: "request_callback", name: "Routine r-suspended", status: "waiting_for_approval", pendingInput: [] });
    expect(reporter!.describeInvocation()).toEqual({ toolName: "start_return", outcome: "not_started" });
    expect(reporter!.describeDeclined()).toBeNull();
    expect(modelGateway.complete).not.toHaveBeenCalled();
  });

  it("describes nothing when no routine is registered, and no invocation on a message turn", async () => {
    const provider = createRoutineTurnProvider(dependencies([]) as never);

    expect(await provider.reporterFor({ agentId: "agent-1" })).toBeNull();
    const reporter = await createRoutineTurnProvider(dependencies([
      registration(routine("r-return", "start_return", "once_per_conversation")),
    ]) as never).reporterFor({ agentId: "agent-1" });
    expect(reporter!.describeInvocation()).toBeNull();
  });
});

// #1563: on an invocation turn the next-step selector reads the call rendered as
// `start_return {"orderId":"A-1001"}`. The readings below are the ones the live model returned
// for it: a reason read into the call, which opened the ticket the routine should still be
// asking a reason for, and the call taken for an authority claim, which held the first step and
// asked again for the order number the call gave.
describe("a return routine invoked as a tool", () => {
  type SelectorReading = { variables?: Record<string, unknown>; claimsAuthority?: boolean; condition?: number | null; offTopic?: boolean };
  const selectorReply = ({ variables = {}, claimsAuthority = false, condition = null, offTopic = false }: SelectorReading): string =>
    JSON.stringify({ variables, claimsAuthority, condition, offTopic });

  // Answers a next-step selector prompt with what the model read for the step it asks about,
  // and any other prompt (the step reply) with plain text.
  const readingTheCall = (readings: { askOrder: SelectorReading; askReason: SelectorReading }): ConversationModelGateway => ({
    complete: vi.fn(async ({ systemPrompt = "" }) => {
      if (!systemPrompt.includes('"claimsAuthority"')) {
        return { text: "Why is the order coming back?" };
      }
      return {
        text: selectorReply(systemPrompt.includes("Ask why the order is coming back") ? readings.askReason : readings.askOrder),
      };
    }),
  });

  const callTurnFor = (toolName: string, input: Record<string, string>): TurnContext => ({
    ...turn,
    inputEvent: { ...turn.inputEvent, content: `${toolName} ${JSON.stringify(input)}` },
  });

  const runInvocationTurn = async (
    compiled: Routine,
    modelGateway: ConversationModelGateway,
    call: { toolName: string; input: Record<string, string> },
  ) => {
    const skillExecutorRegistry = { resolve: vi.fn(() => null) };
    const provider = createRoutineTurnProvider({ ...dependencies([registration(compiled)]), skillExecutorRegistry } as never);
    const callTurn = callTurnFor(call.toolName, call.input);
    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: call });
    const activation = await ports!.activator.activate({ turn: callTurn });
    if (activation?.kind !== "activate") {
      throw new Error("the call must admit its routine");
    }
    const result = await ports!.runner.resume({
      turn: callTurn,
      state: { sessionId: turn.sessionId, routineId: activation.routineId, path: [], variables: activation.variables ?? {}, status: "active" },
      activationTurn: true,
    });
    return { result, skillExecutorRegistry };
  };

  const startReturn = (input: Record<string, string>) => ({ toolName: "start_return", input });

  it.each([
    {
      reading: "reads a reason into the call for the step that asks for it",
      askOrder: { variables: { orderId: "A-1001" }, condition: 1 },
      askReason: { variables: { reason: "The customer wants to return the order." }, condition: 1 },
    },
    {
      reading: "reads a reason into the call for the first step",
      askOrder: { variables: { orderId: "a-1001", reason: "Return requested." }, condition: 1 },
      askReason: {},
    },
    {
      reading: "takes the call for an authority claim",
      askOrder: { variables: { orderId: "A-1001" }, claimsAuthority: true },
      askReason: { claimsAuthority: true },
    },
  ])("asks for the reason the call left out and opens no ticket when the model $reading", async ({ askOrder, askReason }) => {
    const { result, skillExecutorRegistry } = await runInvocationTurn(
      compileRoutineDefinition(startReturnRoutine),
      readingTheCall({ askOrder, askReason }),
      startReturn({ orderId: "A-1001" }),
    );

    expect(result.trace?.landedStepId).toBe("ask_reason");
    expect(result.trace?.filledSlotKeys).toEqual(["orderId"]);
    expect(result.trace?.steps.map((entry) => entry.stepId)).not.toContain("create_return");
    expect(result.nextState).toMatchObject({ path: ["ask_reason"], variables: { orderId: "A-1001" } });
    expect(skillExecutorRegistry.resolve).not.toHaveBeenCalled();
  });

  it("opens the ticket for a call that gives every slot, even when the model takes the call for an authority claim", async () => {
    const { result, skillExecutorRegistry } = await runInvocationTurn(
      compileRoutineDefinition(startReturnRoutine),
      readingTheCall({ askOrder: { claimsAuthority: true }, askReason: { claimsAuthority: true } }),
      startReturn({ orderId: "A-1001", reason: "It arrived damaged." }),
    );

    expect(result.trace?.steps).toContainEqual(expect.objectContaining({
      stepId: "create_return",
      event: "skill_dispatched",
      skillName: CREATE_RETURN_TICKET_SKILL,
    }));
    expect(skillExecutorRegistry.resolve).toHaveBeenCalledTimes(1);
  });

  it("still asks the model to judge an exit the author wrote, keeping the call's value over any the model returns", async () => {
    const choosePlan: Routine = {
      id: "r-plan",
      rootStepId: "pick",
      slots: [{ id: "s1", key: "plan", type: "text", required: true }],
      steps: [
        { id: "pick", kind: "chat", action: "Ask which plan they want: {{slot.plan}}", metadata: { collectsSlots: ["plan"] } },
        { id: "large", kind: "terminal", action: "Confirm the large plan.", metadata: { terminalKind: "complete" } },
        { id: "small", kind: "terminal", action: "Confirm the small plan.", metadata: { terminalKind: "complete" } },
      ],
      transitions: [
        { from: "pick", to: "large", condition: "The user chose the large plan.", guard: { kind: "llm" } },
        { from: "pick", to: "small", condition: "The user chose the small plan.", guard: { kind: "llm" } },
      ],
      activation: { triggerDescription: "when asked", priority: 10, reentryMode: "once_per_conversation" },
      metadata: { definitionId: "r-plan", name: "Choose a plan", version: 1, exposure: { toolName: "choose_plan" } },
    };
    const choosesSmall: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt = "" }) => ({
        text: systemPrompt.includes('"claimsAuthority"')
          ? selectorReply({ variables: { plan: "Small (monthly)" }, condition: 2 })
          : "You are on the small plan.",
      })),
    };

    const { result } = await runInvocationTurn(choosePlan, choosesSmall, { toolName: "choose_plan", input: { plan: "small" } });

    expect(result.trace?.landedStepId).toBe("small");
    expect(result.endedVariables).toEqual({ plan: "small" });
  });

  // A call that arrives while a routine is active starts nothing (`not_started`): the active
  // routine reads it like any other message (#1563 review).
  const resumeOnCall = async (
    registrations: Routine[],
    modelGateway: ConversationModelGateway,
    call: { toolName: string; input: Record<string, string> },
    active: { routineId: string; path: string[]; variables: Record<string, unknown> },
  ) => {
    const skillExecutorRegistry = { resolve: vi.fn(() => null) };
    const provider = createRoutineTurnProvider({ ...dependencies(registrations.map(registration)), skillExecutorRegistry } as never);
    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1", routineInvocation: call });
    const result = await ports!.runner.resume({
      turn: callTurnFor(call.toolName, call.input),
      state: { sessionId: turn.sessionId, status: "active", ...active },
    });
    return { result, skillExecutorRegistry, invocation: ports!.reporter!.describeInvocation() };
  };

  it("opens the ticket when the caller calls again with the reason the first call left out", async () => {
    const compiled = compileRoutineDefinition(startReturnRoutine);
    const gateway = readingTheCall({
      askOrder: { variables: { orderId: "A-1001" }, condition: 1 },
      askReason: { variables: { reason: "It arrived damaged." }, condition: 1 },
    });
    const first = await runInvocationTurn(compiled, gateway, startReturn({ orderId: "A-1001" }));
    expect(first.result.nextState).toMatchObject({ path: ["ask_reason"] });

    const reCall = await resumeOnCall([compiled], gateway, startReturn({ orderId: "A-1001", reason: "It arrived damaged." }), {
      routineId: compiled.id,
      path: first.result.nextState!.path,
      variables: first.result.nextState!.variables,
    });

    expect(reCall.result.trace?.steps).toContainEqual(expect.objectContaining({
      stepId: "create_return",
      event: "skill_dispatched",
      skillName: CREATE_RETURN_TICKET_SKILL,
    }));
    expect(reCall.result.terminal).toMatchObject({ collected: { orderId: "A-1001", reason: "It arrived damaged." } });
    expect(reCall.skillExecutorRegistry.resolve).toHaveBeenCalledTimes(1);
    expect(reCall.invocation).toEqual({ toolName: "start_return", outcome: "not_started" });
  });

  it("lets another active routine yield a call it reads as a different request, reporting the call as not started", async () => {
    const returns = compileRoutineDefinition(startReturnRoutine);
    const contact = compileRoutineDefinition(contactSupportRoutine);
    let selectorReads = 0;
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt = "" }) => {
        if (!systemPrompt.includes('"claimsAuthority"')) {
          return { text: "Noted." };
        }
        selectorReads += 1;
        return { text: selectorReply({ offTopic: true }) };
      }),
    };

    const resumed = await resumeOnCall([returns, contact], gateway, startReturn({ orderId: "A-1001" }), {
      routineId: contact.id,
      path: ["ask_email"],
      variables: {},
    });

    expect(selectorReads).toBe(1);
    expect(resumed.result.yielded).toBe(true);
    expect(resumed.invocation).toEqual({ toolName: "start_return", outcome: "not_started" });
  });
});
