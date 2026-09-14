import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  compileRoutineDefinition,
  RoutineDefinitionService,
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionRepositoryPort,
  type RoutineDefinitionWriteGuard,
} from "../../src/modules/routines/public.js";
import type { SkillAuthoringCatalog, SkillAuthoringDescriptor } from "../../src/modules/skills/public.js";
import type { AgentContextVariableEnablement, ContextVariable } from "../../src/modules/context-variables/public.js";
import { capabilityNames, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";
import { InMemoryRoutineDefinitionRepository } from "../support/fakes.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const knownDestinationId = "33333333-3333-4333-8333-333333333333";
const missingDestinationId = "44444444-4444-4444-8444-444444444444";
const nextFakeRoutineUpdatedAt = (current: Date): Date =>
  new Date(Math.max(Date.now(), current.getTime() + 1));

class FakeRoutineDefinitionRepository implements RoutineDefinitionRepositoryPort {
  readonly items = new Map<string, RoutineDefinition>();
  createDraftError: Error | undefined = undefined;
  updateDraftError: Error | undefined = undefined;

  /** One row per lineage — its highest version — mirroring the SQL repository's read surface. */
  private canonical(inputAgentId: string): RoutineDefinition[] {
    const byLineage = new Map<string, RoutineDefinition>();
    for (const definition of this.items.values()) {
      if (definition.agentId !== inputAgentId) continue;
      const held = byLineage.get(definition.lineageId);
      if (!held || definition.version > held.version) byLineage.set(definition.lineageId, definition);
    }
    return [...byLineage.values()];
  }

  async listByAgent(inputAgentId: string): Promise<RoutineDefinition[]> {
    return this.canonical(inputAgentId);
  }

  // Scans every stored row, canonical or not — mirrors the real repository's
  // findNameVersionOneOccupant, which checks the actual unique-constraint identity rather than
  // the canonical-only read surface.
  async findNameVersionOneOccupant(inputAgentId: string, name: string): Promise<{ id: string; updatedAt: Date } | null> {
    for (const definition of this.items.values()) {
      if (definition.agentId === inputAgentId && definition.name === name && definition.version === 1) {
        return { id: definition.id, updatedAt: definition.updatedAt };
      }
    }
    return null;
  }

  async findById(inputAgentId: string, id: string): Promise<RoutineDefinition | null> {
    const addressed = this.items.get(id);
    if (!addressed || addressed.agentId !== inputAgentId) return null;
    return this.canonical(inputAgentId).find((definition) => definition.lineageId === addressed.lineageId) ?? null;
  }

  async createDraft(inputAgentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    if (this.createDraftError) {
      throw this.createDraftError;
    }
    const now = new Date();
    const id = randomUUID();
    const routine: RoutineDefinition = {
      id,
      agentId: inputAgentId,
      lineageId: id,
      version: 1,
      ...routineDefinitionDraftInputSchema.parse(input),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(routine.id, routine);
    return routine;
  }

  async updateDraft(
    inputAgentId: string,
    id: string,
    input: RoutineDefinitionDraftInput,
    options: RoutineDefinitionWriteGuard = {},
  ): Promise<RoutineDefinition> {
    if (this.updateDraftError) {
      throw this.updateDraftError;
    }
    const existing = await this.findById(inputAgentId, id);
    if (
      !existing ||
      (options.expectedUpdatedAt !== undefined && existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime())
    ) {
      throw new Error(`routine_definition_update_conflict:${id}`);
    }
    const routine = {
      ...existing,
      ...routineDefinitionDraftInputSchema.parse(input),
      updatedAt: nextFakeRoutineUpdatedAt(existing.updatedAt),
    };
    this.items.set(existing.id, routine);
    return routine;
  }

  async setEnabledWithAgentDraft(
    _workspaceId: string,
    inputAgentId: string,
    id: string,
    enabled: boolean,
  ): Promise<RoutineDefinition | null> {
    const existing = await this.findById(inputAgentId, id);
    if (!existing) return null;
    const routine = { ...existing, enabled, updatedAt: nextFakeRoutineUpdatedAt(existing.updatedAt) };
    this.items.set(existing.id, routine);
    return routine;
  }

  async deleteDraft(
    inputAgentId: string,
    id: string,
    options: RoutineDefinitionWriteGuard = {},
  ): ReturnType<RoutineDefinitionRepositoryPort["deleteDraft"]> {
    const existing = await this.findById(inputAgentId, id);
    if (!existing) return { outcome: "not_found" };
    if (options.expectedUpdatedAt && existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
      return { outcome: "conflict" };
    }
    for (const definition of [...this.items.values()]) {
      if (definition.agentId === inputAgentId && definition.lineageId === existing.lineageId) {
        this.items.delete(definition.id);
      }
    }
    return { outcome: "deleted" };
  }

  createDraftWithAgentDraft(_workspaceId: string, inputAgentId: string, input: RoutineDefinitionDraftInput) {
    return this.createDraft(inputAgentId, input);
  }
  updateDraftWithAgentDraft(_workspaceId: string, inputAgentId: string, id: string, input: RoutineDefinitionDraftInput, options?: RoutineDefinitionWriteGuard) {
    return this.updateDraft(inputAgentId, id, input, options);
  }
  deleteDraftWithAgentDraft(_workspaceId: string, inputAgentId: string, id: string, options?: RoutineDefinitionWriteGuard) {
    return this.deleteDraft(inputAgentId, id, options);
  }
}

const validDraft = (): RoutineDefinitionDraftInput => ({
  name: "support-intake",
  enabled: true,
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
  skillAuthoringCatalog?: SkillAuthoringCatalog;
  additionalRoutineSkillNames?: (input: { workspaceId: string; agentId: string }) => Promise<readonly string[]>;
  contextVariableReader?: ConstructorParameters<typeof RoutineDefinitionService>[0]["contextVariableReader"];
  triggerEmbeddingService?: ConstructorParameters<typeof RoutineDefinitionService>[0]["triggerEmbeddingService"];
  auditService?: ConstructorParameters<typeof RoutineDefinitionService>[0]["auditService"];
  logger?: ConstructorParameters<typeof RoutineDefinitionService>[0]["logger"];
} = {}) => {
  const repository = new FakeRoutineDefinitionRepository();
  const auditService = options.auditService ?? { record: vi.fn().mockResolvedValue(undefined) };
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
    ...options,
  });
  return { auditService, repository, service };
};

