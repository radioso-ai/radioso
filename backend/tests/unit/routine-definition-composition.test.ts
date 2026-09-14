import { describe, expect, it, vi } from "vitest";

import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import type { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";

const DEFINITION_ID = "11111111-1111-4111-9111-111111111111";

const definition: RoutineDefinition = {
  id: DEFINITION_ID,
  agentId: "agent_1",
  lineageId: "lineage_1",
  name: "handoff",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The user asks for help.", gateRef: "retrieval.answer", priority: 7, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask what they need.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask", toRef: "done", guardKind: "llm", guardText: "The user answered.", ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm.", ordinal: 0 }],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
};

type SourceRepository = Pick<RoutineDefinitionRepository, "listActiveByAgent" | "listVersionsByAgent" | "findPinnedById" | "findById">;

describe("DB-backed routine composition source", () => {
  it("loads the complete routine closure from a pinned agent revision instead of mutable routine rows", async () => {
    const mutableDefinition = { ...definition, name: "mutable latest" };
    const frozenDefinition = { ...definition, activation: { ...definition.activation, priority: 12 } };
    const repository = {
      listActiveByAgent: vi.fn(async () => [mutableDefinition]),
      listVersionsByAgent: vi.fn(async () => [mutableDefinition]),
      findPinnedById: vi.fn(async () => mutableDefinition),
      findById: vi.fn(async () => mutableDefinition),
    } as SourceRepository;
    const frozenRevision: AgentRevision = {
      id: "77777777-7777-4777-8777-777777777777",
      snapshot: { customInstruction: "", directives: [], routines: [frozenDefinition], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    };
    const revisionReader = { findRevision: vi.fn(async () => frozenRevision) };
    const source = createPublishedRoutineRegistrationSource(repository, { revisionReader });

    const registrations = await source.load({ agentId: "agent_1", workspaceId: "ws_1", agentRevisionId: frozenRevision.id });

    expect(registrations.map((registration) => registration.trigger.priority)).toEqual([12]);
    expect(repository.listActiveByAgent).not.toHaveBeenCalled();
    expect(revisionReader.findRevision).toHaveBeenCalledWith({
      agentId: "agent_1",
      workspaceId: "ws_1",
      revisionId: frozenRevision.id,
    });
  });

  it("carries persisted coverage criteria into the engine activation", async () => {
    const repository = {
      listActiveByAgent: vi.fn(async () => [{ ...definition, activation: { ...definition.activation, coverageCriteria: { coverage: ["partial"], reasons: ["insufficient_evidence"] } } }]),
      listVersionsByAgent: vi.fn(async () => []), findPinnedById: vi.fn(async () => null), findById: vi.fn(async () => null),
    } as SourceRepository;
    const registrations = await createPublishedRoutineRegistrationSource(repository).load({ agentId: "agent_1" });
    expect(registrations[0].routine.activation?.coverageCriteria).toEqual({ coverage: ["partial"], reasons: ["insufficient_evidence"] });
  });

  it("compiles active definitions with the definition id as the routine id (scope-tag identity)", async () => {
    const repository = {
      listActiveByAgent: vi.fn(async () => [definition]),
      listVersionsByAgent: vi.fn(async () => [definition]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;
    const source = createPublishedRoutineRegistrationSource(repository);

    const registrations = await source.load({ agentId: "agent_1" });

    expect(repository.listActiveByAgent).toHaveBeenCalledWith("agent_1");
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

  it("returns no registrations when an agent has no active routine definitions", async () => {
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    await expect(createPublishedRoutineRegistrationSource(repository).load({ agentId: "agent_1" })).resolves.toEqual([]);
  });

  it("resolves UUID pins directly without scanning all definitions, even a since-disabled one", async () => {
    // Pinned resume never consults `enabled`: a visitor mid-routine finishes the version they
    // started, including one an operator has since taken out of service.
    const disabled = { ...definition, enabled: false };
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => [disabled]),
      findPinnedById: vi.fn(async () => disabled),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPinned({
      agentId: "agent_1",
      routineIds: [DEFINITION_ID],
    });

    expect(repository.findPinnedById).toHaveBeenCalledWith("agent_1", DEFINITION_ID);
    expect(repository.listVersionsByAgent).not.toHaveBeenCalled();
    expect(registrations.map((registration) => registration.routine.id)).toEqual([DEFINITION_ID]);
  });

  it("reports a pinned UUID that resolves to no definition", async () => {
    const onPinnedDefinitionError = vi.fn();
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => []),
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

  it("resumes legacy pre-unification pins under the pinned id, regardless of enabled state", async () => {
    // Legacy pin resolution never filters by `enabled` either — the same pinned-resume
    // guarantee applies whether the definition was reached by a modern UUID pin or by one of
    // these pre-cutover synthetic ids.
    const disabledOld = { ...definition, id: "22222222-2222-4222-9222-222222222222", enabled: false, version: 1 };
    const current = { ...definition, id: "33333333-3333-4333-9333-333333333333", version: 2 };
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => [disabledOld, current]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;
    const onPinnedDefinitionError = vi.fn();

    const registrations = await createPublishedRoutineRegistrationSource(repository, {
      onPinnedDefinitionError,
    }).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1", "routine:agent_1:handoff:v2"],
    });

    // The runner resumes by `routine.id === state.routineId`, so the legacy pin id
    // must be preserved on the compiled routine.
    expect(registrations.map((registration) => registration.routine.id)).toEqual([
      "routine:agent_1:handoff:v1",
      "routine:agent_1:handoff:v2",
    ]);
    expect(onPinnedDefinitionError).not.toHaveBeenCalled();
  });

  it("loadPreview compiles a definition by id even when it is disabled, so it can be test-run in the workbench", async () => {
    const disabled = { ...definition, enabled: false };
    const findById = vi.fn(async () => disabled);
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => []),
      findPinnedById: vi.fn(async () => null),
      findById,
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPreview({
      agentId: "agent_1",
      routineIds: [DEFINITION_ID],
    });

    // Preview bypasses the enabled-only gate: findById returns the definition regardless.
    expect(findById).toHaveBeenCalledWith("agent_1", DEFINITION_ID);
    expect(repository.listActiveByAgent).not.toHaveBeenCalled();
    expect(registrations).toHaveLength(1);
    expect(registrations[0].routine.id).toBe(DEFINITION_ID);
    expect(registrations[0].trigger.description).toBe("The user asks for help.");
  });

  it("loadPreview reports a preview id that resolves to no definition and skips it", async () => {
    const onPreviewDefinitionError = vi.fn();
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => []),
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

  it("keeps the first-registered row when two legacy-pin definitions collide at the same version", async () => {
    // (agent_id, name, version) is unique in the schema (routine_definition_agent_id_name_
    // version_key), so two distinct rows can never legitimately collide on this key — legacyId
    // is exactly that triple. This pins down the resolver's defensive first-registered-wins
    // guard so it stays deterministic even if that invariant were ever violated.
    const first = { ...definition, id: "44444444-4444-4444-9444-444444444444" };
    const second = { ...definition, id: "55555555-5555-4555-9555-555555555555", activation: { ...definition.activation, priority: 99 } };
    const repository = {
      listActiveByAgent: vi.fn(async () => []),
      listVersionsByAgent: vi.fn(async () => [first, second]),
      findPinnedById: vi.fn(async () => null),
      findById: vi.fn(async () => null),
    } as SourceRepository;

    const registrations = await createPublishedRoutineRegistrationSource(repository).loadPinned({
      agentId: "agent_1",
      routineIds: ["routine:agent_1:handoff:v1"],
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].routine.id).toBe("routine:agent_1:handoff:v1");
    expect(registrations[0].trigger.priority).toBe(first.activation.priority);
  });
});
