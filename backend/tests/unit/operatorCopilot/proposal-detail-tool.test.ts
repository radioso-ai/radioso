import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ContextVariableService } from "../../../src/modules/context-variables/public.js";
import { createDocumentCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/documentProposalAdapter.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { createContextVariableCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { CopilotAuthorizationError, OperatorCopilotService, type CopilotProposalDetailReadPort } from "../../../src/modules/operatorCopilot/service.js";
import { createProposalDetailTool } from "../../../src/modules/operatorCopilot/tools/proposalDetail.js";
import { InMemoryCopilotRepository } from "../../support/inMemoryCopilotRepository.js";

const proposalId = "11111111-1111-4111-8111-111111111111";
const context = {
  workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", surface: "mcp" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};
const readDisposition = { status: "eligible" as const, inputStrategy: "explicit" as const, scope: "operator:read" as const, retry: { effect: "none" as const, idempotent: true, operationIdentity: "client" as const } };

describe("proposal_detail", () => {
  it("uses the owner-safe read model through the MCP catalog", async () => {
    const getProposalDetail = vi.fn(async () => ({
      proposalId, targetType: "agent_skill" as const,
      target: { agentId: "22222222-2222-4222-8222-222222222222", directiveId: null, routineId: null, skillId: null, documentId: null, settingKey: null, label: "Notify", reference: { agentId: "22222222-2222-4222-8222-222222222222", skillId: null } },
      summary: "Notify operators", draftedChange: { name: "Notify", capability: "notify", configKeys: ["delivery"], settings: {} }, status: "pending" as const,
      createdAt: new Date("2026-09-25T12:00:00Z"), decidedAt: null, failureReason: null, reviewedOperation: false,
    }));
    const descriptor = { ...createProposalDetailTool({ getProposalDetail }), mcpDisposition: readDisposition };
    const output = await new OperatorMcpCatalogService([descriptor]).invoke({ name: "proposal_detail", arguments: { proposalId }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({
      proposalId, target: { agentId: "22222222-2222-4222-8222-222222222222", label: "Notify" },
      summary: "Notify operators", draftedChange: { name: "Notify", capability: "notify", configKeys: ["delivery"], settings: {} },
      reviewUrl: `/oauth/operator-mcp/proposal/${proposalId}`, reviewedOperation: false, nextStep: "dashboard_review",
    });
    expect(JSON.stringify(output)).not.toContain("signed-tokenized-webhook-url");
    expect(getProposalDetail).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "user-1", proposalId }));
  });

  it("keeps readable document text, hides resolver credentials, and refuses a revoked target read through real adapters", async () => {
    const repository = new InMemoryCopilotRepository();
    const agentId = randomUUID();
    const resolverSkillId = randomUUID();
    const credentialBearingResolverConfig = { delivery: { webhook: { url: "https://hooks.example.test/notify?signature=signed-secret" } } };
    const agentSkillsReader = { list: vi.fn(async () => [{ id: resolverSkillId, enabled: true, config: credentialBearingResolverConfig }]) };
    let documentsReadable = true;
    const currentAuthorization = {
      hasAllPermissions: vi.fn(async ({ requiredPermissions }: { requiredPermissions: string[] }) =>
        !requiredPermissions.includes("workspace.documents.read") || documentsReadable),
    };
    const contextVariables = new ContextVariableService({
      repository: { get: vi.fn(async () => null), listByWorkspace: vi.fn(async () => []), listByAgent: vi.fn(async () => []), applyProposal: vi.fn() } as never,
      agentReader: { get: vi.fn(async () => ({ id: agentId })) },
      // A resolver skill can hold credentials, while the context-variable projection only exposes its id.
      agentSkillsReader: agentSkillsReader,
    });
    const contextVariableAdapter = createContextVariableCopilotProposalAdapter({ contextVariables });
    const service = new OperatorCopilotService({
      repository,
      currentAuthorization,
      proposalAdapters: [
        createDocumentCopilotProposalAdapter({
          documentAuthoring: { getDocument: vi.fn(), ingest: vi.fn(), updateRetrievalSettings: vi.fn() },
          documentDeletion: { delete: vi.fn() },
          workspaceAccount: { resolveAccountId: vi.fn() },
        }),
        contextVariableAdapter,
      ],
    } as never);
    const documentProposal = await repository.createProposal({
      workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, conversationId: undefined,
      targetType: "document", targetRef: { documentId: null },
      payload: { op: "create", name: "Handbook", content: "Operator-readable document text" }, versionToken: "create", evidence: null,
    } as never);
    const variableDraft = await contextVariableAdapter.validatePayload(context.workspaceId, { agentId, variableId: null }, {
      name: "CRM",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
      enablement: { source: "resolver", resolverSkillId, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference", enabled: true },
    });
    const variableProposal = await repository.createProposal({
      workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, conversationId: undefined,
      targetType: "context_variable", targetRef: variableDraft.targetRef, payload: variableDraft.payload,
      versionToken: variableDraft.versionToken, evidence: null,
    } as never);
    const descriptor = { ...createProposalDetailTool({ getProposalDetail: service.getProposalDetail.bind(service) }), mcpDisposition: readDisposition };
    const catalog = new OperatorMcpCatalogService([descriptor]);
    const catalogContext = { ...context, currentAuthorization } as never;
    const document = await catalog.invoke({ name: "proposal_detail", arguments: { proposalId: documentProposal.id }, context: catalogContext, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) });
    const variable = await catalog.invoke({ name: "proposal_detail", arguments: { proposalId: variableProposal.id }, context: catalogContext, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) });
    expect(document).toMatchObject({ draftedChange: { content: "Operator-readable document text" } });
    expect(variable).toMatchObject({ draftedChange: { enablement: { resolverSkillId } } });
    expect(agentSkillsReader.list).toHaveBeenCalledWith(context.workspaceId, agentId);
    expect(JSON.stringify(variable)).not.toContain("signed-secret");
    expect(JSON.stringify(variable)).not.toContain("webhook");

    documentsReadable = false;
    await expect(catalog.invoke({ name: "proposal_detail", arguments: { proposalId: documentProposal.id }, context: catalogContext, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) }))
      .rejects.toMatchObject({ message: "Copilot proposal not found" });
  });

  it("hides a proposal when its target read permission was revoked", async () => {
    const descriptor = { ...createProposalDetailTool({ getProposalDetail: vi.fn<CopilotProposalDetailReadPort["getProposalDetail"]>(async () => { throw new CopilotAuthorizationError(); }) }), mcpDisposition: readDisposition };
    await expect(new OperatorMcpCatalogService([descriptor]).invoke({ name: "proposal_detail", arguments: { proposalId }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) })).rejects.toMatchObject({ message: "Copilot proposal not found" });
  });
});
