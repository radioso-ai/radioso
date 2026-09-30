import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway } from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../../src/app/composition/builtIn/contactRoutineModule.js";
import { createPublishedRoutineRegistrationSource } from "../../../src/app/composition/routineDefinitionSource.js";
import type { RoutineDefinitionRepository } from "../../../src/db/repositories/routineDefinitionRepository.js";
import type { AgentRevision } from "../../../src/modules/agents/agentRevision.js";
import { contactRoutineDefinition } from "../../../src/modules/chat/services/routines/contactRoutine.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";

// #1362: a built-in routine is served by the process, never frozen into an agent revision.
// Resuming one (or pinning it after it completed) on a revision-bound turn must resolve to
// the built-in registration instead of failing the snapshot lookup. A pinned authored
// routine that the snapshot lacks is still an integrity failure on that turn.

const BUILT_IN_ROUTINE_ID = contactRoutineDefinition.id;
const AUTHORED_ROUTINE_ID = "11111111-1111-4111-9111-111111111111";
const MISSING_AUTHORED_ROUTINE_ID = "22222222-2222-4222-9222-222222222222";

const authoredDefinition: RoutineDefinition = {
  id: AUTHORED_ROUTINE_ID,
  agentId: "agent-1",
  lineageId: "lineage-1",
  name: "booking",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The user wants to book a room.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask for the dates.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "llm", guardText: "The user gave dates.", ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const revision: AgentRevision = {
  id: "33333333-3333-4333-8333-333333333333",
  snapshot: { customInstruction: "", directives: [], routines: [authoredDefinition], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  publishedVersion: 1,
};

const builtInRegistrations = (): RoutineRegistration[] => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({ logger: { error: () => {} }, registry }).apply([
    createContactRoutineApplicationModule(),
  ]);
  return registry.routineRegistrations;
};

const build = () => {
  const repository = {
    listActiveByAgent: vi.fn(async () => []),
    listVersionsByAgent: vi.fn(async () => []),
    findPinnedById: vi.fn(async () => null),
    findById: vi.fn(async () => null),
  } satisfies Pick<RoutineDefinitionRepository, "listActiveByAgent" | "listVersionsByAgent" | "findPinnedById" | "findById">;
  const publishedRoutineSource = createPublishedRoutineRegistrationSource(repository, {
    revisionReader: { findRevision: vi.fn(async () => revision) },
  });
  const loadPinned = vi.spyOn(publishedRoutineSource, "loadPinned");
  const provider = createRoutineTurnProvider({
    agentSkillRepository: { listByAgent: vi.fn(async () => []) },
    capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
    clusteringEmbeddings: {} as never,
    embeddingModelForWorkspace: vi.fn(async () => "unused"),
    logger: { debug: vi.fn(), warn: vi.fn() },
    publishedRoutineSource,
    routineDefinitionRepository: {} as never,
    routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) } as never,
    routineRegistrations: builtInRegistrations(),
    routineTriggerEmbeddingService: { persistPublished: vi.fn() },
    skillExecutorRegistry: {} as never,
    turnPlanAdapters: {
      activator: ({ fallback }) => fallback,
      reentryGate: ({ fallback }) => fallback,
      slotCorrection: ({ fallback }) => fallback,
    },
  });
  return { provider, loadPinned };
};

const gateway = (): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text: "" })) });

const revisionTurn = (pinnedRoutineIds: string[]) => ({
  modelGateway: gateway(),
  agentId: "agent-1",
  agentRevisionId: revision.id,
  workspaceId: "workspace-1",
  pinnedRoutineIds,
});

describe("routine turn provider pins on a revision-bound turn", () => {
  it("resolves a pinned built-in routine to its registration instead of the revision snapshot", async () => {
    const { provider, loadPinned } = build();

    const ports = await provider.forTurn(revisionTurn([BUILT_IN_ROUTINE_ID]));

    expect(ports?.routines?.map((routine) => routine.id)).toContain(BUILT_IN_ROUTINE_ID);
    expect(loadPinned).not.toHaveBeenCalledWith(expect.objectContaining({
      routineIds: expect.arrayContaining([BUILT_IN_ROUTINE_ID]),
    }));
  });

  it("still loads a pinned authored routine from the snapshot alongside a pinned built-in", async () => {
    const { provider, loadPinned } = build();

    const ports = await provider.forTurn(revisionTurn([BUILT_IN_ROUTINE_ID, AUTHORED_ROUTINE_ID]));

    expect(ports?.routines?.map((routine) => routine.id)).toEqual(
      expect.arrayContaining([BUILT_IN_ROUTINE_ID, AUTHORED_ROUTINE_ID]),
    );
    expect(loadPinned).toHaveBeenCalledWith(expect.objectContaining({ routineIds: [AUTHORED_ROUTINE_ID] }));
  });

  it("describes a suspended built-in routine on a revision-bound turn", async () => {
    const { provider } = build();

    const reporter = await provider.reporterFor({
      agentId: "agent-1",
      agentRevisionId: revision.id,
      workspaceId: "workspace-1",
      pinnedRoutineIds: [BUILT_IN_ROUTINE_ID],
    });

    expect(reporter).not.toBeNull();
  });

  it("fails the turn when a pinned authored routine is missing from the revision snapshot", async () => {
    const { provider } = build();

    const turn = provider.forTurn(revisionTurn([BUILT_IN_ROUTINE_ID, MISSING_AUTHORED_ROUTINE_ID]));

    await expect(turn).rejects.toThrow(`pinned_revision_routine_not_found:${MISSING_AUTHORED_ROUTINE_ID}`);
    // Structural fields, so a caller that never logs message text can still tell it apart.
    await expect(turn).rejects.toMatchObject({
      name: "PinnedRevisionRoutineNotFoundError",
      code: "pinned_revision_routine_not_found",
    });
  });
});
