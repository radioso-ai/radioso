import { describe, expect, it, vi } from "vitest";

import type {
  AnswerCoverageCriteria,
  ConversationModelGateway,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";

const turn: TurnContext = {
  agent: { id: "agent-1", name: "Assistant" },
  sessionId: "conversation-1",
  inputEvent: { id: "message-1", kind: "message", content: "Please help me" },
  history: [],
  stagedContext: [],
  steering: [],
  metadata: {
    answerCoverage: {
      availability: "assessed",
      coverage: "unanswered",
      reason: "insufficient_evidence",
      unresolvedRequest: "Eligibility",
      schemaVersion: 1,
    },
  },
};

const defaultCoverageCriteria: AnswerCoverageCriteria = {
  coverage: ["unanswered"], reasons: ["insufficient_evidence"],
};

const routine = (action: string, coverageCriteria?: AnswerCoverageCriteria): Routine => ({
  id: "coverage-routine",
  rootStepId: "start",
  steps: [{ id: "start", kind: "chat", action }],
  transitions: [],
  activation: {
    triggerDescription: "Offer a consultation after an evidence gap",
    priority: 1,
    reentryMode: "once_per_conversation",
    ...(coverageCriteria === undefined ? {} : { coverageCriteria }),
  },
});

const registration = (action: string, coverageCriteria: AnswerCoverageCriteria = defaultCoverageCriteria): RoutineRegistration => ({
  routine: routine(action, coverageCriteria),
  trigger: { description: "Offer a consultation after an evidence gap", priority: 1 },
});

const legacyRegistration = (action: string): RoutineRegistration => ({
  routine: routine(action),
  trigger: { description: "Offer a consultation after an evidence gap", priority: 1 },
});

const lodgingRegistration = (): RoutineRegistration => ({
  routine: {
    ...routine("Collect a lodging request", defaultCoverageCriteria),
    activation: {
    triggerDescription: "Help a visitor arrange lodging",
    priority: 1,
      reentryMode: "once_per_conversation",
      coverageCriteria: defaultCoverageCriteria,
    },
  },
  trigger: { description: "Help a visitor arrange lodging", priority: 1 },
});

const dependencies = (published: RoutineRegistration, pinned?: RoutineRegistration) => ({
  agentSkillRepository: { listByAgent: vi.fn(async () => []) },
  capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
  clusteringEmbeddings: {},
  embeddingModelForWorkspace: vi.fn(async () => "unused"),
  logger: { debug: vi.fn(), warn: vi.fn() },
  publishedRoutineSource: {
    load: vi.fn(async (): Promise<RoutineRegistration[]> => [published]),
    loadPinned: vi.fn(async (): Promise<RoutineRegistration[]> => pinned ? [pinned] : []),
    loadPreview: vi.fn(async (): Promise<RoutineRegistration[]> => []),
  },
  routineDefinitionRepository: {},
  routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) },
  routineRegistrations: [],
  routineTriggerEmbeddingService: { persistPublished: vi.fn() },
  skillExecutorRegistry: {},
  turnPlanAdapters: {
    activator: ({ fallback }: { fallback: unknown }) => fallback,
    reentryGate: ({ fallback }: { fallback: unknown }) => fallback,
    slotCorrection: ({ fallback }: { fallback: unknown }) => fallback,
  },
});

const gateway = (matches = [{ routineId: "coverage-routine", confidence: 0.9 }]): ConversationModelGateway => ({
  complete: vi.fn(async (input) => ({
    text: input.metadata?.routineActivation === true
      ? JSON.stringify({ matches })
      : "Consultation reply",
  })),
});

