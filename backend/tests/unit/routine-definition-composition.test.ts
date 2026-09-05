import { describe, expect, it, vi } from "vitest";

import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import type { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";

const DEFINITION_ID = "11111111-1111-4111-9111-111111111111";

const definition: RoutineDefinition = {
  id: DEFINITION_ID,
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "handoff",
  version: 1,
  status: "published",
  activation: { triggerDescription: "The user asks for help.", gateRef: "retrieval.answer", priority: 7, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask what they need.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "llm", guardText: "The user answered.", ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
};

type SourceRepository = Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent" | "findPinnedById" | "findById">;

describe("DB-backed routine composition source", () => {
  it("compiles published definitions with the definition id as the routine id (scope-tag identity)", async () => {
    const repository = {
      listPublishedByAgent: vi.fn(async () => [definition]),
      listByAgent: vi.fn(async () => [definition]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;
    const source = createPublishedRoutineRegistrationSource(repository);

    const registrations = await source.load({ agentId: "agent_1" });

    expect(repository.listPublishedByAgent).toHaveBeenCalledWith("agent_1");
    // Directive scope tags (`routine:<id>` / `step:<id>:<stepId>`) match against
    // the engine's activeRoutineId — the compiled id must BE the definition id.
    expect(registrations[0].routine.id).toBe(DEFINITION_ID);
    expect(registrations[0].trigger).toEqual({
      description: "The user asks for help.",
      priority: 7,
      gateRef: "retrieval.answer",
    });
    // Reentry policy is carried by the compiled routine, not duplicated onto the
    // registration, so the registry and the reentry gate cannot disagree.
    expect(registrations[0].routine.activation).toEqual({
      triggerDescription: "The user asks for help.",
      priority: 7,
      reentryMode: "once_per_conversation",
      gateRef: "retrieval.answer",
    });
  });

  it("returns no registrations when an agent has no published routine definitions", async () => {
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    await expect(createPublishedRoutineRegistrationSource(repository).load({ agentId: "agent_1" })).resolves.toEqual([]);
  });

  it("resolves UUID pins directly without scanning all definitions", async () => {
    const superseded = { ...definition, status: "superseded" as const };
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => [superseded]),
      findPinnedById: vi.fn(async () => superseded),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPinned({
      agentId: "agent_1",
      routineIds: [DEFINITION_ID],
    });

    expect(repository.findPinnedById).toHaveBeenCalledWith("agent_1", DEFINITION_ID);
    expect(repository.listByAgent).not.toHaveBeenCalled();
    expect(registrations.map((registration) => registration.routine.id)).toEqual([DEFINITION_ID]);
  });

  it("reports a pinned UUID that resolves to no non-draft definition", async () => {
    const onPinnedDefinitionError = vi.fn();
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository, { onPinnedDefinitionError }).loadPinned({
      agentId: "agent_1",
      routineIds: [DEFINITION_ID],
    });

    expect(registrations).toEqual([]);
    expect(onPinnedDefinitionError).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent_1", routineId: DEFINITION_ID }));
  });

  it("resumes legacy pre-unification pins under the pinned id, excluding drafts", async () => {
    const onPinnedDefinitionError = vi.fn();
    const draft = { ...definition, id: "22222222-2222-4222-9222-222222222222", status: "draft" as const, version: 2 };
    const archived = { ...definition, id: "33333333-3333-4333-9333-333333333333", status: "archived" as const, version: 1 };
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => [draft, archived]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository, {
      onPinnedDefinitionError,
    }).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1", "routine:agent_1:handoff:v2"],
    });

    // The runner resumes by `routine.id === state.routineId`, so the legacy pin id
    // must be preserved on the compiled routine.
    expect(registrations.map((registration) => registration.routine.id)).toEqual(["routine:agent_1:handoff:v1"]);
    expect(onPinnedDefinitionError).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent_1",
      routineId: "routine:agent_1:handoff:v2",
    }));
  });

  it("loadPreview compiles a DRAFT definition by id so it can be test-run in the workbench", async () => {
    const draft = { ...definition, status: "draft" as const };
    const findById = vi.fn(async () => draft);
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById,
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPreview({
      agentId: "agent_1",
      routineIds: [DEFINITION_ID],
    });

    // Preview bypasses the published-only gate: findById returns any status.
    expect(findById).toHaveBeenCalledWith("agent_1", DEFINITION_ID);
    expect(repository.listPublishedByAgent).not.toHaveBeenCalled();
    expect(registrations).toHaveLength(1);
    expect(registrations[0].routine.id).toBe(DEFINITION_ID);
    expect(registrations[0].trigger.description).toBe("The user asks for help.");
  });

  it("loadPreview reports a preview id that resolves to no definition and skips it", async () => {
    const onPreviewDefinitionError = vi.fn();
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository, {
      onPreviewDefinitionError,
    }).loadPreview({ agentId: "agent_1", routineIds: [DEFINITION_ID] });

    expect(registrations).toEqual([]);
    expect(onPreviewDefinitionError).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent_1", routineId: DEFINITION_ID }),
    );
  });

  it("resolves legacy pin collisions by status rank and then highest version", async () => {
    const archived = { ...definition, id: "44444444-4444-4444-9444-444444444444", status: "archived" as const };
    const superseded = { ...definition, id: "55555555-5555-4555-9555-555555555555", status: "superseded" as const };
    const published = { ...definition, id: "66666666-6666-4666-9666-666666666666", status: "published" as const };
    const repository = {
      listPublishedByAgent: vi.fn(async () => []),
      listByAgent: vi.fn(async () => [archived, superseded, published]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1"],
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].routine.id).toBe("routine:agent_1:handoff:v1");
    expect(registrations[0].trigger.priority).toBe(published.activation.priority);
  });
});