describe("RoutineDefinitionService", () => {
  it("keeps shared in-memory write tokens monotonic and enforces every routine guard", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    try {
      const repository = new InMemoryRoutineDefinitionRepository();
      const original = await repository.createDraft(agentId, validDraft());
      const updated = await repository.updateDraft(agentId, original.id, validDraft(), {
        expectedUpdatedAt: original.updatedAt,
      });

      expect(updated.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
      await expect(repository.updateDraft(agentId, original.id, validDraft(), {
        expectedUpdatedAt: original.updatedAt,
      })).rejects.toThrow(`routine_definition_update_conflict:${original.id}`);

      const disabled = await repository.setEnabledWithAgentDraft(workspaceId, agentId, original.id, false);
      expect(disabled?.enabled).toBe(false);
      expect(disabled?.updatedAt.getTime()).toBeGreaterThan(updated.updatedAt.getTime());

      await expect(repository.deleteDraft(agentId, original.id, { expectedUpdatedAt: updated.updatedAt }))
        .resolves.toEqual({ outcome: "conflict" });
      await expect(repository.deleteDraft(agentId, original.id, { expectedUpdatedAt: disabled?.updatedAt }))
        .resolves.toEqual({ outcome: "deleted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves graph-invalid drafts and returns advisory author-facing diagnostics", async () => {
    const { service } = createService();

    const result = await service.createDraft(workspaceId, agentId, invalidDraft());

    expect(result.routine.enabled).toBe(true);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "referenced_undeclared_slot", location: "slot:topic" }),
      expect.objectContaining({ code: "dangling_step_reference" }),
    ]));
  });

  it("reports the same structural diagnostics from the serving gate for a saved invalid routine", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, invalidDraft());

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "dangling_step_reference" }),
    ]));
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("maps duplicate routine name and version create conflicts to a domain conflict", async () => {
    const { repository, service } = createService();
    repository.createDraftError = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "routine_definition_agent_id_name_version_key",
      },
    );

    await expect(service.createDraft(workspaceId, agentId, validDraft())).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: "A routine definition with this name and version already exists for this agent",
    });
  });

  it("blocks a create before attempting the write when the name collides with a retired row invisible to list()", async () => {
    // A pre-cutover branched lineage can leave a retired, non-canonical row sitting at
    // (agent_id, name, version 1) — the identity a fresh createDraft always takes — even though
    // its lineage's canonical row has since been renamed away from that name and list() (one
    // canonical row per lineage) never surfaces it. Without this precheck, a plain dashboard/API
    // create only discovers the conflict after the write is attempted and the database's own
    // constraint rejects it; findCreateConflict's underlying check must run for every create
    // caller, not only the copilot's.
    const { repository, service } = createService();
    // A two-row lineage the way the retired publish/revise flow could leave one: a v1 that still
    // occupies (agentId, name, version 1) — the identity a fresh create always takes — and a v2
    // that renamed it, canonical for the lineage. list() only ever returns the canonical row, so
    // it shows one routine named "support-intake-renamed" and nothing named "support-intake" —
    // even though a create of that name would still collide on the real unique constraint.
    const lineageId = randomUUID();
    const retiredId = randomUUID();
    const canonicalId = randomUUID();
    const now = new Date();
    repository.items.set(retiredId, {
      id: retiredId,
      agentId,
      lineageId,
      version: 1,
      ...validDraft(),
      createdAt: now,
      updatedAt: now,
    });
    repository.items.set(canonicalId, {
      id: canonicalId,
      agentId,
      lineageId,
      version: 2,
      ...validDraft(),
      name: "support-intake-renamed",
      createdAt: now,
      updatedAt: now,
    });
    expect((await repository.listByAgent(agentId)).map((routine) => routine.name)).toEqual(["support-intake-renamed"]);

    await expect(service.createDraft(workspaceId, agentId, validDraft())).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: "A routine definition with this name and version already exists for this agent",
    });
    // The write itself was never attempted: nothing new landed in storage.
    expect((await repository.listByAgent(agentId)).map((routine) => routine.name)).toEqual(["support-intake-renamed"]);
  });

  it("maps a rename that collides with another routine's name to the same domain conflict updateDraft's own guard-mismatch already handles", async () => {
    // Every canonical routine is now permanently pinned at version 1 (the routine lifecycle
    // collapse), so a rename colliding with another routine's name hits the real
    // routine_definition_agent_id_name_version_key unique constraint far more often than it used
    // to under the old branching-version model — updateDraft's catch must translate it into the
    // same friendly 409 createDraft's already does, not rethrow it raw.
    const { repository, service } = createService();
    await service.createDraft(workspaceId, agentId, validDraft());
    const other = await service.createDraft(workspaceId, agentId, { ...validDraft(), name: "support-intake-other" });
    repository.updateDraftError = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "routine_definition_agent_id_name_version_key",
      },
    );

    await expect(service.updateDraft(workspaceId, agentId, other.routine.id, {
      ...validDraft(),
      name: "support-intake",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: "A routine definition with this name and version already exists for this agent",
    });
  });

  it("reports a saved valid routine as servable and keeps it in service", async () => {
    const { repository, service } = createService();
    const created = await service.createDraft(workspaceId, agentId, validDraft());

    const validation = await service.validate(workspaceId, agentId, { id: created.routine.id });

    expect(validation).toMatchObject({ ok: true, diagnostics: [] });
    expect(await repository.listByAgent(agentId)).toEqual([
      expect.objectContaining({ id: created.routine.id, version: 1, enabled: true }),
    ]);
  });

  it("accepts an edit to a saved routine and returns the updated content", async () => {
    // There is no state a routine can be in that refuses an edit: authoring is always open.
    const { service } = createService();
    const created = await service.createDraft(workspaceId, agentId, validDraft());

    const updated = await service.updateDraft(workspaceId, agentId, created.routine.id, {
      ...validDraft(),
      name: "support-intake-v2",
      activation: { ...validDraft().activation, triggerDescription: "When the user reports a broken order" },
    });

    expect(updated.routine).toMatchObject({
      id: created.routine.id,
      lineageId: created.routine.lineageId,
      name: "support-intake-v2",
      enabled: true,
      activation: expect.objectContaining({ triggerDescription: "When the user reports a broken order" }),
    });
    expect(updated.validation).toMatchObject({ ok: true, diagnostics: [] });
    expect(await service.get(workspaceId, agentId, created.routine.id)).toMatchObject({
      name: "support-intake-v2",
    });
  });

  it("saves a routine authored as out of service and defaults an unstated flag to in service", async () => {
    const { service } = createService();
    const { enabled: _enabled, ...withoutEnabled } = validDraft();

    const disabled = await service.createDraft(workspaceId, agentId, { ...validDraft(), enabled: false });
    // A distinct name: two routines with the same (agentId, name, version 1) is a real conflict
    // this same service now precheck-rejects (see the createDraft conflict tests above) — not a
    // shape this test is exercising.
    const defaulted = await service.createDraft(workspaceId, agentId, { ...withoutEnabled, name: "support-intake-defaulted" });

    expect(disabled.routine.enabled).toBe(false);
    expect(defaulted.routine.enabled).toBe(true);
  });

  it("takes a routine in and out of service without rewriting its authored graph", async () => {
    const { service } = createService();
    const created = await service.createDraft(workspaceId, agentId, validDraft());

    const disabled = await service.setEnabled(workspaceId, agentId, created.routine.id, false);

    expect(disabled.routine.enabled).toBe(false);
    // Byte-identical: taking a routine out of service must not touch the authored graph.
    expect(JSON.stringify(disabled.routine.steps)).toBe(JSON.stringify(created.routine.steps));
    expect(JSON.stringify(disabled.routine.transitions)).toBe(JSON.stringify(created.routine.transitions));
    expect(JSON.stringify(disabled.routine.slots)).toBe(JSON.stringify(created.routine.slots));
    expect((await service.get(workspaceId, agentId, created.routine.id)).enabled).toBe(false);

    const reEnabled = await service.setEnabled(workspaceId, agentId, created.routine.id, true);

    expect(reEnabled.routine.enabled).toBe(true);
    expect(JSON.stringify(reEnabled.routine.steps)).toBe(JSON.stringify(created.routine.steps));
  });

  it("keeps a disabled routine disabled through an unrelated content edit that omits enabled", async () => {
    // The plain update payload (form/document tab save) is a full draft shape that never
    // mentions `enabled` at all. Zod would otherwise default the omitted field back to
    // `true`, silently re-enabling a routine an operator turned off. Issue: enabled-reset bug.
    const { service } = createService();
    const created = await service.createDraft(workspaceId, agentId, validDraft());
    await service.setEnabled(workspaceId, agentId, created.routine.id, false);
    const { enabled: _enabled, ...draftWithoutEnabled } = validDraft();

    const updated = await service.updateDraft(
      workspaceId,
      agentId,
      created.routine.id,
      { ...draftWithoutEnabled, name: "support-intake-v2" },
    );

    expect(updated.routine.enabled).toBe(false);
    expect((await service.get(workspaceId, agentId, created.routine.id)).enabled).toBe(false);
  });

  it("reports setting enabled on a routine that does not exist as not found", async () => {
    const { service } = createService();

    await expect(service.setEnabled(workspaceId, agentId, randomUUID(), false)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });

  it("finds the row that would block a fresh create of the same name, without attempting one", async () => {
    const { service } = createService();

    expect(await service.findCreateConflict(workspaceId, agentId, "support-intake")).toBeNull();

    const created = await service.createDraft(workspaceId, agentId, validDraft());

    const conflict = await service.findCreateConflict(workspaceId, agentId, "support-intake");
    expect(conflict).toMatchObject({ id: created.routine.id, updatedAt: created.routine.updatedAt });
    // A different name never occupies the same slot.
    expect(await service.findCreateConflict(workspaceId, agentId, "unrelated-name")).toBeNull();
  });

  it("persists the activation trigger when a routine is created and again when it is edited", async () => {
    // Losing the refresh on edit silently stops the activation prefilter from matching the
    // wording an author just saved.
    const persistPublished = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ triggerEmbeddingService: { persistPublished } });
    const created = await service.createDraft(workspaceId, agentId, validDraft());

    await service.updateDraft(workspaceId, agentId, created.routine.id, {
      ...validDraft(),
      activation: { ...validDraft().activation, triggerDescription: "When the user reports a broken order" },
    });

    expect(persistPublished).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId,
      agentId,
      routine: expect.objectContaining({ id: created.routine.id }),
    }));
    expect(persistPublished).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workspaceId,
      agentId,
      routine: expect.objectContaining({
        id: created.routine.id,
        activation: expect.objectContaining({ triggerDescription: "When the user reports a broken order" }),
      }),
    }));
  });

  it("emits create and update audit events carrying the routine's authoring identity", async () => {
    const { auditService, service } = createService();
    const created = await service.createDraft(workspaceId, agentId, validDraft());

    await service.updateDraft(workspaceId, agentId, created.routine.id, {
      ...validDraft(),
      name: "support-intake-v2",
    });

    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      eventType: "routine_definition.create",
      eventStatus: "success",
      metadata: expect.objectContaining({
        agentId,
        routineId: created.routine.id,
        lineageId: created.routine.lineageId,
        enabled: true,
      }),
    }));
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      eventType: "routine_definition.update",
      eventStatus: "success",
      metadata: expect.objectContaining({
        agentId,
        routineId: created.routine.id,
        lineageId: created.routine.lineageId,
        enabled: true,
      }),
    }));
  });

  it("reports a save as successful even when audit recording fails, logging it instead", async () => {
    // The routine's own content already committed by the time the audit write runs — a
    // transient audit-sink failure must not turn an already-saved edit into a reported error
    // (P2: align savedRoutine's two best-effort side effects; persistPublished already never
    // rejects, so recordAuthoringAudit needs the same treatment for consistency).
    const auditFailure = new Error("audit sink unavailable");
    const auditService = { record: vi.fn().mockRejectedValue(auditFailure) };
    const logger = { warn: vi.fn() };
    const { service } = createService({ auditService, logger });

    const created = await service.createDraft(workspaceId, agentId, validDraft());

    expect(created.routine).toMatchObject({ name: "support-intake" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, agentId, routineId: created.routine.id, eventType: "routine_definition.create" }),
      expect.stringContaining("audit"),
    );
  });

  it("validates a tool step that names a skill the agent's catalog carries", async () => {
    const { service } = createService({
      skillAuthoringCatalog: {
        listForAgent: vi.fn(async () => [skillDescriptor("account.lookup")]),
        getForAgent: vi.fn(),
      },
    });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("reports a tool step that references a skill outside the agent catalog", async () => {
    const catalog = {
      listForAgent: vi.fn(async () => [skillDescriptor("billing.lookup")]),
      getForAgent: vi.fn(),
    };
    const { service } = createService({ skillAuthoringCatalog: catalog });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "unknown_skill",
        location: "step:step_lookup",
      })],
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

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation.diagnostics.find((diagnostic) => diagnostic.code === "unknown_skill")).toBeUndefined();
    expect(additionalRoutineSkillNames).toHaveBeenCalledWith({ workspaceId, agentId });
  });

  it("passes skill descriptors into serving validation for typed required inputs", async () => {
    const catalog = {
      listForAgent: vi.fn(async () => [{
        ...skillDescriptor("account.lookup"),
        inputs: [{ key: "accountId", type: "text", required: true }],
      } satisfies SkillAuthoringDescriptor]),
      getForAgent: vi.fn(),
    };
    const { service } = createService({ skillAuthoringCatalog: catalog });
    const draft = await service.createDraft(workspaceId, agentId, toolDraft());

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "unsatisfiable_required_input",
        location: "step:step_lookup.inputBindings.accountId",
      }),
    ]));
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

  it("validates many routines with one resolution of the workspace-scoped skill and context-variable state", async () => {
    // Item 8: createCandidate/publish/import each validate every enabled routine belonging to one
    // agent in a single call; the skill catalog, additional skill names, and context variables are
    // agent-invariant across that batch, so they must be resolved once, not once per routine.
    const catalog = {
      listForAgent: vi.fn(async () => [skillDescriptor("account.lookup")]),
      getForAgent: vi.fn(),
    };
    const contextVariableReader = { listByAgent: vi.fn(async () => []) };
    const { service } = createService({ skillAuthoringCatalog: catalog, contextVariableReader });

    const plain = await service.createDraft(workspaceId, agentId, { ...validDraft(), name: "routine-plain" });
    const knownSkill = await service.createDraft(workspaceId, agentId, { ...toolDraft(), name: "routine-known-skill" });
    const unknownSkill = await service.createDraft(workspaceId, agentId, {
      ...toolDraft(),
      name: "routine-unknown-skill",
      steps: toolDraft().steps.map((step) => step.stableStepId === "step_lookup" ? { ...step, toolRef: "unknown.tool" } : step),
    });
    catalog.listForAgent.mockClear();
    contextVariableReader.listByAgent.mockClear();

    const results = await service.validateManyForServing(workspaceId, [
      plain.routine, knownSkill.routine, unknownSkill.routine,
    ]);

    expect(catalog.listForAgent).toHaveBeenCalledTimes(1);
    expect(contextVariableReader.listByAgent).toHaveBeenCalledTimes(1);
    expect(results.get(plain.routine.id)).toMatchObject({ ok: true, diagnostics: [] });
    expect(results.get(knownSkill.routine.id)).toMatchObject({ ok: true, diagnostics: [] });
    expect(results.get(unknownSkill.routine.id)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "unknown_skill", location: "step:step_lookup" })],
    });
  });

  it("returns the same per-routine diagnostics validateManyForServing produces as calling validateForServing once per routine would", async () => {
    const catalog = { listForAgent: vi.fn(async () => [skillDescriptor("account.lookup")]), getForAgent: vi.fn() };
    const { service } = createService({ skillAuthoringCatalog: catalog });
    const a = await service.createDraft(workspaceId, agentId, { ...validDraft(), name: "routine-a" });
    const b = await service.createDraft(workspaceId, agentId, { ...toolDraft(), name: "routine-b" });

    const individually = new Map([
      [a.routine.id, await service.validateForServing(workspaceId, a.routine)],
      [b.routine.id, await service.validateForServing(workspaceId, b.routine)],
    ]);
    const batched = await service.validateManyForServing(workspaceId, [a.routine, b.routine]);

    expect(batched).toEqual(individually);
  });

  it("still authorizes actions and checks webhook destinations per routine inside a batch", async () => {
    const actionCapabilities = new FakeActionCapabilityMap(new Map([["contact.send", ["contact.send"]]]));
    const capabilityPolicy = new FakeCapabilityPolicy(new Set(["contact.send"]));
    const { service } = createService({ actionCapabilities, capabilityPolicy, knownWebhookDestinations: new Set([knownDestinationId]) });
    const deniedAction = await service.createDraft(workspaceId, agentId, { ...actionDraft("contact.send"), name: "routine-action" });
    const knownWebhook = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      name: "routine-webhook",
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: knownDestinationId },
    });

    const results = await service.validateManyForServing(workspaceId, [deniedAction.routine, knownWebhook.routine]);

    expect(results.get(deniedAction.routine.id)?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "action_capability_denied" })]),
    );
    expect(results.get(knownWebhook.routine.id)).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("resolves an empty map without touching the workspace-scoped catalog for an empty batch", async () => {
    const catalog = { listForAgent: vi.fn(async () => []), getForAgent: vi.fn() };
    const { service } = createService({ skillAuthoringCatalog: catalog });

    const results = await service.validateManyForServing(workspaceId, []);

    expect(results).toEqual(new Map());
    expect(catalog.listForAgent).not.toHaveBeenCalled();
  });

  it("rejects a batch mixing routines that belong to different agents", async () => {
    const { service } = createService();
    const a = await service.createDraft(workspaceId, agentId, { ...validDraft(), name: "routine-a" });
    const fromAnotherAgent = { ...a.routine, id: randomUUID(), agentId: randomUUID() };

    await expect(service.validateManyForServing(workspaceId, [a.routine, fromAnotherAgent]))
      .rejects.toThrow(/same agent/);
  });

  it("reports an action step with no follow-up", async () => {
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

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_action_follow_up",
          location: "step:step_send",
        }),
      ]),
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("reports an action step without an action type", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, actionDraft(null));

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "dangling_action_reference",
          location: "step:step_send",
        }),
      ],
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("reports an action step whose capability the workspace denies", async () => {
    const { repository, service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      capabilityPolicy: new FakeCapabilityPolicy(new Set([capabilityNames.humanContact.request])),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("contact.send"));

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "action_capability_denied",
          location: "step:step_send",
        }),
      ],
    });
    expect(validation.diagnostics[0]?.message).toContain("contact.send");
    expect(validation.diagnostics[0]?.message).toContain(capabilityNames.humanContact.request);
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("reports an action step for an unregistered action type", async () => {
    // Validation that clears a routine and then fails at serving time is worse than no
    // validation: it is what a copilot builds a "ready to go live" proposal on.
    const { service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map()),
      capabilityPolicy: new FakeCapabilityPolicy(),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("unknown.send"));

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "unregistered_action_type",
          location: "step:step_send",
        }),
      ],
    });
    expect(validation.diagnostics[0]?.message).toContain("unknown.send");
  });

  it("clears an action step when the workspace has the required capability", async () => {
    const { service } = createService({
      actionCapabilities: new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      capabilityPolicy: new FakeCapabilityPolicy(),
    });
    const draft = await service.createDraft(workspaceId, agentId, actionDraft("contact.send"));

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({ ok: true, diagnostics: [] });
    expect(draft.routine.enabled).toBe(true);
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

  it("reports an enabled completion export with a malformed destination ref", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "missing-destination",
      },
    });

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_webhook_destination_ref",
          location: "completionExport.destinationRef",
          message: expect.stringContaining("missing-destination"),
        }),
      ],
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("reports an enabled completion export that references an unknown destination UUID", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: missingDestinationId,
      },
    });

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "unknown_webhook_destination",
          location: "completionExport.destinationRef",
          message: expect.stringContaining(missingDestinationId),
        }),
      ],
    });
    expect(await repository.listByAgent(agentId)).toHaveLength(1);
  });

  it("clears an enabled completion export that references a workspace destination", async () => {
    const { service } = createService({ knownWebhookDestinations: new Set([knownDestinationId]) });
    const draft = await service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete", "handoff"],
        destinationRef: knownDestinationId,
      },
    });

    const validation = await service.validate(workspaceId, agentId, { id: draft.routine.id });

    expect(validation).toMatchObject({ ok: true, diagnostics: [] });
    expect(draft.routine).toMatchObject({
      enabled: true,
      completionExport: {
        enabled: true,
        triggerKinds: ["complete", "handoff"],
        destinationRef: knownDestinationId,
      },
    });
  });

  it("turns a destination the database refuses on create into an author-facing bad request", async () => {
    // A routine serves as soon as its agent's draft is released, so the completion-export
    // foreign key can fail under a concurrent destination delete. Report it as a diagnostic.
    const { repository, service } = createService({ knownWebhookDestinations: new Set([knownDestinationId]) });
    repository.createDraftError = Object.assign(
      new Error("insert or update on table \"routine_definition\" violates foreign key constraint"),
      {
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      },
    );

    await expect(service.createDraft(workspaceId, agentId, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: knownDestinationId,
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
      message: expect.stringContaining(knownDestinationId),
      details: {
        ok: false,
        diagnostics: [expect.objectContaining({
          code: "unknown_webhook_destination",
          location: "completionExport.destinationRef",
        })],
      },
    });
  });

  it("turns a destination the database refuses on update into an author-facing bad request", async () => {
    const { repository, service } = createService({ knownWebhookDestinations: new Set([knownDestinationId]) });
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    repository.updateDraftError = Object.assign(
      new Error("insert or update on table \"routine_definition\" violates foreign key constraint"),
      {
        code: "23503",
        constraint: "routine_completion_export_destination_ref_published_fk",
      },
    );

    await expect(service.updateDraft(workspaceId, agentId, draft.routine.id, {
      ...validDraft(),
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: missingDestinationId,
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
      message: expect.stringContaining(missingDestinationId),
      details: {
        ok: false,
        diagnostics: [expect.objectContaining({
          code: "unknown_webhook_destination",
          location: "completionExport.destinationRef",
        })],
      },
    });
  });

  it("reports a stale guarded draft delete as a conflict instead of not found", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    repository.deleteDraft = async () => ({ outcome: "conflict" });

    await expect(service.deleteDraft(workspaceId, agentId, draft.routine.id, {
      expectedUpdatedAt: draft.routine.updatedAt,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    });
  });

  it("maps a draft save the repository refused to an author-facing conflict", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    // Simulate the repository's zero-row guard: the caller stated a version the row no longer holds.
    repository.updateDraft = async (_agentId: string, id: string) => {
      throw new Error(`routine_definition_update_conflict:${id}`);
    };

    await expect(service.updateDraft(workspaceId, agentId, draft.routine.id, validDraft()))
      .rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("changed while it was being edited"),
      });
  });

  it("states the version a caller decided against, so the write cannot land on newer content", async () => {
    // The copilot reads a routine, drafts an edit against it, and applies later. Checking the
    // version in application code leaves a window; the repository has to enforce it.
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    const expectedUpdatedAt = draft.routine.updatedAt;
    const updateDraft = vi.fn(repository.updateDraft.bind(repository));
    repository.updateDraft = updateDraft;

    await service.updateDraft(workspaceId, agentId, draft.routine.id, validDraft(), { expectedUpdatedAt });

    expect(updateDraft).toHaveBeenCalledWith(agentId, draft.routine.id, expect.anything(), { expectedUpdatedAt });
  });

  it("rejects a stale guarded draft save without overwriting the newer fake-repository state", async () => {
    const { repository, service } = createService();
    const draft = await service.createDraft(workspaceId, agentId, validDraft());
    repository.items.set(draft.routine.id, {
      ...draft.routine,
      name: "Saved by another author",
      updatedAt: new Date(draft.routine.updatedAt.getTime() + 1),
    });

    await expect(service.updateDraft(workspaceId, agentId, draft.routine.id, validDraft(), {
      expectedUpdatedAt: draft.routine.updatedAt,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: expect.stringContaining("changed while it was being edited"),
    });
    expect((await repository.findById(agentId, draft.routine.id))?.name).toBe("Saved by another author");
  });
});
