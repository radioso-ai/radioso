import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  compileRoutineDefinition,
  RoutineDefinitionService,
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionRepositoryPort,
} from "../../src/modules/routines/public.js";
import type { SkillAuthoringCatalog, SkillAuthoringDescriptor } from "../../src/modules/skills/public.js";
import type { AgentContextVariableEnablement, ContextVariable } from "../../src/modules/context-variables/public.js";
import { capabilityNames, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const knownDestinationId = "33333333-3333-4333-8333-333333333333";
const missingDestinationId = "44444444-4444-4444-8444-444444444444";

class FakeRoutineDefinitionRepository implements RoutineDefinitionRepositoryPort {
  readonly items = new Map<string, RoutineDefinition>();
  publishError: unknown = undefined;
  restoreError: unknown = undefined;

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
      lineageId: randomUUID(),
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

  async publish(
    inputAgentId: string,
    id: string,
    options?: Parameters<RoutineDefinitionRepositoryPort["publish"]>[2],
  ): Promise<RoutineDefinition> {
    if (this.publishError) {
      throw this.publishError;
    }
    const draft = await this.findById(inputAgentId, id);
    if (!draft) {
      throw new Error("not_found");
    }
    const now = new Date();
    const previousPublished = [...this.items.values()].find((definition) =>
      definition.agentId === inputAgentId &&
      definition.lineageId === draft.lineageId &&
      definition.status === "published"
    );
    const routine: RoutineDefinition = {
      ...draft,
      status: "published",
      updatedAt: now,
    };
    await options?.onPublished?.({
      previousPublishedId: previousPublished?.id ?? null,
      newDefinitionId: routine.id,
      transaction: { kind: "fake-transaction" },
    });
    if (previousPublished) {
      this.items.set(previousPublished.id, {
        ...previousPublished,
        status: "superseded",
        updatedAt: now,
      });
    }
    this.items.set(routine.id, routine);
    return routine;
  }

  async createRevisionDraft(inputAgentId: string, publishedId: string): Promise<RoutineDefinition | null> {
    const published = await this.findById(inputAgentId, publishedId);
    if (!published || published.status !== "published") {
      return null;
    }
    const existingDraft = [...this.items.values()].find((definition) =>
      definition.agentId === inputAgentId &&
      definition.lineageId === published.lineageId &&
      definition.status === "draft"
    );
    if (existingDraft) {
      return existingDraft;
    }
    const now = new Date();
    const draft: RoutineDefinition = {
      ...published,
      id: randomUUID(),
      version: Math.max(
        0,
        ...[...this.items.values()]
          .filter((definition) => definition.agentId === inputAgentId && definition.lineageId === published.lineageId)
          .map((definition) => definition.version),
      ) + 1,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(draft.id, draft);
    return draft;
  }

  async archive(inputAgentId: string, id: string): Promise<boolean> {
    const existing = await this.findById(inputAgentId, id);
    if (!existing || existing.status !== "published") {
      return false;
    }
    this.items.set(id, { ...existing, status: "archived", updatedAt: new Date() });
    return true;
  }

  async restore(inputAgentId: string, id: string): Promise<boolean> {
    if (this.restoreError) {
      throw this.restoreError;
    }
    const existing = await this.findById(inputAgentId, id);
    if (!existing || existing.status !== "archived") {
      return false;
    }
    const hasPublished = [...this.items.values()].some((definition) =>
      definition.agentId === inputAgentId &&
      definition.lineageId === existing.lineageId &&
      definition.status === "published"
    );
    if (hasPublished) {
      return false;
    }
    this.items.set(id, { ...existing, status: "published", updatedAt: new Date() });
    return true;
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
    reentryMode: "once_per_conversation",
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
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
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
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
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
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }, {
    fromStep: "step_send",
    toRef: "terminal_complete",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
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
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }, {
    fromStep: "step_lookup",
    toRef: "terminal_complete",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
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

const skillDescriptor = (skillName: string): SkillAuthoringDescriptor => ({
  skillName,
  displayName: skillName,
  category: "external_mcp",
  inputs: [],
  outcomes: [{
    name: "completed",
    displayName: "Completed",
    status: "completed",
  }],
  hasDataOutputs: false,
});

const contextVariable = (name: string, valueType: ContextVariable["valueType"]): ContextVariable => ({
  id: randomUUID(),
  workspaceId,
  name,
  description: null,
  valueType,
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date("2026-06-24T00:00:00.000Z"),
  updatedAt: new Date("2026-06-24T00:00:00.000Z"),
});

const contextVariableEnablement = (
  variable: ContextVariable,
  enabled = true,
): AgentContextVariableEnablement => ({
  id: randomUUID(),
  agentId,
  variableId: variable.id,
  source: "pushed",
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: "on_reference",
  enabled,
  createdAt: new Date("2026-06-24T00:00:00.000Z"),
  updatedAt: new Date("2026-06-24T00:00:00.000Z"),
  variable,
});


const createService = (options: {
  actionCapabilities?: ActionCapabilityMap;
  capabilityPolicy?: CapabilityPolicy;
  knownWebhookDestinations?: Set<string>;
  directiveScopeTags?: ConstructorParameters<typeof RoutineDefinitionService>[0]["directiveScopeTags"];
  skillAuthoringCatalog?: SkillAuthoringCatalog;
  additionalRoutineSkillNames?: (input: { workspaceId: string; agentId: string }) => Promise<readonly string[]>;
  contextVariableReader?: ConstructorParameters<typeof RoutineDefinitionService>[0]["contextVariableReader"];
} = {}) => {
  const repository = new FakeRoutineDefinitionRepository();
  const auditService = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new RoutineDefinitionService({
    repository,
    auditService,
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
    directiveScopeTags: options.directiveScopeTags,
    ...options,
  });
  return { auditService, repository, service };
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
        id: draft.routine.id,
        status: "published",
        version: 1,
      },
      validation: {
        ok: true,
        diagnostics: [],
      },
    });
  });

  it("publishes a tool step that names a skill, dispatched through the skill port", async () => {
    const { service } = createService({
      skillAuthoringCatalog: {
        listForAgent: vi.fn(async () => [skillDescriptor("account.lookup")]),
        getForAgent: vi.fn(),
      },
    });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      routine: { id: draft.routine.id, status: "published" },
      validation: { ok: true, diagnostics: [] },
    });
  });

  it("rejects publish and explicit validation when a tool step references a skill outside the agent catalog", async () => {
    const catalog = {
      listForAgent: vi.fn(async () => [skillDescriptor("billing.lookup")]),
      getForAgent: vi.fn(),
    };
    const { service } = createService({ skillAuthoringCatalog: catalog });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validate = await service.validate(workspaceId, agentId, { id: draft.routine.id });
    const publish = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(validate).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "unknown_skill",
        location: "step:step_lookup",
      })],
    });
    expect(publish).toMatchObject({
      rejected: true,
      validation: {
        ok: false,
        diagnostics: [expect.objectContaining({
          code: "unknown_skill",
          location: "step:step_lookup",
        })],
      },
    });
    expect(catalog.listForAgent).toHaveBeenCalledWith({ workspaceId, agentId });
  });

  it("accepts a tool step whose skill is runtime-resolvable but not in the catalog (webhook/customer-email)", async () => {
    const catalog = {
      // catalog does NOT include account.lookup (e.g. a webhook/email skill)
      listForAgent: vi.fn(async () => [skillDescriptor("billing.lookup")]),
      getForAgent: vi.fn(),
    };
    const additionalRoutineSkillNames = vi.fn(async () => ["account.lookup"]);
    const { service } = createService({ skillAuthoringCatalog: catalog, additionalRoutineSkillNames });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validate = await service.validate(workspaceId, agentId, { id: draft.routine.id });
    const publish = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(validate.diagnostics.find((d) => d.code === "unknown_skill")).toBeUndefined();
    expect(publish).not.toMatchObject({ rejected: true });
    expect(additionalRoutineSkillNames).toHaveBeenCalledWith({ workspaceId, agentId });
  });

  it("passes skill descriptors into publish validation for typed required inputs", async () => {
    const catalog = {
      listForAgent: vi.fn(async () => [{
        ...skillDescriptor("account.lookup"),
        inputs: [{ key: "accountId", type: "text", required: true }],
      } satisfies SkillAuthoringDescriptor]),
      getForAgent: vi.fn(),
    };
    const { service } = createService({ skillAuthoringCatalog: catalog });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validate = await service.validate(workspaceId, agentId, { id: draft.routine.id });
    const publish = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(validate.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "unsatisfiable_required_input",
        location: "step:step_lookup.inputBindings.accountId",
      }),
    ]));
    expect(publish).toMatchObject({
      rejected: true,
      validation: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "unsatisfiable_required_input",
            location: "step:step_lookup.inputBindings.accountId",
          }),
        ]),
      },
    });
  });

  it("passes available context variables and built-ins into strict validation", async () => {
    const catalog = {
      listForAgent: vi.fn(async () => [{
        ...skillDescriptor("account.lookup"),
        inputs: [
          { key: "cart", type: "text", required: false },
          { key: "page", type: "text", required: false },
        ],
      } satisfies SkillAuthoringDescriptor]),
      getForAgent: vi.fn(),
    };
    const contextVariableReader = {
      listByAgent: vi.fn(async () => [contextVariableEnablement(contextVariable("cart", "json"))]),
    };
    const { service } = createService({ skillAuthoringCatalog: catalog, contextVariableReader });
    const draft = await service.createDraft(workspaceId, agentId, {
      ...toolDraft(),
      steps: toolDraft().steps.map((step) =>
        step.stableStepId === "step_lookup"
          ? {
            ...step,
            metadata: {
              inputBindings: {
                cart: { kind: "contextVariableRef", contextVariable: "cart" },
                page: { kind: "contextVariableRef", contextVariable: "page_context" },
              },
            },
          }
          : step
      ),
    });

    const validate = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validate.diagnostics.find((diagnostic) => diagnostic.code === "unknown_context_variable")).toBeUndefined();
    expect(validate.diagnostics.find((diagnostic) => diagnostic.code === "input_type_mismatch")).toBeUndefined();
    expect(contextVariableReader.listByAgent).toHaveBeenCalledWith(workspaceId, agentId);
  });

  it("rejects publishing an action step with no follow-up", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...actionDraft("contact.send"),
      transitions: [{
        fromStep: "step_collect_topic",
        toRef: "step_send",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
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

  it("rejects the removed fork step kind at the authoring schema boundary", () => {
    expect(() => routineDefinitionDraftInputSchema.parse({
      ...validDraft(),
      steps: [{
        ...validDraft().steps[0],
        kind: "fork",
      }],
    })).toThrow();
  });

  it("accepts default as the only unconditioned authored transition guard", () => {
    const parsed = routineDefinitionDraftInputSchema.parse(validDraft());

    expect(parsed.transitions[0]?.guardKind).toBe("default");
  });

  it("compiles a non-collecting step's default guard to the default runtime guard", () => {
    const now = new Date();
    const routine = compileRoutineDefinition({
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      lineageId: "55555555-5555-4555-8555-555555555555",
      version: 1,
      status: "published",
      createdAt: now,
      updatedAt: now,
      ...validDraft(),
      slots: [],
      // A step with no {{slot.x}} reference is not a collection step, so its default
      // edge stays a literal default guard (not auto-gated).
      steps: [{ stableStepId: "step_confirm", kind: "chat", instruction: "Confirm with the user.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "step_confirm", toRef: "terminal_complete", guardKind: "default", guardText: null, ordinal: 0 }],
      terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Thank the user.", ordinal: 0 }],
    });

    expect(routine.transitions).toEqual([
      expect.objectContaining({
        from: "step_confirm",
        to: "terminal_complete",
        condition: "default",
        guard: { kind: "default" },
      }),
    ]);
  });

  it("auto-gates a collection step whose only exit is a default guard (so the slot is captured)", () => {
    const now = new Date();
    const routine = compileRoutineDefinition({
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      lineageId: "55555555-5555-4555-8555-555555555555",
      version: 1,
      status: "published",
      createdAt: now,
      updatedAt: now,
      ...validDraft(),
    });

    // `step_collect_topic` asks for {{slot.topic}} with a bare default edge: promoted to
    // a selector-running (llm) transition — no structured guard, slot-aware condition.
    const edge = routine.transitions.find((transition) => transition.from === "step_collect_topic");
    expect(edge?.guard).toBeUndefined();
    expect(edge?.condition).toContain("{{slot.topic}}");
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

  it("includes an empty directive scope orphan list in successful publish results when no directives port is wired", async () => {
    const { service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());

    const result = await service.publish(workspaceId, agentId, draft.routine.id);

    expect(result).toMatchObject({
      directiveScopeOrphans: [],
      routine: {
        status: "published",
      },
    });
  });

  it("surfaces directive scope orphans from publish-time scope tag re-pointing", async () => {
    const directiveScopeTags = {
      repointRoutineScopeTags: vi.fn(async () => ({
        repointed: 1,
        orphans: [{
          directiveId: "directive-1",
          scopeTag: "step:old-definition:removed",
          reason: "missing_step" as const,
        }],
      })),
    };
    const { repository, service } = createService({ directiveScopeTags });
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    const firstPublish = await service.publish(workspaceId, agentId, draft.routine.id);
    if ("rejected" in firstPublish) {
      throw new Error("expected first publish success");
    }
    const revision = await service.revise(workspaceId, agentId, firstPublish.routine.id);
    repository.items.set(firstPublish.routine.id, firstPublish.routine);

    const result = await service.publish(workspaceId, agentId, revision.id);

    expect(result).toMatchObject({
      directiveScopeOrphans: [{
        directiveId: "directive-1",
        scopeTag: "step:old-definition:removed",
        reason: "missing_step",
      }],
    });
    expect(directiveScopeTags.repointRoutineScopeTags).toHaveBeenCalledWith({
      agentId,
      fromDefinitionId: firstPublish.routine.id,
      toDefinitionId: expect.any(String),
      survivingStepIds: new Set(["step_collect_topic"]),
      transaction: { kind: "fake-transaction" },
    });
  });

  it("emits audit events for publish, revise, archive, and restore", async () => {
    const { auditService, repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    const publish = await service.publish(workspaceId, agentId, draft.routine.id);
    if ("rejected" in publish) {
      throw new Error("expected publish success");
    }

    const revision = await service.revise(workspaceId, agentId, publish.routine.id);
    await service.archive(workspaceId, agentId, publish.routine.id);
    repository.items.set(publish.routine.id, { ...publish.routine, status: "archived" });
    await service.restore(workspaceId, agentId, publish.routine.id);

    expect(revision.status).toBe("draft");
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routine_definition.publish",
      eventStatus: "success",
      workspaceId,
      metadata: expect.objectContaining({
        agentId,
        routineId: publish.routine.id,
        lineageId: publish.routine.lineageId,
        version: publish.routine.version,
        supersededDefinitionId: null,
        directiveScopeOrphans: 0,
      }),
    }));
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routine_definition.revise",
      eventStatus: "success",
    }));
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routine_definition.archive",
      eventStatus: "success",
    }));
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "routine_definition.restore",
      eventStatus: "success",
    }));
  });

  it("returns an existing draft when revising a published lineage that already has one", async () => {
    const { service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    const publish = await service.publish(workspaceId, agentId, draft.routine.id);
    if ("rejected" in publish) {
      throw new Error("expected publish success");
    }

    const firstRevision = await service.revise(workspaceId, agentId, publish.routine.id);
    const secondRevision = await service.revise(workspaceId, agentId, publish.routine.id);

    expect(secondRevision.id).toBe(firstRevision.id);
    expect(secondRevision.lineageId).toBe(publish.routine.lineageId);
  });

  it("rejects illegal archive and restore lifecycle transitions", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());

    await expect(service.archive(workspaceId, agentId, draft.routine.id))
      .rejects.toThrow("Only published routine definitions can be archived");
    await expect(service.restore(workspaceId, agentId, draft.routine.id))
      .rejects.toThrow("Only archived routine definitions can be restored");

    const archived: RoutineDefinition = {
      ...draft.routine,
      id: randomUUID(),
      status: "archived",
    };
    const publishedSameLineage: RoutineDefinition = {
      ...draft.routine,
      id: randomUUID(),
      status: "published",
    };
    repository.items.set(archived.id, archived);
    repository.items.set(publishedSameLineage.id, publishedSameLineage);

    await expect(service.restore(workspaceId, agentId, archived.id))
      .rejects.toThrow("Archived routine definition cannot be restored while another version is published");
  });

  it("turns a missing completion export destination during restore into a bad request", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: missingDestinationId,
      },
    });
    const archived: RoutineDefinition = {
      ...draft.routine,
      status: "archived",
    };
    repository.items.set(archived.id, archived);
    repository.restoreError = Object.assign(
      new Error(`published routine completion export references unknown webhook destination ${missingDestinationId}`),
      {
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      },
    );

    await expect(service.restore(workspaceId, agentId, archived.id))
      .rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(missingDestinationId),
      });
  });

  it("maps a draft save that raced a publish to an author-facing conflict", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    // Simulate publish committing between the service's status pre-check and the
    // repository write: the repository's zero-row guard throws the marker error.
    repository.updateDraft = async (_agentId: string, id: string) => {
      throw new Error(`routine_definition_update_conflict:${id}`);
    };

    await expect(service.updateDraft(workspaceId, agentId, draft.routine.id, validDraft()))
      .rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("published concurrently"),
      });
  });
});
