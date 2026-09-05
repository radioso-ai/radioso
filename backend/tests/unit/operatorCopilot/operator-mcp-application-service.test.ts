import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { digestOperatorMcpCall, sha256Digest } from "@radioso/operator-mcp-contract";

import { OperatorMcpApplicationService } from "../../../src/modules/operatorCopilot/mcpApplicationService.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { OperatorMcpAccessError } from "../../../src/modules/operatorMcpAuthorization/public.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";
import type { OperatorMcpInvocationRepositoryPort } from "../../../src/modules/operatorCopilot/mcpContracts.js";

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const now = new Date("2026-09-04T00:00:00Z");
const principal = {
  credentialId: uuid("1"), grantId: uuid("2"), grantVersion: "3", accountId: uuid("4"), workspaceId: uuid("5"),
  userId: uuid("6"), membershipId: uuid("7"), membershipRole: "admin", clientId: "https://client.example/cimd",
  clientRecordId: uuid("8"), clientVersion: "9", clientMetadataSnapshotId: uuid("10"),
  resource: "https://mcp.example/operator/mcp", currentToolScopes: ["operator:read"] as const,
  currentOfflineAccess: false, credentialEpoch: "11",
};
const descriptor: CopilotToolDescriptor = {
  name: "workspace_settings", shape: "read", verificationCost: () => 0, uiLabel: "Workspace settings", description: "Read settings",
  inputSchema: z.object({ section: z.string() }).strict(), outputSchema: z.object({ section: z.string() }).strict(),
  requiredPermissions: ["workspace.settings.read"], contributingModule: "settings", dashboardSubject: { type: "settings" },
  mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "none", idempotent: true, requiresOperationId: false } },
  createTool: () => ({ name: "workspace_settings", description: "Read settings", inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }), invoke: vi.fn(async (input: { section: string }) => input) }),
};
const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.literal("ingestion_settings"),
  targetLabel: z.string(),
  summary: z.string(),
});
const proposalReconciliation = vi.fn();
const proposalInvoke = vi.fn(async () => ({
  proposalId: uuid("14"),
  targetType: "ingestion_settings" as const,
  targetLabel: "Ingestion settings",
  summary: "Change ingestion settings.",
}));
const rawProposalDescriptor: CopilotToolDescriptor = {
  name: "propose_ingestion_settings",
  shape: "propose",
  verificationCost: () => 0,
  uiLabel: "Draft ingestion settings",
  description: "Draft ingestion settings",
  inputSchema: z.object({ section: z.string() }).strict(),
  outputSchema: proposalOutputSchema,
  requiredPermissions: ["workspace.settings.manage"],
  contributingModule: "settings",
  dashboardSubject: { type: "proposal" },
  mcpDisposition: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:read",
    retry: { effect: "proposal", idempotent: true, requiresOperationId: true },
  },
  reconcileMcpInvocation: proposalReconciliation,
  createTool: () => ({
    name: "propose_ingestion_settings",
    description: "Draft ingestion settings",
    inputSchema: z.object({ section: z.string() }),
    outputSchema: proposalOutputSchema,
    invoke: proposalInvoke,
  }),
};
const callDigest = (argumentsValue: Record<string, unknown>, operationId?: string): string =>
  digestOperatorMcpCall({ name: descriptor.name, arguments: argumentsValue, ...(operationId ? { operationId } : {}) });

