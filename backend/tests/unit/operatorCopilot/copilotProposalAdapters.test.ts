import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createAgentSkillCopilotProposalAdapter,
  createContextVariableCopilotProposalAdapter,
} from "../../../src/app/composition/copilotProposalAdapters.js";
import { AgentSkillsService } from "../../../src/modules/agentSkills/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../../src/modules/skills/public.js";
import { badRequest, conflict, notFound } from "../../../src/shared/domain/errors.js";
import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";
import type { AgentContextVariableEnablement, ContextVariable } from "../../../src/modules/context-variables/public.js";
import type { AgentContextVariableEnablementRecord, ApplyContextVariableProposalInput, ApplyContextVariableProposalResult } from "../../../src/db/repositories/contextVariableRepository.js";

// Minimal stand-in for AgentService.get: throws not-found for any agent id the caller never
// registered as belonging to the given workspace, matching how the real service resolves an
// agent through agentRepository.findByIdAndWorkspaceId.
const makeAgentService = (agentsByWorkspace: Record<string, string[]> = {}) => ({
  get: vi.fn(async (workspaceId: string, agentId: string) => {
    if (!(agentsByWorkspace[workspaceId] ?? []).includes(agentId)) {
      throw notFound("Agent not found");
    }
    return { id: agentId, updatedAt: new Date("2026-01-01T00:00:00.000Z") } as never;
  }),
});

// Minimal stand-in for AgentSkillsService.list, scoped to whichever ids this test registers as
// belonging to the agent - used to validate a resolver enablement's resolverSkillId.
const makeAgentSkillsPort = (skillIds: string[] = []) => ({
  list: vi.fn(async () => skillIds.map((id) => ({ id }))) as never,
});

