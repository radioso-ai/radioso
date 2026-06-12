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
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent">;
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
    } as Pick<RoutineDefinitionRepository, "listPublishedByAgent">;

    await expect(createPublishedRoutineRegistrationSource(repository).load({ agentId: "agent_1" })).resolves.toEqual([]);
  });
});