const build = (activeDescriptor: CopilotToolDescriptor = descriptor) => {
  const credentialValidation = { validate: vi.fn(async () => principal), revalidateCredential: vi.fn(async () => principal) };
  const invocation = {
    id: uuid("12"), credentialId: principal.credentialId, grantId: principal.grantId, grantVersion: principal.grantVersion,
    accountId: principal.accountId, workspaceId: principal.workspaceId, userId: principal.userId, clientId: principal.clientRecordId,
    method: "tools/list" as const, descriptorName: null, shape: null, operationId: null, inputDigest: "digest", verificationCost: 0,
    budgetReservedAt: null, proofNonceDigest: "nonce", proofConsumedAt: null, status: "admitted" as const,
    safeOutcomeCode: null, resultReference: null, createdAt: now, completedAt: null, retainedUntil: new Date(now.getTime() + 86_400_000),
  };
  let proofConsumed = false;
  const prepareInvocation = vi.fn<OperatorMcpInvocationRepositoryPort["prepareInvocation"]>(async () => ({
    status: "prepared",
    invocation: { ...invocation, method: "tools/call", descriptorName: activeDescriptor.name, shape: activeDescriptor.shape },
  }));
  const claimRunning = vi.fn<OperatorMcpInvocationRepositoryPort["claimRunning"]>(async () => ({
    ...invocation,
    status: "running",
  }));
  const invocations = {
    admit: vi.fn(async () => ({ status: "admitted" as const, invocation })),
    consumeProof: vi.fn(async () => proofConsumed ? "replay" as const : (proofConsumed = true, "consumed" as const)),
    prepareInvocation,
    claimRunning,
    recordOutcome: vi.fn(async () => ({ ...invocation, status: "completed" as const })),
    refundReservation: vi.fn(), findById: vi.fn(), findByOperation: vi.fn(),
  };
  const currentAuthorization = { hasAllPermissions: vi.fn(async () => true) };
  const audit = { record: vi.fn(async () => undefined) };
  const catalog = new OperatorMcpCatalogService([activeDescriptor]);
  const service = new OperatorMcpApplicationService({
    credentialValidation, invocations, catalog,
    currentAuthorization, audit, secret: "internal-secret-at-least-thirty-two-bytes", now: () => now,
  });
  return { service, credentialValidation, invocations, audit, invocation, catalog };
};