describe("coverage-gated routine turn provider", () => {
  it("keeps coverage routines out of normal activation while making the selected routine executable", async () => {
    const provider = createRoutineTurnProvider(dependencies(registration("Published routine action")) as never);
    const modelGateway = gateway();
    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1" });

    expect(ports).not.toBeNull();
    await expect(ports!.activator.activate({ turn })).resolves.toBeNull();
    await expect(ports!.coverageActivator!.activate({ turn })).resolves.toMatchObject({
      kind: "activate",
      routineId: "coverage-routine",
    });

    await expect(ports!.runner.resume({
      turn,
      state: { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "active" },
      activationTurn: true,
    })).resolves.toMatchObject({ response: { answer: "Consultation reply" } });
  });

  it("preserves the pinned routine version when it shadows a coverage registration in the execution runner", async () => {
    const provider = createRoutineTurnProvider(
      dependencies(registration("Published routine action"), registration("Pinned routine action")) as never,
    );
    const modelGateway = gateway();
    const ports = await provider.forTurn({
      modelGateway,
      agentId: "agent-1",
      pinnedRoutineIds: ["coverage-routine"],
    });

    await ports!.runner.resume({
      turn,
      state: { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "active" },
      activationTurn: true,
    });

    const renderCall = vi.mocked(modelGateway.complete).mock.calls.find((call) => call[0].metadata?.routineActivation !== true);
    expect(renderCall?.[0].systemPrompt).toContain("Pinned routine action");
  });

  it("uses a pinned coverage version for activation and reentry when it replaces a legacy routine ID", async () => {
    const provider = createRoutineTurnProvider(
      dependencies(legacyRegistration("Published legacy action"), registration("Pinned coverage action")) as never,
    );
    const modelGateway = gateway();
    const ports = await provider.forTurn({
      modelGateway,
      agentId: "agent-1",
      pinnedRoutineIds: ["coverage-routine"],
    });
    const completedState = { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "completed" as const };

    await expect(ports!.activator.activate({ turn: { ...turn, metadata: {} } })).resolves.toBeNull();
    await expect(ports!.reentryGate!.decide({ turn: { ...turn, metadata: {} }, completedState })).resolves.toEqual({ kind: "suppress" });
    await expect(ports!.coverageActivator!.activate({ turn })).resolves.toMatchObject({ kind: "activate", routineId: "coverage-routine" });
  });

  it("uses a preview coverage version when it replaces a published legacy routine ID", async () => {
    const testDependencies = dependencies(legacyRegistration("Published legacy action"));
    testDependencies.publishedRoutineSource.loadPreview = vi.fn(async () => [registration("Preview coverage action")]);
    const provider = createRoutineTurnProvider(testDependencies as never);
    const ports = await provider.forTurn({
      modelGateway: gateway(),
      agentId: "agent-1",
      previewRoutineIds: ["coverage-routine"],
    });
    const completedState = { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "completed" as const };

    await expect(ports!.activator.activate({ turn: { ...turn, metadata: {} } })).resolves.toBeNull();
    await expect(ports!.reentryGate!.decide({ turn: { ...turn, metadata: {} }, completedState })).resolves.toEqual({ kind: "suppress" });
    await expect(ports!.coverageActivator!.activate({ turn })).resolves.toMatchObject({ kind: "activate", routineId: "coverage-routine" });
  });

  it("uses the preview coverage version over a pinned legacy version for pre-evidence reentry", async () => {
    const testDependencies = dependencies(
      legacyRegistration("Published legacy action"),
      legacyRegistration("Pinned legacy action"),
    );
    testDependencies.publishedRoutineSource.loadPreview = vi.fn(async () => [registration("Preview coverage action")]);
    testDependencies.turnPlanAdapters.reentryGate = () => ({ decide: vi.fn(async () => ({ kind: "start_new" as const })) });
    const provider = createRoutineTurnProvider(testDependencies as never);
    const ports = await provider.forTurn({
      modelGateway: gateway(),
      agentId: "agent-1",
      pinnedRoutineIds: ["coverage-routine"],
      previewRoutineIds: ["coverage-routine"],
    });
    const completedState = { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "completed" as const };

    await expect(ports!.reentryGate!.decide({ turn: { ...turn, metadata: {} }, completedState })).resolves.toEqual({ kind: "suppress" });
  });

  it("restores pre-evidence reentry when a preview legacy version replaces pinned coverage", async () => {
    const testDependencies = dependencies(
      registration("Published coverage action"),
      registration("Pinned coverage action"),
    );
    testDependencies.publishedRoutineSource.loadPreview = vi.fn(async () => [legacyRegistration("Preview legacy action")]);
    testDependencies.turnPlanAdapters.reentryGate = () => ({ decide: vi.fn(async () => ({ kind: "start_new" as const })) });
    const provider = createRoutineTurnProvider(testDependencies as never);
    const ports = await provider.forTurn({
      modelGateway: gateway(),
      agentId: "agent-1",
      pinnedRoutineIds: ["coverage-routine"],
      previewRoutineIds: ["coverage-routine"],
    });
    const completedState = { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "completed" as const };

    await expect(ports!.reentryGate!.decide({ turn: { ...turn, metadata: {} }, completedState })).resolves.toEqual({ kind: "start_new" });
    expect(ports!.coverageActivator).toBeUndefined();
  });

  it("does not start a lodging routine for an unanswered unrelated request after criteria match", async () => {
    const provider = createRoutineTurnProvider(dependencies(lodgingRegistration()) as never);
    const modelGateway = gateway([]);
    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1" });
    const unrelatedTurn: TurnContext = {
      ...turn,
      inputEvent: { ...turn.inputEvent, content: "Can you recommend a local restaurant?" },
    };

    await expect(ports!.coverageActivator!.activate({ turn: unrelatedTurn })).resolves.toBeNull();
    expect(modelGateway.complete).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ content: "Can you recommend a local restaurant?" })]),
      metadata: expect.objectContaining({ routineActivation: true }),
    }));
  });

  it("starts a lodging routine only when its semantic trigger and coverage criteria both match", async () => {
    const provider = createRoutineTurnProvider(dependencies(lodgingRegistration()) as never);
    const ports = await provider.forTurn({ modelGateway: gateway(), agentId: "agent-1" });
    const lodgingTurn: TurnContext = {
      ...turn,
      inputEvent: { ...turn.inputEvent, content: "I need lodging for the retreat." },
    };

    await expect(ports!.coverageActivator!.activate({ turn: lodgingTurn })).resolves.toMatchObject({
      kind: "activate",
      routineId: "coverage-routine",
    });
  });

  it("does not activate a coverage-gated routine for an answered assessment", async () => {
    const modelGateway = gateway();
    const provider = createRoutineTurnProvider(dependencies(registration("Published routine action")) as never);
    const ports = await provider.forTurn({ modelGateway, agentId: "agent-1" });
    const answeredTurn: TurnContext = {
      ...turn,
      metadata: {
        answerCoverage: {
          availability: "assessed",
          coverage: "answered",
          reason: "sufficient_evidence",
          schemaVersion: 1,
        },
      },
    };

    await expect(ports!.coverageActivator!.activate({ turn: answeredTurn })).resolves.toBeNull();
    expect(modelGateway.complete).not.toHaveBeenCalled();
  });

  it("suppresses a completed coverage routine before evidence and reenters only after fresh matching coverage", async () => {
    const published = registration("Published routine action");
    published.routine.activation = { ...published.routine.activation!, reentryMode: "semantic" };
    const testDependencies = dependencies(published);
    const decide = vi.fn(async () => ({ kind: "start_new" as const }));
    testDependencies.turnPlanAdapters.reentryGate = () => ({ decide });
    const provider = createRoutineTurnProvider(testDependencies as never);
    const ports = await provider.forTurn({ modelGateway: gateway(), agentId: "agent-1" });
    const completedState = { sessionId: turn.sessionId, routineId: "coverage-routine", path: [], variables: {}, status: "completed" as const };

    await expect(ports!.reentryGate!.decide({ turn: { ...turn, metadata: {} }, completedState })).resolves.toEqual({ kind: "suppress" });
    expect(decide).not.toHaveBeenCalled();
    await expect(ports!.coverageActivator!.reentryGate!.decide({ turn, completedState })).resolves.toEqual({ kind: "start_new" });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("restores ordinary semantic activation when an author removes coverage criteria", async () => {
    const provider = createRoutineTurnProvider(
      dependencies(legacyRegistration("Published routine action")) as never,
    );
    const ports = await provider.forTurn({ modelGateway: gateway(), agentId: "agent-1" });

    await expect(ports!.activator.activate({ turn: {
      ...turn,
      metadata: {},
    } })).resolves.toMatchObject({ kind: "activate", routineId: "coverage-routine" });
    expect(ports!.coverageActivator).toBeUndefined();
  });
});
