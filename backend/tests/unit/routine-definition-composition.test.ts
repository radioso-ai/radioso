import { describe, expect, it, vi } from "vitest";

import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import type { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";

const definition: RoutineDefinition = {
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "handoff",
  version: 1,
  status: "published",
  activation: { triggerDescription: "The user asks for help.", gateRef: "retrieval.answer", priority: 7 },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask what they need.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "llm", guardText: "The user answered.", ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
};

describe("DB-backed routine composition source", () => {
  it("loads published definitions, compiles them, and preserves trigger metadata for ranked activation", async () => {
    const repository = {
      listPublishedByAgent: vi.fn(async () => [definition]),
      listByAgent: vi.fn(async () => [definition]),
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent">;
    const source = createPublishedRoutineRegistrationSource(repository);

    const registrations = await source.load({ agentId: "agent_1" });

    expect(repository.listPublishedByAgent).toHaveBeenCalledWith("agent_1");
    expect(registrations[0]!.routine.id).toBe("routine:agent_1:handoff:v1");
    expect(registrations[0]!.trigger).toEqual({
      description: "The user asks for help.",
      priority: 7,
      gateRef: "retrieval.answer",
    });
  });

  it("returns no registrations when an agent has no published routine definitions", async () => {
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => []),
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent">;

    await expect(createPublishedRoutineRegistrationSource(repository).load({ agentId: "agent_1" })).resolves.toEqual([]);
  });

  it("loads pinned registrations from non-draft compiled ids only", async () => {
    const onPinnedDefinitionError = vi.fn();
    const draft = { ...definition, id: "draft_1", status: "draft" as const, version: 2 };
    const archived = { ...definition, id: "archived_1", status: "archived" as const, version: 1 };
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => [draft, archived]),
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent">;

    const registrations = await createPublishedRoutineRegistrationSource(repository, {
      onPinnedDefinitionError,
    }).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1", "routine:agent_1:handoff:v2"],
    });

    expect(registrations.map((registration) => registration.routine.id)).toEqual(["routine:agent_1:handoff:v1"]);
    expect(onPinnedDefinitionError).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent_1",
      routineId: "routine:agent_1:handoff:v2",
    }));
  });

  it("resolves pinned compiled-id collisions by status rank and then highest version", async () => {
    const archived = { ...definition, id: "archived_1", status: "archived" as const };
    const superseded = { ...definition, id: "superseded_1", status: "superseded" as const };
    const published = { ...definition, id: "published_1", status: "published" as const };
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => [archived, superseded, published]),
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent">;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1"],
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.routine.id).toBe("routine:agent_1:handoff:v1");
    expect(registrations[0]!.trigger.priority).toBe(published.activation.priority);
  });
});