describe("OperatorMcpApplicationService", () => {
  it("maps an expired access credential to an unauthorized admission", async () => {
    const { service, credentialValidation, invocations } = build();
    credentialValidation.validate.mockRejectedValueOnce(new OperatorMcpAccessError("invalid_token"));

    await expect(service.admit({
      accessToken: "expired-access",
      invocationId: uuid("12"),
      method: "tools/list",
      resource: principal.resource,
      timestamp: "1788480000",
      nonce: "edge-nonce",
      bodyDigest: sha256Digest("request"),
    })).rejects.toMatchObject({ code: "invalid_admission" });
    expect(invocations.admit).not.toHaveBeenCalled();
  });

  it("mints a credential-bound, body-bound, short-lived admission proof", async () => {
    const { service, invocations } = build();
    const bodyDigest = sha256Digest("request");
    const result = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/list", resource: principal.resource, timestamp: "1788480000", nonce: "edge-nonce", bodyDigest });
    expect(result.proof).toMatchObject({
      credentialId: principal.credentialId, credentialEpoch: "11", grantId: principal.grantId, grantVersion: "3",
      clientVersion: "9", clientMetadataSnapshotId: principal.clientMetadataSnapshotId, issuedToolScopes: ["operator:read"],
      resource: principal.resource, method: "tools/list", invocationId: uuid("12"), bodyDigest,
    });
    expect(result.proof.expiresAt - result.proof.issuedAt).toBeLessThanOrEqual(30_000);
    expect(invocations.admit).toHaveBeenCalledWith(expect.objectContaining({ clientId: principal.clientRecordId, proofNonceDigest: expect.any(String) }));
  });

  it("revalidates every signed ceiling and consumes the proof before returning a fresh catalog", async () => {
    const { service, credentialValidation, invocations, audit } = build();
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/list", resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest: sha256Digest("list") });
    const result = await service.list({ proof: admitted.proof });
    expect(result.tools.map((tool) => tool.name)).toEqual(["workspace_settings"]);
    expect(credentialValidation.revalidateCredential).toHaveBeenCalledWith({ credentialId: principal.credentialId, resource: principal.resource, now });
    expect(invocations.consumeProof).toHaveBeenCalledOnce();
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", safeOutcomeCode: "completed" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "operator_mcp.invocation", eventStatus: "success",
      metadata: expect.objectContaining({ method: "tools/list", outcome: "completed" }),
    }));
    await expect(service.list({ proof: admitted.proof })).rejects.toMatchObject({ code: "proof_replay" });
  });

  it("records bounded attributed failures without persisting arguments", async () => {
    const { service, invocations, audit } = build();
    const argumentsValue = { section: "retrieval", secret: "do-not-record" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest });
    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "operator_mcp.invocation", eventStatus: "failure",
      metadata: expect.objectContaining({ descriptorName: descriptor.name, capabilityShape: "read", outcome: "refused", reason: "invalid_arguments" }),
    }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("do-not-record");
  });

  it("rejects call metadata tampering against the signed admission digest before preparation", async () => {
    const original = {
      name: descriptor.name,
      arguments: { section: "retrieval" },
      operationId: "operation-1",
    };
    const bodyDigest = digestOperatorMcpCall(original);
    for (const tampered of [
      { ...original, arguments: { section: "security" } },
      { ...original, name: "retrieval_probe" },
      { ...original, operationId: "operation-2" },
    ]) {
      const { service, invocations } = build();
      const admitted = await service.admit({
        accessToken: "operator-access",
        invocationId: uuid("12"),
        method: "tools/call",
        descriptorName: descriptor.name,
        resource: principal.resource,
        timestamp: "1788480000",
        nonce: "edge",
        bodyDigest,
      });

      await expect(service.invoke({
        proof: admitted.proof,
        ...tampered,
        bodyDigest,
      })).rejects.toMatchObject({ code: "invalid_proof" });
      expect(invocations.prepareInvocation).not.toHaveBeenCalled();
    }
  });

  it("suppresses a result when grant authority changes before final enrichment", async () => {
    const { service, credentialValidation, invocations } = build();
    credentialValidation.revalidateCredential
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce({ ...principal, grantVersion: "4" });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest });
    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", safeOutcomeCode: "forbidden" }));
  });

  it("validates, prepares, invokes, and records a bounded direct result", async () => {
    const { service, invocations, audit } = build();
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest });
    const result = await service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest });
    expect(result).toMatchObject({ structuredContent: { section: "retrieval" }, safeOutcomeCode: "completed" });
    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ descriptorName: descriptor.name, verificationCost: 0 }));
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", safeOutcomeCode: "completed" }));
    expect(audit.record).toHaveBeenCalledWith({
      accountId: principal.accountId,
      workspaceId: principal.workspaceId,
      eventType: "operator_mcp.invocation",
      eventStatus: "success",
      metadata: {
        userId: principal.userId,
        clientId: principal.clientRecordId,
        grantId: principal.grantId,
        invocationId: uuid("12"),
        callingSurface: "operator_mcp",
        method: "tools/call",
        descriptorName: "workspace_settings",
        capabilityShape: "read",
        outcome: "completed",
        reason: "completed",
      },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("operator-access");
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("retrieval");
  });

  it("closes a new receipt when a stable operation reconciles to an earlier result", async () => {
    const { service, invocations, invocation } = build();
    const operationId = "stable-operation";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue, operationId);
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), status: "completed", safeOutcomeCode: "completed", resultReference: "proposal-1" },
    });

    await expect(service.invoke({
      proof: admitted.proof,
      name: descriptor.name,
      arguments: argumentsValue,
      operationId,
      bodyDigest,
    })).resolves.toMatchObject({ safeOutcomeCode: "completed", resultReference: "proposal-1" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: uuid("12"), status: "completed", safeOutcomeCode: "replayed", resultReference: "proposal-1",
    }));
  });

  it.each(["running", "failed"] as const)("recovers a proposal committed before its original %s invocation outcome", async (priorStatus) => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    proposalReconciliation.mockResolvedValueOnce({
      status: "recovered",
      output: {
        proposalId: uuid("14"),
        targetType: "ingestion_settings",
        targetLabel: "Ingestion settings",
        summary: "Change ingestion settings.",
      },
    });
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0]!;
    const { service, invocations, invocation } = build(enriched);
    const proposalId = uuid("14");
    const operationId = "recover-proposal";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: enriched.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: enriched.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: {
        ...invocation,
        id: uuid("13"),
        status: priorStatus,
        descriptorName: enriched.name,
        shape: "propose",
        operationId,
        proofConsumedAt: new Date(now.getTime() - 1_000),
      },
    });

    await expect(service.invoke({
      proof: admitted.proof,
      name: enriched.name,
      arguments: argumentsValue,
      operationId,
      bodyDigest,
    })).resolves.toMatchObject({
      safeOutcomeCode: "completed",
      resultReference: `/oauth/operator-mcp/proposal/${proposalId}`,
    });
    expect(proposalInvoke).not.toHaveBeenCalled();
    expect(invocations.claimRunning).not.toHaveBeenCalled();
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: uuid("13"), status: "completed", safeOutcomeCode: "completed",
      resultReference: `/oauth/operator-mcp/proposal/${proposalId}`,
    }));
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: uuid("12"), status: "completed", safeOutcomeCode: "replayed",
      resultReference: `/oauth/operator-mcp/proposal/${proposalId}`,
    }));
  });

  it("re-prepares exactly once after a stale proposal attempt is released", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    proposalReconciliation.mockResolvedValueOnce({ status: "retry_prepare" });
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0]!;
    const { service, invocations, invocation } = build(enriched);
    const operationId = "retry-released-proposal";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: enriched.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: enriched.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    invocations.prepareInvocation
      .mockResolvedValueOnce({
        status: "replay",
        invocation: { ...invocation, id: uuid("13"), status: "running", descriptorName: enriched.name, shape: "propose", operationId },
      })
      .mockResolvedValueOnce({
        status: "prepared",
        invocation: { ...invocation, descriptorName: enriched.name, shape: "propose", operationId },
      });

    await expect(service.invoke({ proof: admitted.proof, name: enriched.name, arguments: argumentsValue, operationId, bodyDigest }))
      .resolves.toMatchObject({
        safeOutcomeCode: "completed",
        resultReference: `/oauth/operator-mcp/proposal/${uuid("14")}`,
      });
    expect(invocations.prepareInvocation).toHaveBeenCalledTimes(2);
    expect(invocations.claimRunning).toHaveBeenCalledOnce();
    expect(proposalInvoke).toHaveBeenCalledOnce();
  });

  it("replays a failed proposal attempt when reconciliation proves no proposal committed", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    proposalReconciliation.mockResolvedValueOnce({ status: "retry_prepare" });
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0]!;
    const { service, invocations, invocation } = build(enriched);
    const operationId = "failed-before-proposal";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: enriched.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: enriched.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: {
        ...invocation,
        id: uuid("13"),
        status: "failed",
        safeOutcomeCode: "dependency_error",
        descriptorName: enriched.name,
        shape: "propose",
        operationId,
      },
    });

    await expect(service.invoke({ proof: admitted.proof, name: enriched.name, arguments: argumentsValue, operationId, bodyDigest }))
      .resolves.toMatchObject({ isError: true, safeOutcomeCode: "dependency_error" });
    expect(invocations.prepareInvocation).toHaveBeenCalledOnce();
    expect(invocations.claimRunning).not.toHaveBeenCalled();
    expect(proposalInvoke).not.toHaveBeenCalled();
  });

  it("does not invoke a descriptor after losing the admitted-to-running claim", async () => {
    const { service, invocations, catalog } = build();
    const invoke = vi.spyOn(catalog, "invoke");
    invocations.claimRunning.mockResolvedValueOnce(null);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });

    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "operation_conflict" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
