import { describe, expect, it, vi } from "vitest";

import {
  createContextVariableProposalCopilotTools,
  createContextVariablesCopilotTools,
} from "../../../src/modules/operatorCopilot/tools/contextVariables.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "agent" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

const contextVariablePorts = () => {
  const get = vi.fn(async (_workspaceId: string, agentId: string) => ({ id: agentId, name: "Support" }) as never);
  const listByWorkspace = vi.fn(async () => [
    {
      id: "variable-1",
      name: "loyalty_tier",
      description: "The customer's loyalty tier.",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    },
  ]);
  const listByAgent = vi.fn(async () => [
    {
      id: "enablement-1",
      variableId: "variable-1",
      source: "pushed",
      resolverSkillId: null,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "on_reference",
      enabled: true,
      variable: { name: "loyalty_tier" },
    },
  ]);
  return { get, listByWorkspace, listByAgent };
};

const unmeasured = () => ({
  proposalEvidence: {
    evidence: { record: vi.fn(), findMany: vi.fn(async () => []) },
    agentVersion: { get: vi.fn(async () => ({ updatedAt: new Date("2026-08-25T10:00:00.000Z") })) },
  },
});

describe("context_variables reader", () => {
  it("lists workspace variable definitions next to the resolved agent's enablements", async () => {
    const ports = contextVariablePorts();
    const [descriptor] = createContextVariablesCopilotTools({ agentService: { get: ports.get }, contextVariables: ports });

    const result = await descriptor!.createTool(context).invoke({}, {} as never) as {
      variables: Array<Record<string, unknown>>;
      enablements: Array<Record<string, unknown>>;
    };

    expect(ports.get).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(ports.listByWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(ports.listByAgent).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(result.variables).toEqual([
      { id: "variable-1", name: "loyalty_tier", description: "The customer's loyalty tier.", valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" },
    ]);
    expect(result.enablements).toEqual([
      { id: "enablement-1", variableId: "variable-1", variableName: "loyalty_tier", source: "pushed", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference", enabled: true },
    ]);
  });

  it("proves the agent belongs to the workspace before listing its enablements", async () => {
    const ports = contextVariablePorts();
    ports.get.mockRejectedValueOnce(new Error("Agent not found"));
    const [descriptor] = createContextVariablesCopilotTools({ agentService: { get: ports.get }, contextVariables: ports });

    await expect(descriptor!.createTool(context).invoke({ agentId: "agent-9" }, {} as never)).rejects.toThrow("Agent not found");

    expect(ports.get).toHaveBeenCalledWith("workspace-1", "agent-9");
    expect(ports.listByAgent).not.toHaveBeenCalled();
  });

  it("falls back to the page context agent and links the agent entity", async () => {
    const ports = contextVariablePorts();
    const [descriptor] = createContextVariablesCopilotTools({ agentService: { get: ports.get }, contextVariables: ports });

    await descriptor!.createTool(context).invoke({}, {} as never);

    expect(ports.listByAgent).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(descriptor!.describeEntity?.({}, context)).toEqual({ type: "agent", id: "agent-1" });
    expect(descriptor!.describeEntity?.({ agentId: "agent-7" }, context)).toEqual({ type: "agent", id: "agent-7" });
  });
});

describe("propose_context_variable", () => {
  const buildTools = (overrides: { adapter?: Record<string, unknown> } = {}) => {
    const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
      id: "proposal-1",
      ...input,
      messageId: null,
      status: "pending" as const,
      appliedRef: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const adapter = overrides.adapter ?? {
      targetType: "context_variable",
      readVersionToken: vi.fn(async () => "variable-version"),
      preview: vi.fn(),
      applyIfVersionMatches: vi.fn(),
      validatePayload: vi.fn(async (_workspaceId: string, targetRef: unknown, payload: unknown) => ({
        targetRef,
        payload: { name: "loyalty_tier", definition: { name: "loyalty_tier", description: null, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference" }, enablement: null, ...(payload as Record<string, unknown>) },
        versionToken: "variable-version",
      })),
    };
    const auditService = { record: vi.fn() };
    const descriptors = createContextVariableProposalCopilotTools({
      proposalRepository: { createProposal: createProposal as never },
      proposalAdapters: [adapter as never],
      auditService,
      ...unmeasured(),
    });
    return { descriptors, createProposal, adapter, auditService };
  };

  it("creates a pending proposal for a new variable definition", async () => {
    const { descriptors, createProposal, adapter } = buildTools();
    const descriptor = descriptors.find((entry) => entry.name === "propose_context_variable");

    const result = await descriptor!.createTool(context).invoke({
      agentId: "agent-1",
      name: "loyalty_tier",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    }, {} as never);

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "context_variable",
      targetRef: { agentId: "agent-1", variableId: null },
      versionToken: "variable-version",
    }));
    expect(result).toMatchObject({ targetType: "context_variable", targetLabel: "loyalty_tier" });
    // The version token comes from validatePayload's own return, not a follow-up call: a second,
    // separate read could pair a payload expansion built from the first (now stale) read with a
    // token from the second, fresher read, letting a concurrent edit slip past Apply's version
    // check undetected.
    expect((adapter as { readVersionToken: ReturnType<typeof vi.fn> }).readVersionToken).not.toHaveBeenCalled();
  });

  it("targets an existing variable by id and falls back to the page agent", async () => {
    const { descriptors, adapter } = buildTools();
    const descriptor = descriptors.find((entry) => entry.name === "propose_context_variable");

    await descriptor!.createTool(context).invoke({ variableId: "variable-1", enablement: { source: "pushed", surfacing: "always" } }, {} as never);

    expect((adapter as { validatePayload: ReturnType<typeof vi.fn> }).validatePayload).toHaveBeenCalledWith(
      "workspace-1",
      { agentId: "agent-1", variableId: "variable-1" },
      expect.objectContaining({ enablement: { source: "pushed", surfacing: "always" } }),
    );
  });
});
