import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ContextVariableService,
  type AgentContextVariableEnablement,
  type AgentContextVariableEnablementRecord,
  type ContextVariable,
  type ContextVariableRepositoryPort,
} from "../../../src/modules/context-variables/public.js";
import { createContextVariableCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/contextVariableProposalAdapter.js";
import { createContextVariableReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/contextVariableReviewedPreparation.js";

const workspaceId = randomUUID();
const agentId = randomUUID();
const otherAgentId = randomUUID();
const context = { workspaceId, accountId: randomUUID(), operatorUserId: randomUUID(), surface: "mcp" as const, operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: randomUUID(), operatorMcpClientId: randomUUID(), currentAuthorization: { hasAllPermissions: vi.fn(async () => true) }, pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] } };

const options = [
  { key: "billing", label: "Billing", description: "Invoices and refunds.", archived: false },
  { key: "shipping", label: "Shipping", description: null, archived: false },
];

const choice = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: randomUUID(), workspaceId, name: "topic", description: "What the visitor needs.", valueType: "enum", options,
  trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
  createdAt: new Date("2026-11-22T09:00:00.000Z"), updatedAt: new Date("2026-11-22T09:00:00.000Z"), ...overrides,
});

const fixture = (seed: ContextVariable[] = [], seedEnablements: AgentContextVariableEnablement[] = []) => {
  const variables = new Map(seed.map((variable) => [variable.id, variable]));
  const enablements = [...seedEnablements];
  const repository = {
    get: vi.fn(async (_workspaceId: string, id: string) => variables.get(id) ?? null),
    listByWorkspace: vi.fn(async () => [...variables.values()]),
    listByAgent: vi.fn(async (_workspaceId: string, id: string) => enablements.filter((enablement) => enablement.agentId === id).map((enablement) => ({ ...enablement, variable: variables.get(enablement.variableId) }))),
    hasValues: vi.fn(async () => false),
    classifiedEnablementAgentIds: vi.fn(async (id: string) => enablements.filter((enablement) => enablement.variableId === id && enablement.source === "classified").map((enablement) => enablement.agentId)),
    applyProposal: vi.fn(),
  };
  const contextVariables = new ContextVariableService({
    repository: repository as unknown as ContextVariableRepositoryPort,
    agentReader: { get: async (_workspaceId, id) => (id === agentId || id === otherAgentId ? { id } : null) },
    agentSkillsReader: { list: async () => [] },
  });
  const proposalRepository = { createProposal: vi.fn(async (input: Record<string, unknown>) => ({ id: randomUUID(), ...input })) };
  const listContextVariableUsers = vi.fn(async (input: { variableId: string }) => ({
    users: [
      { agentId, agentName: "Support", uses: "both" as const },
      { agentId: otherAgentId, agentName: "Sales", uses: "published" as const },
    ].filter(() => enablements.some((enablement) => enablement.variableId === input.variableId)),
    truncated: false,
  }));
  const deps = {
    proposalRepository, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() },
    proposalAdapters: [createContextVariableCopilotProposalAdapter({ contextVariables })],
    // The agents module answers who uses a variable, from each agent's draft and published release.
    contextVariableUsers: { listContextVariableUsers },
    contextVariables,
    now: () => new Date("2026-11-22T10:00:00.000Z"), appBaseUrl: "https://app.example",
  };
  const tool = createContextVariableReviewedPreparationTool(deps as never).createTool(context);
  const invoke = (input: Record<string, unknown>) => tool.invoke(input as never, {} as never) as Promise<{
    review: Record<string, unknown>;
    confirmation: { requirement: string; effect: { exposure: string }; approvalUrl?: string };
  }>;
  return { invoke, proposalRepository, repository, listContextVariableUsers };
};

const enablementOf = (variableId: string, overrides: Partial<AgentContextVariableEnablementRecord & AgentContextVariableEnablement> = {}): AgentContextVariableEnablement => ({
  id: randomUUID(), agentId, variableId, source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
  surfacing: "on_reference", enabled: true, createdAt: new Date("2026-11-22T08:00:00.000Z"), updatedAt: new Date("2026-11-22T08:00:00.000Z"), ...overrides,
});

const createInput = {
  kind: "create", agentId, name: "topic", description: "What the visitor needs.", valueType: "enum", options: [
    { key: "billing", label: "Billing", description: "Invoices and refunds." },
    { key: "shipping", label: "Shipping" },
  ], trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
};

