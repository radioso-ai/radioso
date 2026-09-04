import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { sha256Digest } from "@radioso/operator-mcp-contract";

import { OperatorMcpApplicationService } from "../../../src/modules/operatorCopilot/mcpApplicationService.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";

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

const build = () => {
  const credentialValidation = { validate: vi.fn(async () => principal), revalidateCredential: vi.fn(async () => principal) };
  const invocation = {
    id: uuid("12"), credentialId: principal.credentialId, grantId: principal.grantId, grantVersion: principal.grantVersion,
    accountId: principal.accountId, workspaceId: principal.workspaceId, userId: principal.userId, clientId: principal.clientRecordId,
    method: "tools/list" as const, descriptorName: null, shape: null, operationId: null, inputDigest: "digest", verificationCost: 0,
    budgetReservedAt: null, proofNonceDigest: "nonce", proofConsumedAt: null, status: "admitted" as const,
    safeOutcomeCode: null, resultReference: null, createdAt: now, completedAt: null, retainedUntil: new Date(now.getTime() + 86_400_000),
  };
  let proofConsumed = false;
  const invocations = {
    admit: vi.fn(async () => ({ status: "admitted" as const, invocation })),
    consumeProof: vi.fn(async () => proofConsumed ? "replay" as const : (proofConsumed = true, "consumed" as const)),
    prepareInvocation: vi.fn(async () => ({ status: "prepared" as const, invocation: { ...invocation, method: "tools/call" as const, descriptorName: descriptor.name, shape: "read" as const } })),
    markRunning: vi.fn(async () => ({ ...invocation, status: "running" as const })),
    recordOutcome: vi.fn(async () => ({ ...invocation, status: "completed" as const })),
    refundReservation: vi.fn(), findById: vi.fn(), findByOperation: vi.fn(),
  };
  const currentAuthorization = { hasAllPermissions: vi.fn(async () => true) };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new OperatorMcpApplicationService({
    credentialValidation, invocations, catalog: new OperatorMcpCatalogService([descriptor]),
    currentAuthorization, audit, secret: "internal-secret-at-least-thirty-two-bytes", now: () => now,
  });
  return { service, credentialValidation, invocations, audit };
};

describe("OperatorMcpApplicationService", () => {
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
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest: sha256Digest("call") });
    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: { section: "retrieval", secret: "do-not-record" } }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "operator_mcp.invocation", eventStatus: "failure",
      metadata: expect.objectContaining({ descriptorName: descriptor.name, capabilityShape: "read", outcome: "refused", reason: "invalid_arguments" }),
    }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("do-not-record");
  });

  it("suppresses a result when grant authority changes before final enrichment", async () => {
    const { service, credentialValidation, invocations } = build();
    credentialValidation.revalidateCredential
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce({ ...principal, grantVersion: "4" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest: sha256Digest("call") });
    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: { section: "retrieval" } }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", safeOutcomeCode: "forbidden" }));
  });

  it("validates, prepares, invokes, and records a bounded direct result", async () => {
    const { service, invocations, audit } = build();
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest: sha256Digest("call") });
    const result = await service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: { section: "retrieval" } });
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
});
