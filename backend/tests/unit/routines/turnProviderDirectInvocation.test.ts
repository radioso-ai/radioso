import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine, TurnContext } from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

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
