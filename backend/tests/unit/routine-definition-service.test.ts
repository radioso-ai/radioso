import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RoutineDefinitionService,
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionRepositoryPort,
} from "../../src/modules/routines/public.js";
import { capabilityNames, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const knownDestinationId = "33333333-3333-4333-8333-333333333333";
const missingDestinationId = "44444444-4444-4444-8444-444444444444";

class FakeRoutineDefinitionRepository implements RoutineDefinitionRepositoryPort {
  readonly items = new Map<string, RoutineDefinition>();
  publishError: unknown = undefined;

  async listPublishedByAgent(inputAgentId: string): Promise<RoutineDefinition[]> {
    return [...this.items.values()].filter((definition) =>
      definition.agentId === inputAgentId && definition.status === "published"
    );
  }

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
    if (this.publishError) {
      throw this.publishError;
    }
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

const actionDraft = (actionType: string | null): RoutineDefinitionDraftInput => ({
  ...validDraft(),
  steps: [
    ...validDraft().steps,
    {
      stableStepId: "step_send",
      kind: "action",
      instruction: "Emit the contact request.",
      toolRef: null,
      actionType,
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "step_send",
    guardKind: "always",
    guardText: null,
    ordinal: 0,
  }, {
    fromStep: "step_send",
    toRef: "terminal_complete",
    guardKind: "always",
    guardText: null,
    ordinal: 1,
  }],
});

const toolDraft = (): RoutineDefinitionDraftInput => ({
  ...validDraft(),
  steps: [
    ...validDraft().steps,
    {
      stableStepId: "step_lookup",
      kind: "tool",
      instruction: "Look up the account.",
      toolRef: "account.lookup",
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "step_lookup",
    guardKind: "always",
    guardText: null,
    ordinal: 0,
  }, {
    fromStep: "step_lookup",
    toRef: "terminal_complete",
    guardKind: "always",
    guardText: null,
    ordinal: 1,
  }],
});

class FakeActionCapabilityMap implements ActionCapabilityMap {
  constructor(private readonly capabilitiesByType: Map<string, string[]>) {}

  has(type: string): boolean {
    return this.capabilitiesByType.has(type);
  }

  requiredCapabilitiesFor(type: string): string[] {
    return this.capabilitiesByType.get(type) ?? [];
  }
}

class FakeCapabilityPolicy implements CapabilityPolicy {
  constructor(private readonly deniedCapabilities = new Set<string>()) {}

  async can(input: { capability: string }): Promise<{ allowed: boolean; reason?: string }> {
    return this.deniedCapabilities.has(input.capability)
      ? { allowed: false, reason: "capability_denied" }
      : { allowed: true };
  }
}

const createService = (options: {
  actionCapabilities?: ActionCapabilityMap;
  capabilityPolicy?: CapabilityPolicy;
  knownWebhookDestinations?: Set<string>;
} = {}) => {
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
    webhookDestinations: {
      async existsByIdAndWorkspace(inputWorkspaceId, destinationId) {
        return inputWorkspaceId === workspaceId && options.knownWebhookDestinations?.has(destinationId) === true;
      },
    },
    ...options,
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

  it("rejects publishing a tool step until routine skill dispatch is supported", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "unsupported_tool_step",
            location: "step:step_lookup",
            message: expect.stringContaining("tool steps are not yet supported"),
          }),
        ],
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("rejects publishing an action step with no follow-up", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...actionDraft("contact.send"),
      transitions: [{
        fromStep: "step_collect_topic",
        toRef: "step_send",
        guardKind: "always",
        guardText: null,
        ordinal: 0,
      }],
    });

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "missing_action_follow_up",
            location: "step:step_send",
          }),
        ]),
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("rejects publishing an action step without an action type", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, actionDraft(null));

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "dangling_action_reference",
            location: "step:step_send",
          }),
        ],
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("rejects publishing an action step when the workspace lacks the required capability", async () => {
    const { repository, service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      capabilityPolicy: new FakeCapabilityPolicy(new Set([capabilityNames.humanContact.request])),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("contact.send"));

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "action_capability_denied",
            location: "step:step_send",
          }),
        ],
      },
    });
    expect("rejected" in result && result.validation.diagnostics[0]?.message).toContain("contact.send");
    expect("rejected" in result && result.validation.diagnostics[0]?.message).toContain(capabilityNames.humanContact.request);
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("rejects publishing an action step for an unregistered action type", async () => {
    const { service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map()),
      capabilityPolicy: new FakeCapabilityPolicy(),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("unknown.send"));

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "unregistered_action_type",
            location: "step:step_send",
          }),
        ],
      },
    });
    expect("rejected" in result && result.validation.diagnostics[0]?.message).toContain("unknown.send");
  });

  it("publishes an action step when the workspace has the required capability", async () => {
    const { service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      capabilityPolicy: new FakeCapabilityPolicy(),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("contact.send"));

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      routine: {
        status: "published",
      },
      validation: {
        ok: true,
      },
    });
  });

  it("rejects publish when enabled completion export has a malformed destination ref", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "missing-destination",
      },
    });

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "invalid_webhook_destination_ref",
            location: "completionExport.destinationRef",
            message: expect.stringContaining("missing-destination"),
          }),
        ],
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("rejects publish when enabled completion export references an unknown destination UUID", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: missingDestinationId,
      },
    });

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "unknown_webhook_destination",
            location: "completionExport.destinationRef",
            message: expect.stringContaining(missingDestinationId),
          }),
        ],
      },
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("turns a concurrent destination delete during publish into a validation rejection", async () => {
    const { repository, service } = createService({ knownWebhookDestinations: new Set([knownDestinationId]) });
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: knownDestinationId,
      },
    });
    repository.publishError = Object.assign(
      new Error("published routine completion export references unknown webhook destination"),
      {
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      },
    );

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: "unknown_webhook_destination",
            location: "completionExport.destinationRef",
            message: expect.stringContaining(knownDestinationId),
          }),
        ],
      },
    });
  });

  it("publishes when enabled completion export references a workspace destination", async () => {
    const { service } = createService({ knownWebhookDestinations: new Set([knownDestinationId]) });
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete", "handoff"],
        destinationRef: knownDestinationId,
      },
    });

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      routine: {
        status: "published",
        completionExport: {
          enabled: true,
          triggerKinds: ["complete", "handoff"],
          destinationRef: knownDestinationId,
        },
      },
      validation: {
        ok: true,
      },
    });
  });
});