const makeContextVariableRepository = (seedVariables: ContextVariable[] = []) => {
  const variables = new Map(seedVariables.map((variable) => [variable.id, variable]));
  const enablements = new Map<string, AgentContextVariableEnablement>();

  const upsertEnablement = (input: AgentContextVariableEnablementRecord): AgentContextVariableEnablement => {
    const key = `${input.agentId}:${input.variableId}`;
    const existing = enablements.get(key);
    const now = new Date();
    const enablement: AgentContextVariableEnablement = {
      id: existing?.id ?? randomUUID(),
      agentId: input.agentId,
      variableId: input.variableId,
      source: input.source,
      resolverSkillId: input.resolverSkillId ?? null,
      maxAgeSeconds: input.maxAgeSeconds ?? null,
      resolverTimeoutMs: input.resolverTimeoutMs ?? null,
      surfacing: input.surfacing,
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    enablements.set(key, enablement);
    return enablement;
  };

  return {
    get: vi.fn(async (workspaceId: string, id: string): Promise<ContextVariable | null> => {
      const variable = variables.get(id);
      return variable && variable.workspaceId === workspaceId ? variable : null;
    }),
    listByWorkspace: vi.fn(async (workspaceId: string): Promise<ContextVariable[]> =>
      [...variables.values()].filter((variable) => variable.workspaceId === workspaceId)),
    listByAgent: vi.fn(async (_workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]> =>
      [...enablements.values()].filter((enablement) => enablement.agentId === agentId)),
    upsertEnablement: vi.fn(async (input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement> => upsertEnablement(input)),
    // In-memory analogue of the real repository's transaction: both version guards are checked
    // before either write is applied, so a failing guard never leaves a partial write behind.
    applyProposal: vi.fn(async (input: ApplyContextVariableProposalInput): Promise<ApplyContextVariableProposalResult> => {
      let variableId = input.variableId;

      if (input.definition && variableId) {
        const current = variables.get(variableId);
        if (!current || current.workspaceId !== input.workspaceId) {
          throw conflict("Context variable was updated by another writer; reload before saving again");
        }
        if (input.expectedVariableUpdatedAt && current.updatedAt.getTime() !== input.expectedVariableUpdatedAt.getTime()) {
          throw conflict("Context variable was updated by another writer; reload before saving again");
        }
      }

      if (input.enablement && variableId) {
        const existing = enablements.get(`${input.agentId}:${variableId}`);
        if (input.expectedEnablementUpdatedAt === null) {
          if (existing) throw conflict("Context variable enablement was updated by another writer; reload before saving again");
        } else if (!existing || existing.updatedAt.getTime() !== input.expectedEnablementUpdatedAt.getTime()) {
          throw conflict("Context variable enablement was updated by another writer; reload before saving again");
        }
      }

      if (input.definition) {
        if (variableId) {
          const current = variables.get(variableId)!;
          variables.set(variableId, { ...current, ...input.definition, updatedAt: new Date() });
        } else {
          const created: ContextVariable = {
            id: randomUUID(),
            workspaceId: input.workspaceId,
            ...input.definition,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          variables.set(created.id, created);
          variableId = created.id;
        }
      }

      if (input.enablement) {
        if (!variableId) throw badRequest("Cannot enable a context variable with no resolved id");
        upsertEnablement({ agentId: input.agentId, variableId, ...input.enablement });
      }

      if (!variableId) throw badRequest("A context variable proposal must include a definition or target an existing variable");
      return { variableId };
    }),
  };
};

const makeVariable = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  name: "loyalty_tier",
  description: null,
  valueType: "string",
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("createContextVariableCopilotProposalAdapter", () => {
  it("rejects readVersionToken for an agent id that does not belong to the workspace, even when targeting an existing variable", async () => {
    const workspaceId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({}); // no agent registered anywhere
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const foreignAgentId = randomUUID();
    await expect(
      adapter.readVersionToken(workspaceId, { agentId: foreignAgentId, variableId: variable.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(agentService.get).toHaveBeenCalledWith(workspaceId, foreignAgentId);
  });

  it("rejects validatePayload for an agent id that does not belong to the workspace", async () => {
    const workspaceId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({}); // no agent registered anywhere
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const foreignAgentId = randomUUID();
    await expect(
      adapter.validatePayload(workspaceId, { agentId: foreignAgentId, variableId: variable.id }, {
        enablement: { source: "pushed", surfacing: "on_reference" },
        rationale: "Enable for this agent",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("never writes an enablement for an unresolved agent id, even when the caller supplies a token that matches the underlying variable", async () => {
    const workspaceId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({}); // no agent registered anywhere - variable exists, agent does not
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const foreignAgentId = randomUUID();
    const targetRef = { agentId: foreignAgentId, variableId: variable.id };
    // A token derived purely from the variable's own updatedAt (no enablement segment) - what
    // the pre-fix adapter would have returned from readCurrentToken without ever looking at the
    // agent.
    const forgedToken = `${variable.updatedAt.toISOString()}|`;

    const outcome = await adapter.applyIfVersionMatches(workspaceId, targetRef, {
      name: variable.name,
      definition: null,
      enablement: { source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference", enabled: true },
    }, forgedToken);

    expect(outcome.outcome).not.toBe("applied");
    expect(contextVariableRepository.applyProposal).not.toHaveBeenCalled();
  });

  it("derives the version token from the same read used to expand a partial definition patch, not a second, later one", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const targetRef = { agentId, variableId: variable.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, { sensitivity: "sensitive" });

    // A follow-up read (e.g. the old code's separate readVersionToken call) would see whatever a
    // concurrent write landed in between; a single read cannot.
    expect(contextVariableRepository.get).toHaveBeenCalledTimes(1);
    expect(validated.versionToken).toBe(`${variable.updatedAt.toISOString()}|`);
  });

  it("previews only what a definition-only proposal changes, leaving its untouched enablement identical on both sides of the diff", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    // The sibling value a definition-only proposal must not appear to remove.
    await contextVariableRepository.upsertEnablement({ agentId, variableId: variable.id, source: "pushed", surfacing: "on_reference", enabled: true });

    const targetRef = { agentId, variableId: variable.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, { sensitivity: "sensitive" });
    const preview = await adapter.preview(workspaceId, validated.targetRef, validated.payload) as {
      current: { definition: Record<string, unknown> | null; enablement: Record<string, unknown> | null };
      proposed: { definition: Record<string, unknown> | null; enablement: Record<string, unknown> | null };
    };

    expect(preview.proposed.definition).toMatchObject({ sensitivity: "sensitive" });
    expect(preview.current.definition).toMatchObject({ sensitivity: "normal" });
    // The enablement side is untouched by this proposal - `null` here (the stored payload's
    // literal value for "not part of this proposal") would render as a removal next to the real
    // current value, so the preview must echo the current value forward instead.
    expect(preview.current.enablement).not.toBeNull();
    expect(preview.proposed.enablement).toEqual(preview.current.enablement);
    // Neither side carries identity/audit columns the payload never had.
    expect(preview.current.definition).not.toHaveProperty("id");
    expect(preview.current.definition).not.toHaveProperty("updatedAt");
    expect(preview.current.enablement).not.toHaveProperty("id");
    expect(preview.current.enablement).not.toHaveProperty("variableId");
  });

  it("agrees with Apply about staleness: a definition-only proposal is not reported stale by an unrelated enablement edit that lands after it", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variable = makeVariable({ workspaceId });
    const contextVariableRepository = makeContextVariableRepository([variable]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const targetRef = { agentId, variableId: variable.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, { sensitivity: "sensitive" });

    // An enablement edit unrelated to this proposal lands after it was drafted.
    await contextVariableRepository.upsertEnablement({ agentId, variableId: variable.id, source: "pushed", surfacing: "on_reference", enabled: true });

    // What getProposal shows before Apply is even attempted must match what Apply itself decides.
    const currentToken = await adapter.readVersionToken(workspaceId, validated.targetRef);
    expect(currentToken).toBe(validated.versionToken);

    const outcome = await adapter.applyIfVersionMatches(workspaceId, targetRef, validated.payload, validated.versionToken);
    expect(outcome.outcome).toBe("applied");
  });

  it("resolves a resolver enablement's skill through this agent, accepting one that belongs to it", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const skillId = randomUUID();
    const contextVariableRepository = makeContextVariableRepository([]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort([skillId]) });

    const validated = await adapter.validatePayload(workspaceId, { agentId, variableId: null }, {
      name: "loyalty_tier", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
      enablement: { source: "resolver", resolverSkillId: skillId, surfacing: "operator_only" },
    });

    expect((validated.payload as { enablement: { resolverSkillId: string } }).enablement.resolverSkillId).toBe(skillId);
  });

  it("refuses a resolver enablement naming a skill id that does not exist for this agent", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const foreignSkillId = randomUUID();
    const contextVariableRepository = makeContextVariableRepository([]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    // Nothing registered for this agent - a hallucinated id, or one that belongs to a different
    // agent or workspace, looks identical from here.
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort([]) });

    await expect(adapter.validatePayload(workspaceId, { agentId, variableId: null }, {
      name: "loyalty_tier", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
      enablement: { source: "resolver", resolverSkillId: foreignSkillId, surfacing: "operator_only" },
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("does not report a create proposal stale after an unrelated agent edit, but does once a same-named variable now exists", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const contextVariableRepository = makeContextVariableRepository([]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const targetRef = { agentId, variableId: null };
    const validated = await adapter.validatePayload(workspaceId, targetRef, {
      name: "loyalty_tier", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
    });

    // applyProposal's create branch never gates on the agent's updatedAt - only the
    // workspace+name uniqueness constraint decides whether Apply would still succeed - so an
    // unrelated agent edit landing between draft and this GET-time recompute must not flip a
    // legitimate create stale.
    agentService.get.mockResolvedValueOnce({ id: agentId, updatedAt: new Date("2030-01-01T00:00:00.000Z") } as never);
    expect(await adapter.readVersionToken(workspaceId, validated.targetRef, validated.payload)).toBe(validated.versionToken);

    // Someone else creates a variable with the exact name this proposal would take - the one
    // thing that would actually make Apply's own insert reject it.
    await contextVariableRepository.applyProposal({
      workspaceId,
      agentId,
      variableId: null,
      definition: { name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
      expectedVariableUpdatedAt: null,
      enablement: null,
      expectedEnablementUpdatedAt: null,
    });

    expect(await adapter.readVersionToken(workspaceId, validated.targetRef, validated.payload)).not.toBe(validated.versionToken);
  });

  // Finding 2 (P2, next-ray-epic-issue review): a create proposal drafted while another variable
  // already holds the proposed name can never apply - applyProposal's own workspace+name
  // uniqueness constraint always rejects it. Before this fix, resolveProposal only recorded the
  // blocker in the stored `blocked:...` version token (the same mechanism the prior "does not
  // report a create proposal stale..." test exercises for a blocker that appears *after* drafting),
  // so the card read as current and Apply always failed. Refusing at draft time here is the single
  // place that stops an unapplyable create proposal from ever being minted.
  it("refuses to draft a create proposal for a context variable whose name already exists, rather than minting a proposal Apply can never satisfy", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const existingVariable = makeVariable({ workspaceId, name: "loyalty_tier" });
    const contextVariableRepository = makeContextVariableRepository([existingVariable]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    await expect(
      adapter.validatePayload(workspaceId, { agentId, variableId: null }, {
        name: "loyalty_tier", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // Finding 3 (P2, next-ray-epic-issue review) draft-time half: renaming an existing variable onto
  // another variable's name can never apply either - applyProposal's update branch hits the same
  // workspace+name constraint. Before this fix there was no name check on the update path at all,
  // so this drafted cleanly and only failed (with a raw persistence error - see the paired
  // integration test) once Apply ran.
  it("refuses to draft a rename proposal for an existing context variable onto another variable's name, rather than minting a proposal Apply can never satisfy", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variableA = makeVariable({ workspaceId, name: "loyalty_tier" });
    const variableB = makeVariable({ workspaceId, name: "cart_total" });
    const contextVariableRepository = makeContextVariableRepository([variableA, variableB]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    await expect(
      adapter.validatePayload(workspaceId, { agentId, variableId: variableA.id }, { name: "cart_total" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("still allows renaming an existing context variable to a name nothing else holds", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variableA = makeVariable({ workspaceId, name: "loyalty_tier" });
    const contextVariableRepository = makeContextVariableRepository([variableA]);
    const agentService = makeAgentService({ [workspaceId]: [agentId] });
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository, agentSkillsService: makeAgentSkillsPort() });

    const validated = await adapter.validatePayload(workspaceId, { agentId, variableId: variableA.id }, { name: "tier_loyalty" });
    expect((validated.payload as { name: string }).name).toBe("tier_loyalty");
  });
});

const makeSkillsHarness = (agentsByWorkspace: Record<string, string[]> = {}) => {
  const repository = new InMemoryAgentSkillRepository();
  const agentSkillsService = new AgentSkillsService({
    repository,
    capabilities: createDefaultSkillCapabilityRegistry(),
  });
  const agentService = makeAgentService(agentsByWorkspace);
  const adapter = createAgentSkillCopilotProposalAdapter({
    agentService,
    agentSkillsService,
    skillCapabilityRegistry: createDefaultSkillCapabilityRegistry(),
  });
  return { agentSkillsService, adapter, agentService };
};

describe("createAgentSkillCopilotProposalAdapter", () => {
  it("rejects a proposal whose explicit target kind does not match the capability's own target kind", async () => {
    const { adapter } = makeSkillsHarness();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await expect(
      adapter.validatePayload(workspaceId, { agentId, skillId: null }, {
        name: "search_docs",
        capability: "retrieve",
        target: { kind: "webhook_destination", id: null },
        config: {},
        invocationMode: "routine_named",
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a second default_answer skill proposal for an agent that already has one", async () => {
    const { adapter, agentSkillsService } = makeSkillsHarness();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await agentSkillsService.create(workspaceId, agentId, {
      name: "primary_answer",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: {},
      invocationMode: "default_answer",
      enabled: true,
    });

    await expect(
      adapter.validatePayload(workspaceId, { agentId, skillId: null }, {
        name: "second_answer",
        capability: "retrieve",
        target: { kind: "source_scope", id: null },
        config: {},
        invocationMode: "default_answer",
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("preserves a stored notify webhook URL when a proposal patches only the recipient list", async () => {
    const { adapter, agentSkillsService } = makeSkillsHarness();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const existing = await agentSkillsService.create(workspaceId, agentId, {
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: {
        delivery: {
          recipientEmails: ["ops@example.com"],
          webhook: { url: "https://hooks.example.com/abc" },
        },
        exposedInputs: { message: true },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    const targetRef = { agentId, skillId: existing.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, {
      config: { delivery: { recipientEmails: ["ops2@example.com"] } },
      rationale: "Add a second recipient",
    });
    const payload = validated.payload as { config: { delivery: { recipientEmails: string[]; webhook: { url: string } | null } } };
    expect(payload.config.delivery.webhook).toEqual({ url: "https://hooks.example.com/abc" });
    expect(payload.config.delivery.recipientEmails).toEqual(["ops2@example.com"]);

    const token = await adapter.readVersionToken(workspaceId, validated.targetRef);
    const outcome = await adapter.applyIfVersionMatches(workspaceId, validated.targetRef, validated.payload, token);
    expect(outcome.outcome).toBe("applied");

    const persisted = (await agentSkillsService.list(workspaceId, agentId)).find((skill) => skill.id === existing.id);
    expect(persisted?.config.delivery).toEqual({
      recipientEmails: ["ops2@example.com"],
      webhook: { url: "https://hooks.example.com/abc" },
    });
  });

  it("derives the version token from the same read used to expand a partial config patch, not a second, later one", async () => {
    const { adapter, agentSkillsService } = makeSkillsHarness();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const existing = await agentSkillsService.create(workspaceId, agentId, {
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: { url: "https://hooks.example.com/abc" } }, exposedInputs: { message: true } },
      invocationMode: "routine_named",
      enabled: true,
    });

    // A follow-up read (e.g. the old code's separate readVersionToken call) would see whatever a
    // concurrent write landed in between; a single read cannot.
    const listSpy = vi.spyOn(agentSkillsService, "list");
    const targetRef = { agentId, skillId: existing.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, {
      config: { delivery: { recipientEmails: ["ops2@example.com"] } },
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(validated.versionToken).toBe(new Date(existing.updatedAt).toISOString());
  });

  it("projects the existing skill to the payload's own editable shape in a preview, so identity and audit fields never render as removed", async () => {
    const { adapter, agentSkillsService } = makeSkillsHarness();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const existing = await agentSkillsService.create(workspaceId, agentId, {
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null }, exposedInputs: { message: true } },
      invocationMode: "routine_named",
      enabled: true,
    });

    const targetRef = { agentId, skillId: existing.id };
    const validated = await adapter.validatePayload(workspaceId, targetRef, { config: { delivery: { recipientEmails: ["ops2@example.com"] } } });
    const preview = await adapter.preview(workspaceId, validated.targetRef, validated.payload) as { current: Record<string, unknown> | null };

    expect(preview.current).not.toBeNull();
    // The proposal payload never carries these columns, so a preview diff must not either -
    // otherwise they render as fields the proposal "removes" when it changes nothing about them.
    expect(preview.current).not.toHaveProperty("id");
    expect(preview.current).not.toHaveProperty("workspaceId");
    expect(preview.current).not.toHaveProperty("createdAt");
    expect(preview.current).not.toHaveProperty("updatedAt");
    expect(preview.current).not.toHaveProperty("storedKind");
    expect(preview.current).toMatchObject({ name: "notify_ops", capability: "notify", enabled: true });
  });

  it("does not report a create proposal stale after an unrelated agent edit, but does once a same-named skill now exists", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const { adapter, agentSkillsService, agentService } = makeSkillsHarness({ [workspaceId]: [agentId] });

    const targetRef = { agentId, skillId: null };
    const validated = await adapter.validatePayload(workspaceId, targetRef, {
      name: "faq_search",
      capability: "retrieve",
      config: {},
    });

    // create() never touches the agent row - only its own name/default-answer uniqueness checks
    // determine whether Apply would still succeed - so an unrelated agent edit (a directive
    // proposal, a setting change, ...) landing between draft and this GET-time recompute must not
    // flip a legitimate create stale.
    agentService.get.mockResolvedValueOnce({ id: agentId, updatedAt: new Date("2030-01-01T00:00:00.000Z") } as never);
    expect(await adapter.readVersionToken(workspaceId, validated.targetRef, validated.payload)).toBe(validated.versionToken);

    // Someone else creates a skill with the exact name this proposal would take - the one thing
    // that would actually make Apply's own create() reject it.
    await agentSkillsService.create(workspaceId, agentId, {
      name: "faq_search",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(await adapter.readVersionToken(workspaceId, validated.targetRef, validated.payload)).not.toBe(validated.versionToken);
  });

  // Finding 1 (P2, next-ray-epic-issue review): the mirror image of the "does not report a create
  // proposal stale..." test above. There, the blocker appears *after* the proposal is drafted, and
  // the create-staleness token correctly flags it. Here, a same-named skill already exists *at
  // draft time* - dryRunValidate never ran create()'s findByName check, so this used to draft
  // cleanly (minting a stable `blocked:...` token both now and at GET time, so the card read as
  // current) even though Apply's own uniqueness check must always reject it. Refusing at draft
  // time is the single place that stops an unapplyable create proposal from ever being minted.
  it("refuses to draft a create proposal for a skill whose name already exists, rather than minting a proposal Apply can never satisfy", async () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const { adapter, agentSkillsService } = makeSkillsHarness({ [workspaceId]: [agentId] });

    await agentSkillsService.create(workspaceId, agentId, {
      name: "faq_search",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });

    await expect(
      adapter.validatePayload(workspaceId, { agentId, skillId: null }, {
        name: "faq_search",
        capability: "retrieve",
        config: {},
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
