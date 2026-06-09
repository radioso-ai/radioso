import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RoutineDefinitionService,
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionRepositoryPort,
} from "../../src/modules/routines/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

class FakeRoutineDefinitionRepository implements RoutineDefinitionRepositoryPort {
  readonly items = new Map<string, RoutineDefinition>();

  async listByAgent(inputAgentId: string): Promise<RoutineDefinition[]> {
    return [...this.items.values()].filter((definition) => definition.agentId === inputAgentId);
  }

  async findById(inputAgentId: string, id: string): Promise<RoutineDefinition | null> {
    const item = this.items.get(id);
    return item && item.agentId === inputAgentId ? item : null;
  }

  async createDraft(inputAgentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const now = new Date();
    const routine: RoutineDefinition = {
      id: randomUUID(),
      agentId: inputAgentId,
      version: 1,
      status: "draft",
      ...routineDefinitionDraftInputSchema.parse(input),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(routine.id, routine);
    return routine;
  }

  async updateDraft(inputAgentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const existing = await this.findById(inputAgentId, id);
    if (!existing || existing.status !== "draft") {
      throw new Error("not_found");
    }
    const routine = {
      ...existing,
      ...routineDefinitionDraftInputSchema.parse(input),
      updatedAt: new Date(),
    };
    this.items.set(id, routine);
    return routine;
  }

  async publish(inputAgentId: string, id: string): Promise<RoutineDefinition> {
    const draft = await this.findById(inputAgentId, id);
    if (!draft) {
      throw new Error("not_found");
    }
    const now = new Date();
    const routine: RoutineDefinition = {
      ...draft,
      id: randomUUID(),
      version: 2,
      status: "published",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(routine.id, routine);
    return routine;
  }

  async deleteDraft(inputAgentId: string, id: string): Promise<boolean> {
    const existing = await this.findById(inputAgentId, id);
    return existing?.status === "draft" ? this.items.delete(id) : false;
  }
}

const validDraft = (): RoutineDefinitionDraftInput => ({
  name: "support-intake",
  activation: {
    triggerDescription: "When the user asks for support intake",
    gateRef: null,
    priority: 10,
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: null,
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "step_collect_topic",
    kind: "chat",
    instruction: "Ask for {{slot.topic}}.",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "terminal_complete",
    guardKind: "always",
    guardText: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: "Complete intake for {{slot.topic}}.",
    actionType: null,
    ordinal: 1,
  }],
});

const invalidDraft = (): RoutineDefinitionDraftInput => ({
  ...validDraft(),
  slots: [],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "missing_step",
    guardKind: "always",
    guardText: null,
    ordinal: 0,
  }],
});

const createService = () => {
  const repository = new FakeRoutineDefinitionRepository();
  const service = new RoutineDefinitionService({
    repository,
    agentRepository: {
      async findByIdAndWorkspaceId(inputAgentId, inputWorkspaceId) {
        return inputAgentId === agentId && inputWorkspaceId === workspaceId
          ? { id: agentId }
          : null;
      },
    },
  });
  return { repository, service };
};

describe("RoutineDefinitionService", () => {
  it("saves graph-invalid drafts and returns advisory author-facing diagnostics", async () => {
    const { service } = createService();

    const result = await service.createDraft(workspaceId, agentId, invalidDraft());

    expect(result.routine.status).toBe("draft");
    expect(result.validation.ok).toBe(false);
    expect(result.validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "referenced_undeclared_slot", location: "slot:topic" }),
      expect.objectContaining({ code: "dangling_step_reference" }),
    ]));
  });

  it("rejects invalid publishes with diagnostics before calling repository publish", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, invalidDraft());

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("publishes valid drafts after validation and compile smoke", async () => {
    const { service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      routine: {
        status: "published",
        version: 2,
      },
      validation: {
        ok: true,
        diagnostics: [],
      },
    });
  });
});
