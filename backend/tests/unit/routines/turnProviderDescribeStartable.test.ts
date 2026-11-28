import { describe, expect, it, vi } from "vitest";

import type { TurnContext } from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../../src/app/composition/builtIn/contactRoutineModule.js";
import { createPublishedRoutineRegistrationSource } from "../../../src/app/composition/routineDefinitionSource.js";
import type { RoutineDefinitionRepository } from "../../../src/db/repositories/routineDefinitionRepository.js";
import { contactRoutineDefinition } from "../../../src/modules/chat/services/routines/contactRoutine.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";

// #1872: the reply to "what can you do?" names the routines this conversation could start,
// so it must apply the same eligibility gates and completed-routine suppression the routine
// registry applies before ranking, never the bare registration list.

const BOOKING_ROUTINE_ID = "11111111-1111-4111-9111-111111111111";

const bookingDefinition: RoutineDefinition = {
  id: BOOKING_ROUTINE_ID,
  agentId: "agent-1",
  lineageId: "lineage-1",
  name: "Book a room",
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

const builtInRegistrations = (): RoutineRegistration[] => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({ logger: { error: () => {} }, registry }).apply([
    createContactRoutineApplicationModule(),
  ]);
  return registry.routineRegistrations;
};

const build = (listActiveByAgent: RoutineDefinitionRepository["listActiveByAgent"] = async () => [bookingDefinition]) => {
  const repository = {
    listActiveByAgent: vi.fn(listActiveByAgent),
    listVersionsByAgent: vi.fn(async () => []),
    findPinnedById: vi.fn(async () => null),
    findById: vi.fn(async () => null),
  } satisfies Pick<RoutineDefinitionRepository, "listActiveByAgent" | "listVersionsByAgent" | "findPinnedById" | "findById">;
  return createRoutineTurnProvider({
    agentSkillRepository: { listByAgent: vi.fn(async () => []) },
    capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
    clusteringEmbeddings: {} as never,
    embeddingModelForWorkspace: vi.fn(async () => "unused"),
    logger: { debug: vi.fn(), warn: vi.fn() },
    publishedRoutineSource: createPublishedRoutineRegistrationSource(repository),
    routineDefinitionRepository: {} as never,
    routineRegistrations: builtInRegistrations(),
    routineTriggerEmbeddingService: { persistPublished: vi.fn() },
    skillExecutorRegistry: {} as never,
    approvalResumeEffectJournal: {} as never,
    turnPlanAdapters: {
      activator: ({ fallback }) => fallback,
      reentryGate: ({ fallback }) => fallback,
      slotCorrection: ({ fallback }) => fallback,
    },
  });
};

const turn = (contact: { contactRequestsEnabled: boolean; hasContactDestination: boolean }): TurnContext => ({
  agent: { id: "agent-1", metadata: { workspaceId: "workspace-1", ...contact } },
  sessionId: "conversation-1",
  inputEvent: { kind: "message", content: "What can you do?" },
  history: [],
  stagedContext: [],
  steering: [],
});

const contactOn = { contactRequestsEnabled: true, hasContactDestination: true };

const startableNames = async (input: { turn: TurnContext; completedRoutineIds?: string[] }) =>
  (await build().describeStartable({
    agentId: "agent-1",
    workspaceId: "workspace-1",
    turn: input.turn,
    completedRoutineIds: input.completedRoutineIds ?? [],
  })).map((routine) => routine.name);

describe("the routines a conversation could start, for a reply about what the agent can do (#1872)", () => {
  it("leaves the contact routine out while the agent takes no contact requests or has nowhere to send them", async () => {
    await expect(startableNames({ turn: turn({ contactRequestsEnabled: false, hasContactDestination: true }) }))
      .resolves.toEqual([bookingDefinition.name]);
    await expect(startableNames({ turn: turn({ contactRequestsEnabled: true, hasContactDestination: false }) }))
      .resolves.toEqual([bookingDefinition.name]);
    await expect(startableNames({ turn: turn(contactOn) }))
      .resolves.toEqual([contactRoutineDefinition.name, bookingDefinition.name]);
  });

  it("names the built-in contact routine the way a visitor reads it, not by an identifier", () => {
    expect(contactRoutineDefinition.name).not.toBe(contactRoutineDefinition.id);
    expect(contactRoutineDefinition.name).toMatch(/\s/);
  });

  it("leaves out a once-per-conversation routine that already completed, and keeps one that may start again", async () => {
    await expect(startableNames({
      turn: turn(contactOn),
      completedRoutineIds: [BOOKING_ROUTINE_ID, contactRoutineDefinition.id],
    })).resolves.toEqual([contactRoutineDefinition.name]);
  });

  it("fails instead of describing no routines when the agent's routines cannot be read", async () => {
    const provider = build(async () => {
      throw new Error("database unavailable");
    });

    await expect(provider.describeStartable({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      turn: turn(contactOn),
      completedRoutineIds: [],
    })).rejects.toThrow("database unavailable");
  });
});