describe("reviewed context-variable preparation", () => {
  it("prepares a new Choice attribute as a live definition the operator approves signed in", async () => {
    const { invoke, proposalRepository } = fixture();

    const output = await invoke(createInput);

    expect(output.review).toMatchObject({
      kind: "create",
      target: { agentId, variableId: null, name: "topic" },
      definition: { before: null, after: { name: "topic", valueType: "enum", options: [expect.objectContaining({ key: "billing" }), expect.objectContaining({ key: "shipping" })] }, lifecycle: "live", usedBy: [], usedByTruncated: false },
      enablement: null,
      publicationRequired: false,
    });
    expect(output.confirmation).toMatchObject({ requirement: "signed_in_approval", effect: { exposure: "live" } });
    expect(output.confirmation.approvalUrl).toMatch(/^https:\/\/app\.example\/oauth\/operator-mcp\/proposal\//u);
    expect(proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "context_variable",
      targetRef: { agentId, variableId: null, includesDefinition: true, includesEnablement: false },
      reviewDigest: expect.any(String),
      expiresAt: new Date("2026-11-22T10:15:00.000Z"),
    }));
  });

  it("states a create with this agent's enablement as a live definition plus a draft that needs publication", async () => {
    const { invoke } = fixture();

    const output = await invoke({ ...createInput, enablement: { source: "classified", surfacing: "on_reference" } });

    expect(output.review).toMatchObject({
      definition: { lifecycle: "live" },
      enablement: { before: null, after: { source: "classified", surfacing: "on_reference", enabled: true }, lifecycle: "agent_draft" },
      publicationRequired: true,
    });
    expect(output.confirmation.requirement).toBe("signed_in_approval");
  });

  it("prepares an edit with what it was before and every agent that uses it, by its draft, its published release or both", async () => {
    const topic = choice();
    const { invoke, listContextVariableUsers } = fixture([topic], [enablementOf(topic.id)]);

    const output = await invoke({ kind: "edit", agentId, variableId: topic.id, description: "The visitor's reason for writing." });

    expect(listContextVariableUsers).toHaveBeenCalledOnce();
    expect(listContextVariableUsers).toHaveBeenCalledWith({ workspaceId, variableId: topic.id, limit: 25 });

    expect(output.review).toMatchObject({
      kind: "edit",
      target: { agentId, variableId: topic.id, name: "topic" },
      definition: {
        before: { description: "What the visitor needs." },
        after: { description: "The visitor's reason for writing." },
        lifecycle: "live",
        usedBy: [{ agentId, agentName: "Support", uses: "both" }, { agentId: otherAgentId, agentName: "Sales", uses: "published" }],
      },
      enablement: null,
      publicationRequired: false,
    });
  });

  it("prepares one agent's enablement as a draft change confirmed in the conversation, as a directive's is", async () => {
    const topic = choice();
    const { invoke, proposalRepository } = fixture([topic], [enablementOf(topic.id)]);

    const output = await invoke({ kind: "set_enablement", agentId, variableId: topic.id, enablement: { source: "classified", surfacing: "on_reference" } });

    expect(output.review).toMatchObject({
      kind: "set_enablement",
      definition: null,
      enablement: { before: { source: "pushed" }, after: { source: "classified", surfacing: "on_reference" }, lifecycle: "agent_draft" },
      publicationRequired: true,
    });
    expect(output.confirmation).toMatchObject({ requirement: "conversation", effect: { exposure: "draft" } });
    expect(proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetRef: { agentId, variableId: topic.id, includesDefinition: false, includesEnablement: true },
    }));
  });

  it.each([
    ["a Text attribute", { valueType: "string" as const, options: null }, /Only a Choice \(enum\) attribute/u],
    ["a Private attribute", { sensitivity: "sensitive" as const }, /Private \(sensitive\)/u],
    ["an attribute treated as proof", { trustTier: "signed" as const }, /proof \(signed\)/u],
  ])("refuses to prepare classification of %s, with the reason", async (_label, overrides, reason) => {
    const variable = choice(overrides);
    const { invoke, proposalRepository } = fixture([variable]);

    await expect(invoke({ kind: "set_enablement", agentId, variableId: variable.id, enablement: { source: "classified", surfacing: "on_reference" } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(reason) });
    expect(proposalRepository.createProposal).not.toHaveBeenCalled();
  });

  it("refuses a ninth classified attribute and a type change on an attribute with values", async () => {
    const seeded = Array.from({ length: 9 }, (_, index) => choice({ name: `topic_${index}` }));
    const { invoke, repository } = fixture(seeded, seeded.slice(0, 8).map((variable) => enablementOf(variable.id, { source: "classified" })));

    await expect(invoke({ kind: "set_enablement", agentId, variableId: seeded[8].id, enablement: { source: "classified", surfacing: "on_reference" } }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/at most 8/u) });

    repository.hasValues.mockResolvedValue(true);
    await expect(invoke({ kind: "edit", agentId, variableId: seeded[8].id, valueType: "string", options: null }))
      .rejects.toMatchObject({ statusCode: 409, code: "context_variable_has_values" });
  });

  it("refuses fields that do not belong to the kind", async () => {
    const topic = choice();
    const { invoke } = fixture([topic]);

    await expect(invoke({ kind: "create", agentId, variableId: topic.id, name: "topic" })).rejects.toThrow(/variableId/u);
    await expect(invoke({ kind: "edit", agentId, name: "topic" })).rejects.toThrow(/variableId/u);
    await expect(invoke({ kind: "edit", agentId, variableId: topic.id, enablement: { source: "pushed", surfacing: "always" } })).rejects.toThrow(/enablement/u);
    await expect(invoke({ kind: "set_enablement", agentId, variableId: topic.id })).rejects.toThrow(/enablement/u);
    await expect(invoke({ kind: "set_enablement", agentId, variableId: topic.id, name: "renamed", enablement: { source: "pushed", surfacing: "always" } })).rejects.toThrow(/name/u);
  });
});
