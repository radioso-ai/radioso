import { randomUUID } from "node:crypto";

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { OPERATOR_MCP_SCOPES } from "@radioso/operator-mcp-contract";

import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createDirectiveCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { createDirectiveProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/directives.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { createReviewedProposalOutcomeTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalOutcome.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";
import { copilotProposalTargetTypes } from "../../../src/modules/operatorCopilot/contracts.js";
import { realCatalog } from "./realCatalogTestSupport.js";
import type { CopilotToolDescriptor, CopilotToolInvocationContext } from "../../../src/modules/operatorCopilot/public.js";

const currentAuthorization = { hasAllPermissions: vi.fn(async () => true) };
const context: CopilotToolInvocationContext = {
  workspaceId: "workspace", accountId: "account", operatorUserId: "user", surface: "mcp",
  permissions: new Set(["workspace.settings.read"]), currentAuthorization,
  operatorMcpInvocationId: "00000000-0000-4000-8000-000000000001",
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

const descriptor = (name: string, scope: "operator:read" | "operator:probe", status: "eligible" | "excluded" = "eligible"): CopilotToolDescriptor => ({
  name, shape: scope === "operator:read" ? "read" : "probe", verificationCost: () => scope === "operator:read" ? 0 : 1,
  uiLabel: name, description: `${name} description`, inputSchema: z.object({ key: z.string() }).strict(),
  outputSchema: z.object({ value: z.string() }).strict(), requiredPermissions: ["workspace.settings.read"],
  contributingModule: "test", dashboardSubject: { type: "settings" },
  mcpDisposition: status === "eligible"
    ? { status: "eligible", inputStrategy: "explicit", scope, retry: { effect: "none", idempotent: true, operationIdentity: "client" } }
    : { status: "excluded", reason: "not reviewed" },
  createTool: () => ({
    name, description: name, inputSchema: z.object({ key: z.string() }), outputSchema: z.object({ value: z.string() }),
    invoke: vi.fn(async ({ key }: { key: string }) => ({ value: key })),
  }),
});

describe("OperatorMcpCatalogService", () => {
  it("projects only exact eligible descriptors allowed by current scope and permissions", async () => {
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read"), descriptor("retrieval_probe", "operator:probe"), descriptor("hidden", "operator:read", "excluded")]);
    const catalog = await service.list({ context, scopes: new Set(["operator:read"]) });
    expect(catalog.map((tool) => [tool.name, tool.shape, tool.requiredScope])).toEqual([["workspace_settings", "read", "operator:read"]]);
    expect(catalog[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("declares a union-shaped input as an object schema, and still validates against the union itself", async () => {
    const union = z.union([
      z.object({ kind: z.literal("create"), draft: z.string() }).strict(),
      z.object({ kind: z.literal("delete"), id: z.string() }).strict(),
    ]);
    const base = descriptor("prepare_routine_structure", "operator:read");
    const unionDescriptor = {
      ...base,
      inputSchema: union,
      createTool: () => ({ ...base.createTool(context), inputSchema: union, invoke: vi.fn(async () => ({ value: "prepared" })) }),
    };
    const service = new OperatorMcpCatalogService([unionDescriptor]);

    const [tool] = await service.list({ context, scopes: new Set(["operator:read"]) });

    expect(tool?.inputSchema.type).toBe("object");
    expect(tool?.inputSchema.anyOf).toHaveLength(2);
    // The advertised object type is a declaration, not a widening: a value outside the union is
    // still refused, and a branch member still reaches the tool.
    const call = (args: unknown) => service.invoke({ name: "prepare_routine_structure", arguments: args, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1_000) });
    await expect(call({ kind: "delete", id: "routine-1" })).resolves.toBeDefined();
    await expect(call({ kind: "delete", id: "routine-1", extra: true })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("refuses to project a schema that describes something other than an object", async () => {
    const service = new OperatorMcpCatalogService([{ ...descriptor("workspace_settings", "operator:read"), inputSchema: z.string() }]);

    // The name is what a support thread needs: the failure is reported by the catalog, not the tool.
    await expect(service.list({ context, scopes: new Set(["operator:read"]) })).rejects.toThrow(/workspace_settings/);
  });

  it("rejects guessed names and stale scope before invocation", async () => {
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read")]);
    await expect(service.invoke({ name: "Workspace Settings", arguments: { key: "x" }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(service.invoke({ name: "workspace_settings", arguments: { key: "x" }, context, scopes: new Set(["operator:probe"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("validates arguments and reauthorizes before and after the direct call", async () => {
    currentAuthorization.hasAllPermissions.mockClear();
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read")]);
    await expect(service.invoke({ name: "workspace_settings", arguments: { key: "safe" }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).resolves.toEqual({ value: "safe" });
    expect(currentAuthorization.hasAllPermissions).toHaveBeenCalledTimes(2);
    await expect(service.invoke({ name: "workspace_settings", arguments: { wrong: true }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("enforces propose_directive fields and bounded summaries through the MCP catalog", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const excludes = Array.from({ length: 100 }, (_, index) => `replaced-${index}-${"x".repeat(180)}`);
    const draftForProposal = vi.fn(async () => ({
      draft: {
        directive: {
          name: "quote-primary-source",
          condition: { kind: "always" as const },
          action: "Quote the governing source before explaining it.",
          priority: 85,
          excludes,
          tags: [],
          surfaces: [],
        },
        diagnosis: "directive_recommended" as const,
      },
      versionToken: "2026-09-26T11:00:00.000Z",
    }));
    const createProposal = vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222" }));
    const adapter = createDirectiveCopilotProposalAdapter({
      directiveAuthorService: { draftForProposal },
      authoredDirectiveService: {} as never,
      agentService: {} as never,
    });
    const [directive] = createDirectiveProposalCopilotTools({
      proposalRepository: { createProposal } as never,
      proposalEvidence: { evidence: { findMany: vi.fn() }, agentVersion: { get: vi.fn() } } as never,
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
      proposalAdapters: [adapter],
      auditService: { record: vi.fn(async () => undefined) },
    });
    const service = new OperatorMcpCatalogService([{
      ...directive,
      mcpDisposition: operatorMcpDispositions.propose_directive,
    }]);
    const invoke = (arguments_: unknown) => service.invoke({
      name: "propose_directive",
      arguments: arguments_,
      context,
      scopes: new Set(["operator:propose"]),
      signal: AbortSignal.timeout(1_000),
    });

    const output = await invoke({
      agentId,
      name: "quote-primary-source",
      condition: { kind: "always" },
      action: "Quote the governing source before explaining it.",
      priority: 85,
      excludes,
    });

    expect(output).toMatchObject({ targetLabel: "quote-primary-source", summary: expect.any(String) });
    expect((output as { summary: string }).summary).toHaveLength(2_000);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      // A create is fenced on the agent existing, not on the owner snapshot's agent updatedAt.
      versionToken: "agent-exists",
      payload: expect.objectContaining({ rationale: (output as { summary: string }).summary }),
    }));
    await expect(invoke({ agentId, name: "quote-primary-source", condition: { kind: "always" }, action: "Quote first.", priority: 101 }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(draftForProposal).toHaveBeenCalledTimes(1);
  });

  it("lets a documents manager reach generic reviewed execution while target authorization remains owner-specific", async () => {
    const execution = createReviewedProposalExecutionTool({ executeMcpReviewedProposal: vi.fn(async () => ({ status: "applied" as const })) });
    const service = new OperatorMcpCatalogService([{ ...execution, mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal }]);
    const documentContext = { ...context, permissions: new Set(["workspace.documents.manage"]), currentAuthorization: { hasAllPermissions: vi.fn(async () => true) } };
    await expect(service.list({ context: documentContext, scopes: new Set(["operator:write"]) })).resolves.toMatchObject([{ name: "execute_reviewed_proposal" }]);
    expect(execution.requiredPermissions).toEqual([]);
  });

  /**
   * A minimal but real `CopilotProposal` row. Fields the exercised paths never read (payload,
   * targetRef, evidence, ...) are filled with inert placeholders.
   */
  const mcpProposalRow = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    workspaceId: "workspace",
    operatorUserId: "user",
    origin: { type: "operator_mcp_invocation" as const, invocationId: "00000000-0000-4000-8000-000000000001" },
    conversationId: null,
    operatorMcpInvocationId: "00000000-0000-4000-8000-000000000001",
    messageId: null,
    targetType: "document_operation" as const,
    targetRef: {},
    payload: {},
    versionToken: "v1",
    evidence: null,
    reviewDigest: "a".repeat(43),
    reviewSnapshot: { review: {} },
    expiresAt: null,
    executionInvocationId: null,
    status: "pending" as const,
    reason: null,
    appliedRef: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  });

  /**
   * A repository stub real enough to drive `OperatorCopilotService`'s own claim/cancel/settle
   * state machine, so these tests exercise its per-target-type authorization
   * (`requireProposalAuthorization` + `copilotProposalPermissions`) rather than a test-local
   * reimplementation of that rule.
   */
  const mcpReviewedRepository = (initial: ReadonlyArray<Record<string, unknown>>) => {
    const store = new Map(initial.map((proposal) => [proposal.id as string, proposal]));
    return {
      findMcpReviewedProposal: vi.fn(async ({ id }: { id: string }) => store.get(id) ?? null),
      claimMcpReviewedProposalApply: vi.fn(async ({ proposalId }: { proposalId: string }) => {
        const proposal = store.get(proposalId);
        if (!proposal) return { status: "missing" as const };
        return { status: "claimed" as const, claim: { proposal, claimedAt: new Date(), previousAttemptStartedAt: null } };
      }),
      cancelPendingProposal: vi.fn(async ({ id }: { id: string }) => {
        const proposal = store.get(id) as { status: string } | undefined;
        if (!proposal || proposal.status !== "pending") return null;
        const dismissed = { ...proposal, status: "dismissed" };
        store.set(id, dismissed);
        return dismissed;
      }),
      updateProposalOutcome: vi.fn(async ({ id, status, appliedRef }: { id: string; status: string; appliedRef: unknown }) => {
        const proposal = store.get(id);
        if (!proposal) return null;
        const updated = { ...proposal, status, appliedRef };
        store.set(id, updated);
        return updated;
      }),
      releaseProposalApplyClaim: vi.fn(async () => true),
    };
  };

  /** One stub adapter per target type; only `document_operation`'s apply runs past authorization here. */
  const mcpReviewedAdapters = () => copilotProposalTargetTypes.map((targetType) => ({
    targetType,
    readVersionToken: vi.fn(async () => "v1"),
    preview: vi.fn(async () => ({ targetLabel: "target", current: null, proposed: null })),
    applyIfVersionMatches: vi.fn(async () => targetType === "document_operation"
      ? { outcome: "applied" as const, appliedRef: { documentId: "document" } }
      : { outcome: "failed" as const, reason: "not exercised" }),
  }));

  const authorizationHolding = (held: readonly string[]) => ({
    hasAllPermissions: vi.fn(async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) =>
      requiredPermissions.every((permission) => held.includes(permission))),
  });

  const mcpReviewedService = (initial: ReadonlyArray<Record<string, unknown>>) => new OperatorCopilotService({
    repository: mcpReviewedRepository(initial),
    proposalAdapters: mcpReviewedAdapters(),
    auditService: { record: vi.fn(async () => undefined) },
    currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  } as never);

  const mcpReviewedCatalog = (service: OperatorCopilotService) => new OperatorMcpCatalogService([
    { ...createReviewedProposalExecutionTool(service), mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal },
    { ...createReviewedProposalOutcomeTool(service), mcpDisposition: operatorMcpDispositions.reviewed_proposal_outcome },
    { ...createCancelReviewedProposalTool(service), mcpDisposition: operatorMcpDispositions.cancel_reviewed_proposal },
  ]);

  // Each denied caller holds only the *other* domain's permission, not nothing: a documents
  // manager reaching for an agent-scoped target, and an agent manager reaching for a document one.
  const deniedTargets = [
    { preparedBy: "prepare_retrieval_settings", targetType: "agent_skill" as const, heldByCaller: ["workspace.documents.manage"] },
    { preparedBy: "prepare_routine_structure", targetType: "routine" as const, heldByCaller: ["workspace.documents.manage"] },
    { preparedBy: "prepare_agent_publication", targetType: "agent_publication" as const, heldByCaller: ["workspace.documents.manage"] },
    { preparedBy: "prepare_document_import", targetType: "document_operation" as const, heldByCaller: ["workspace.agents.manage"] },
    { preparedBy: "prepare_agent_settings", targetType: "agent_setting" as const, heldByCaller: ["workspace.documents.manage"] },
    { preparedBy: "prepare_ingestion_settings", targetType: "ingestion_settings" as const, heldByCaller: ["workspace.agents.manage"] },
  ];

  it.each(deniedTargets)(
    "refuses every reviewed path for $preparedBy's target when the caller's current authorization lacks it, including a settled replay",
    async ({ targetType, heldByCaller }) => {
      const pending = mcpProposalRow({ targetType, status: "pending" });
      const settled = mcpProposalRow({ targetType, status: "applied", appliedRef: { mustNotLeak: true } });
      const catalog = mcpReviewedCatalog(mcpReviewedService([pending, settled]));
      const deniedContext = {
        ...context,
        operatorMcpGrantId: "grant",
        operatorMcpClientId: "client",
        currentAuthorization: authorizationHolding(heldByCaller),
      };
      const invoke = (name: string, arguments_: unknown) =>
        catalog.invoke({ name, arguments: arguments_, context: deniedContext, scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

      await expect(invoke("execute_reviewed_proposal", { proposalId: pending.id, reviewDigest: pending.reviewDigest }), "pending execute")
        .rejects.toMatchObject({ code: "target_permission_denied" });
      await expect(invoke("execute_reviewed_proposal", { proposalId: settled.id, reviewDigest: settled.reviewDigest }), "settled replay")
        .rejects.toMatchObject({ code: "target_permission_denied" });
      await expect(invoke("reviewed_proposal_outcome", { proposalId: settled.id }), "outcome")
        .rejects.toMatchObject({ code: "target_permission_denied" });
      await expect(invoke("cancel_reviewed_proposal", { proposalId: pending.id }), "cancel")
        .rejects.toMatchObject({ code: "target_permission_denied" });
    },
  );

  it("allows a documents-only manager to execute, read, and cancel a document operation", async () => {
    const toExecute = mcpProposalRow({ targetType: "document_operation", status: "pending" });
    const toRead = mcpProposalRow({ targetType: "document_operation", status: "applied", appliedRef: { documentId: "document" } });
    const toCancel = mcpProposalRow({ targetType: "document_operation", status: "pending" });
    const catalog = mcpReviewedCatalog(mcpReviewedService([toExecute, toRead, toCancel]));
    const documentContext = {
      ...context,
      operatorMcpGrantId: "grant",
      operatorMcpClientId: "client",
      permissions: new Set(["workspace.documents.manage"]),
      currentAuthorization: authorizationHolding(["workspace.documents.manage"]),
    };
    const invoke = (name: string, arguments_: unknown) =>
      catalog.invoke({ name, arguments: arguments_, context: documentContext, scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    await expect(invoke("execute_reviewed_proposal", { proposalId: toExecute.id, reviewDigest: toExecute.reviewDigest }))
      .resolves.toMatchObject({ status: "applied", appliedRef: { documentId: "document" } });
    await expect(invoke("reviewed_proposal_outcome", { proposalId: toRead.id })).resolves.toMatchObject({ appliedRef: { documentId: "document" } });
    await expect(invoke("cancel_reviewed_proposal", { proposalId: toCancel.id })).resolves.toMatchObject({ status: "dismissed" });
  });
});

/**
 * Radioso's own contract is self-consistent by construction, so it cannot catch the catalog being
 * looser than MCP's. This validates the emitted catalog against the protocol schema a client uses.
 */
describe("the production catalog as a client reads it", () => {
  it("parses as an MCP tools/list result", async () => {
    const service = new OperatorMcpCatalogService(realCatalog());

    const tools = await service.list({ context, scopes: new Set(OPERATOR_MCP_SCOPES) });

    expect(tools.length).toBeGreaterThan(0);
    expect(() => ListToolsResultSchema.parse({ tools })).not.toThrow();
  });
});
