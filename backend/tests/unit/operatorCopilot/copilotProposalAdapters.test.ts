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
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository });

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
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository });

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
    const adapter = createContextVariableCopilotProposalAdapter({ agentService, contextVariableRepository });

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
});

const makeSkillsHarness = () => {
  const repository = new InMemoryAgentSkillRepository();
  const agentSkillsService = new AgentSkillsService({
    repository,
    capabilities: createDefaultSkillCapabilityRegistry(),
  });
  const agentService = makeAgentService();
  const adapter = createAgentSkillCopilotProposalAdapter({
    agentService,
    agentSkillsService,
    skillCapabilityRegistry: createDefaultSkillCapabilityRegistry(),
  });
  return { agentSkillsService, adapter };
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
});
