import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { digestOperatorMcpCall, OPERATOR_MCP_SCOPES, sha256Digest } from "@radioso/operator-mcp-contract";

import { OperatorMcpApplicationError, OperatorMcpApplicationService } from "../../../src/modules/operatorCopilot/mcpApplicationService.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { OperatorMcpAccessError, type OperatorMcpPrincipal } from "../../../src/modules/operatorMcpAuthorization/public.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";
import type { OperatorMcpInvocationRecord, OperatorMcpInvocationRepositoryPort } from "../../../src/modules/operatorCopilot/mcpContracts.js";
import { AppError, badRequest, conflict, notFound, serviceUnavailable } from "../../../src/shared/domain/errors.js";
import { OperatorCopilotService, type CopilotRepositoryPort } from "../../../src/modules/operatorCopilot/service.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { realCatalog } from "./realCatalogTestSupport.js";

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
  mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "none", idempotent: true, operationIdentity: "client" } },
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
    retry: { effect: "proposal", idempotent: true, operationIdentity: "client" },
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

const build = (activeDescriptor: CopilotToolDescriptor = descriptor, activePrincipal: OperatorMcpPrincipal = principal) => {
  const credentialValidation = { validate: vi.fn(async () => activePrincipal), revalidateCredential: vi.fn(async () => activePrincipal) };
  const invocation = {
    id: uuid("12"), credentialId: principal.credentialId, grantId: principal.grantId, grantVersion: principal.grantVersion,
    accountId: principal.accountId, workspaceId: principal.workspaceId, userId: principal.userId, clientId: principal.clientRecordId,
    method: "tools/list" as const, descriptorName: null, shape: null, operationId: null, inputDigest: "digest", verificationCost: 0,
    budgetReservedAt: null, proofNonceDigest: "nonce", proofConsumedAt: null, status: "admitted" as const,
    safeOutcomeCode: null, safeRejectionDetails: [], resultReference: null, createdAt: now, completedAt: null, retainedUntil: new Date(now.getTime() + 86_400_000),
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
  it("routes an opted-in act replay through descriptor recovery with its original receipt", async () => {
    const reconcileMcpInvocation = vi.fn(async ({ invocation, arguments: input }: { invocation: OperatorMcpInvocationRecord; arguments: unknown }) => ({
      status: "recovered" as const,
      output: { section: `${(input as { section: string }).section}:${invocation.id}` },
    }));
    const recoveryDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      name: "reviewed_act",
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
      reconcileMcpInvocation,
    };
    const { service, invocations, invocation } = build(recoveryDescriptor);
    const original = { ...invocation, method: "tools/call" as const, descriptorName: recoveryDescriptor.name, shape: "act" as const, operationId: "operation-1", status: "failed" as const };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: recoveryDescriptor.name, arguments: argumentsValue, operationId: "operation-1" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: recoveryDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-act", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: recoveryDescriptor.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest }))
      .resolves.toMatchObject({ structuredContent: { section: `retrieval:${original.id}` }, safeOutcomeCode: "completed" });
    expect(reconcileMcpInvocation).toHaveBeenCalledWith(expect.objectContaining({ invocation: original, arguments: argumentsValue }));
    expect(invocations.claimRunning).not.toHaveBeenCalled();
  });

  it("keeps a completed idempotent act without a recovery hook as a terminal replay", async () => {
    const terminalAct: CopilotToolDescriptor = {
      ...descriptor,
      name: "terminal_act",
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
    };
    const { service, invocations, invocation } = build(terminalAct);
    const original = { ...invocation, method: "tools/call" as const, descriptorName: terminalAct.name, shape: "act" as const, operationId: "operation-1", status: "completed" as const, safeOutcomeCode: "completed" };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: terminalAct.name, arguments: argumentsValue, operationId: "operation-1" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: terminalAct.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-terminal", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: terminalAct.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest }))
      .resolves.toMatchObject({ safeOutcomeCode: "completed" });
    expect(invocations.claimRunning).not.toHaveBeenCalled();
  });

  it("leaves an original act receipt running while its owner lease is still active", async () => {
    const activeAct: CopilotToolDescriptor = {
      ...descriptor,
      name: "reviewed_act",
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
      reconcileMcpInvocation: vi.fn(async () => ({ status: "in_progress" as const })),
    };
    const { service, invocations, invocation } = build(activeAct);
    const original = { ...invocation, method: "tools/call" as const, descriptorName: activeAct.name, shape: "act" as const, operationId: "operation-1", status: "running" as const };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: activeAct.name, arguments: argumentsValue, operationId: "operation-1" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: activeAct.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-active", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: activeAct.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest }))
      .resolves.toMatchObject({ safeOutcomeCode: "in_progress" });
    expect(invocations.recordOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ invocationId: original.id }));
    expect(invocations.claimRunning).not.toHaveBeenCalled();
  });

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
      // The rejected field names travel back so the caller can fix the call; the values at them do not.
      .rejects.toMatchObject({ code: "invalid_arguments", details: ["secret: unrecognized_keys"] });
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

  it("reports a descriptor's own bad-input rejection as a clean invalid_arguments refusal, not an opaque dependency failure", async () => {
    // A tool can reject a caller's input for a reason schema validation cannot express (e.g. citing
    // replay evidence over a transport with no Ray conversation to attribute it to). That is the
    // same class of caller mistake as failing Zod validation, so it must not surface as the generic
    // `dependency_error`/`failed` bucket the caller has no way to act on.
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw badRequest(`Citing replay evidence requires a Ray conversation, which this transport does not have. ${"detail ".repeat(100)}`); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest });

    const rejection = await service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest })
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    // The tool's own sentence is the only account of what was wrong; without it the caller reads
    // the bare code and guesses again. It is bounded where it is written, not only in transit.
    expect(rejection).toMatchObject({ code: "invalid_arguments" });
    expect(rejection?.details?.[0]).toHaveLength(300);
    expect(rejection?.details?.[0]).toMatch(/^Citing replay evidence requires a Ray conversation/);
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
  });

  it("forwards bounded revision diagnostics as invalid_arguments rather than an unavailable runtime", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw new AppError(422, "revision_invalid", "The routine cannot be served.", {
          diagnostics: [{ safeDiagnostic: true, routineId: uuid("91"), code: "node_id_collision", location: "step:return", message: "A step or terminal identifier is used more than once." }],
        }); }),
      }),
    };
    const { service } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-422", bodyDigest });

    const rejection = await service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest })
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    expect(rejection).toMatchObject({ code: "invalid_arguments", details: [{ routineId: uuid("91"), code: "node_id_collision", location: "step:return", message: "A step or terminal identifier is used more than once." }, "The requested revision cannot be served. Use the diagnostic code and location to correct it."] });
  });

  it("replays a persisted caller rejection with its structured diagnostics", async () => {
    const { service, invocations, invocation } = build();
    const original = { ...invocation, method: "tools/call" as const, descriptorName: descriptor.name, shape: "read" as const, operationId: "operation-1", status: "refused" as const, safeOutcomeCode: "invalid_arguments", safeRejectionDetails: [{ routineId: uuid("91"), code: "node_id_collision", location: "nodes[0].id", message: "Duplicate node" }] };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: descriptor.name, arguments: argumentsValue, operationId: "operation-1" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: descriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "replay-diagnostic", bodyDigest });
    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest })).rejects.toMatchObject({ code: "invalid_arguments", details: original.safeRejectionDetails });
  });

  it("keeps an authoring-model 422 as a dependency failure", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = { ...descriptor, createTool: () => ({ name: descriptor.name, description: "Read settings", inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }), invoke: vi.fn(async () => { throw new AppError(422, "invalid_directive_draft", "Model output was invalid"); }) }) };
    const { service } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "model-422", bodyDigest });
    await expect(service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest })).rejects.toMatchObject({ code: "invalid_directive_draft" });
  });

  it("reports a descriptor's own not-found rejection as a clean invalid_arguments refusal, not an opaque dependency failure", async () => {
    // An id that addresses nothing this credential can reach (e.g. a reviewed-operation id from
    // another grant, or a propose_* proposal with no reviewed-operation binding at all) is the
    // caller's mistake to correct, not a runtime outage.
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw notFound("No reviewed operation with this id is bound to this MCP connection."); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "not-found", bodyDigest });

    const rejection = await service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest })
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    expect(rejection).toMatchObject({ code: "invalid_arguments" });
    expect(rejection?.details?.[0]).toBe("No reviewed operation with this id is bound to this MCP connection.");
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
  });

  it("reports a descriptor's own conflict rejection as a clean invalid_arguments refusal, not an opaque dependency failure", async () => {
    // A naming collision with current workspace state (e.g. proposing a context variable whose
    // name already exists) is the caller's mistake to correct, same as bad input or an unbound id.
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw conflict('A context variable named "region" already exists for this workspace'); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "conflict", bodyDigest });

    const rejection = await service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest })
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    expect(rejection).toMatchObject({ code: "invalid_arguments" });
    expect(rejection?.details?.[0]).toBe('A context variable named "region" already exists for this workspace');
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
  });

  it("leaves an AppError outside the caller-rejection statuses unchanged", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw serviceUnavailable("Upstream dependency is unavailable."); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "service-unavailable", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toThrow("Upstream dependency is unavailable.");
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", safeOutcomeCode: "dependency_error" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "failed", reason: "dependency_error" }),
    }));
  });

  it("leaves a non-AppError dependency failure unchanged", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw new Error("connection reset"); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue);
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "dependency-error", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toThrow("connection reset");
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", safeOutcomeCode: "dependency_error" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "failed", reason: "dependency_error" }),
    }));
  });

  it("reports a missing retrieval configuration as an actionable refusal", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw new AppError(409, "retrieval_not_configured", "Configure a default retrieve skill first."); }),
      }),
    };
    const { service, invocations, audit } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "missing-config", bodyDigest: callDigest(argumentsValue) });

    await expect(service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, bodyDigest: callDigest(argumentsValue) }))
      .rejects.toMatchObject({ code: "missing_configuration" });
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "missing_configuration" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "missing_configuration" }) }));
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
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
    const { service, invocations, invocation, audit } = build(enriched);
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
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "replayed", reason: "operation_recovered" }) }));
  });

  it("re-prepares exactly once after a stale proposal attempt is released", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    proposalReconciliation.mockResolvedValueOnce({ status: "retry_prepare" });
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
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
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
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

  it("replays a completed reviewed execution by its persisted proposal reference after a fresh proof", async () => {
    const proposalId = uuid("77");
    const execution: CopilotToolDescriptor = {
      ...descriptor,
      name: "execute_reviewed_proposal",
      shape: "act",
      inputSchema: z.object({ proposalId: z.string().uuid() }).strict(),
      outputSchema: z.object({ proposalId: z.string().uuid(), status: z.literal("applied") }).strict(),
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
      createTool: () => ({ name: "execute_reviewed_proposal", description: "execute", inputSchema: z.object({ proposalId: z.string().uuid() }), outputSchema: z.unknown(), invoke: vi.fn(async () => ({ proposalId, status: "applied" as const })) }),
    };
    const { service, invocations, invocation } = build(execution);
    const operationId = "publish-once";
    const args = { proposalId };
    const bodyDigest = digestOperatorMcpCall({ name: execution.name, arguments: args, operationId });
    const first = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: execution.name, resource: principal.resource, timestamp: "1788480000", nonce: "first", bodyDigest });
    await expect(service.invoke({ proof: first.proof, name: execution.name, arguments: args, operationId, bodyDigest })).resolves.toMatchObject({ resultReference: proposalId });

    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: { ...invocation, id: uuid("13"), status: "completed", descriptorName: execution.name, shape: "act", operationId, resultReference: proposalId, safeOutcomeCode: "completed" } });
    invocations.consumeProof.mockResolvedValueOnce("consumed");
    const retry = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: execution.name, resource: principal.resource, timestamp: "1788480000", nonce: "retry", bodyDigest });
    await expect(service.invoke({ proof: retry.proof, name: execution.name, arguments: args, operationId, bodyDigest })).resolves.toMatchObject({ safeOutcomeCode: "completed", resultReference: proposalId });
  });
});

describe("operator MCP operation identity", () => {
  const unkeyedCall = async (service: OperatorMcpApplicationService, name: string, argumentsValue: Record<string, unknown>, nonce = "edge-unkeyed") => {
    const bodyDigest = digestOperatorMcpCall({ name, arguments: argumentsValue });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: name, resource: principal.resource, timestamp: "1788480000", nonce, bodyDigest });
    return service.invoke({ proof: admitted.proof, name, arguments: argumentsValue, bodyDigest });
  };
  const inputKeyedAct = (reconcileMcpInvocation: CopilotToolDescriptor["reconcileMcpInvocation"]): CopilotToolDescriptor => ({
    ...descriptor,
    name: "reviewed_act",
    shape: "act",
    mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
    reconcileMcpInvocation,
  });

  it("runs a client-keyed proposal unkeyed when the client sends no operation id", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
    const { service, invocations } = build(enriched);

    await expect(unkeyedCall(service, enriched.name, { section: "retrieval" }))
      .resolves.toMatchObject({ structuredContent: { proposalId: uuid("14") }, safeOutcomeCode: "completed" });
    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ operationId: null }));
    expect(proposalReconciliation).not.toHaveBeenCalled();
    expect(proposalInvoke).toHaveBeenCalledOnce();
  });

  it("keys an input-identity act by its input, so an identical unkeyed retry reconciles instead of running again", async () => {
    const reconcileMcpInvocation = vi.fn(async ({ invocation, arguments: input }: { invocation: { id: string }; arguments: unknown }) => ({
      status: "recovered" as const,
      output: { section: `${(input as { section: string }).section}:${invocation.id}` },
    }));
    const act = inputKeyedAct(reconcileMcpInvocation);
    const first = build(act);
    await expect(unkeyedCall(first.service, act.name, { section: "retrieval" }))
      .resolves.toMatchObject({ structuredContent: { section: "retrieval" }, safeOutcomeCode: "completed" });
    const firstPrepare = first.invocations.prepareInvocation.mock.calls[0][0];
    expect(firstPrepare.operationId).toBe(firstPrepare.inputDigest);
    expect(reconcileMcpInvocation).not.toHaveBeenCalled();

    const retry = build(act);
    const original = {
      ...retry.invocation, id: uuid("13"), method: "tools/call" as const, descriptorName: act.name, shape: "act" as const,
      operationId: firstPrepare.operationId, inputDigest: firstPrepare.inputDigest, status: "completed" as const, safeOutcomeCode: "completed",
    };
    retry.invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });

    await expect(unkeyedCall(retry.service, act.name, { section: "retrieval" }))
      .resolves.toMatchObject({ structuredContent: { section: `retrieval:${uuid("13")}` }, safeOutcomeCode: "completed" });
    expect(retry.invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ operationId: firstPrepare.operationId }));
    expect(reconcileMcpInvocation).toHaveBeenCalledWith(expect.objectContaining({ invocation: original }));
    expect(retry.invocations.claimRunning).not.toHaveBeenCalled();
  });

  it("keys an input-identity act by a client-sent operation id when one is present", async () => {
    const act = inputKeyedAct(vi.fn());
    const { service, invocations } = build(act);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: act.name, arguments: argumentsValue, operationId: "client-operation" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: act.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-keyed", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: act.name, arguments: argumentsValue, operationId: "client-operation", bodyDigest }))
      .resolves.toMatchObject({ safeOutcomeCode: "completed" });
    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ operationId: "client-operation" }));
  });

  const eligibleCatalog = realCatalog().filter((candidate) => candidate.mcpDisposition?.status === "eligible");
  const everyScope: OperatorMcpPrincipal = { ...principal, currentToolScopes: [...OPERATOR_MCP_SCOPES] };

  it.each(eligibleCatalog.map((real) => [real.name, real] as const))("accepts a standard %s call that carries no operation id", async (_name, real) => {
    const standIn: CopilotToolDescriptor = { ...descriptor, name: real.name, shape: real.shape, mcpDisposition: real.mcpDisposition };
    const { service, invocations } = build(standIn, everyScope);

    await expect(unkeyedCall(service, real.name, { section: "retrieval" })).resolves.toMatchObject({ safeOutcomeCode: "completed" });
    const prepared = invocations.prepareInvocation.mock.calls[0][0];
    const identity = real.mcpDisposition?.status === "eligible" ? real.mcpDisposition.retry.operationIdentity : null;
    expect(prepared.operationId).toBe(identity === "input" ? prepared.inputDigest : null);
  });

  it("keys only reviewed execution by its input, since its owner binds the first attempt's receipt", () => {
    const inputKeyed = eligibleCatalog.filter((real) => real.mcpDisposition?.status === "eligible" && real.mcpDisposition.retry.operationIdentity === "input");

    expect(inputKeyed.map((real) => real.name)).toEqual(["execute_reviewed_proposal"]);
  });

  it("reports a replay whose reconciliation is still in flight as in progress, whatever the original receipt recorded", async () => {
    const act = inputKeyedAct(vi.fn(async () => ({ status: "in_progress" as const })));
    const { service, invocations, invocation } = build(act);
    const original = { ...invocation, id: uuid("13"), method: "tools/call" as const, descriptorName: act.name, shape: "act" as const, operationId: "digest", status: "completed" as const, safeOutcomeCode: "completed", resultReference: uuid("77") };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });

    const response = await unkeyedCall(service, act.name, { section: "retrieval" });

    expect(response).toMatchObject({ safeOutcomeCode: "in_progress" });
    expect(response.isError).not.toBe(true);
    expect(response).not.toHaveProperty("structuredContent");
    expect(invocations.recordOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ invocationId: original.id }));
  });

  it.each(["failed", "completed"] as const)("answers an unconfirmed outcome through a %s original execution receipt without settling it", async (priorStatus) => {
    const proposalId = uuid("99");
    const unconfirmed = { status: "uncertain" as const, reason: "The owner did not confirm whether this reviewed operation took effect." };
    const executeMcpReviewedProposal = vi.fn(async () => unconfirmed);
    const [execution] = enrichCopilotToolCatalog(
      [{ ...createReviewedProposalExecutionTool({ executeMcpReviewedProposal }), mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal }],
      { resolveWorkspaceKey: async () => "workspace-key" },
    );
    const argumentsValue = { proposalId, reviewDigest: "a".repeat(43) };
    const firstCall = build(execution, everyScope);
    const firstResponse = await unkeyedCall(firstCall.service, execution.name, argumentsValue);
    expect(firstResponse).toMatchObject({ structuredContent: expect.objectContaining({ proposalId, ...unconfirmed }) });

    const { service, invocations, invocation, audit } = build(execution, everyScope);
    // A snapshot that reads the receipt as finished can be stale: a concurrent retry's claim may
    // have reopened it, and settling it here would fence that retry's owner settlement.
    const original = {
      ...invocation, id: uuid("13"), method: "tools/call" as const, descriptorName: execution.name, shape: "act" as const,
      operationId: "derived", status: priorStatus, safeOutcomeCode: priorStatus === "failed" ? "dependency_error" : "completed",
      proofConsumedAt: new Date(now.getTime() - 600_000),
    };
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });

    const response = await unkeyedCall(service, execution.name, argumentsValue);

    expect(response).toMatchObject({
      structuredContent: expect.objectContaining({ proposalId, ...unconfirmed }),
      safeOutcomeCode: firstResponse.safeOutcomeCode,
      resultReference: firstResponse.resultReference,
    });
    expect(executeMcpReviewedProposal).toHaveBeenLastCalledWith(expect.objectContaining({ executionInvocationId: original.id }));
    expect(invocations.recordOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ invocationId: original.id }));
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ invocationId: uuid("12"), status: "completed", safeOutcomeCode: "replayed" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "replayed", reason: "operation_unconfirmed" }) }));
  });

  it("cancels through the real reviewed-cancellation tool and owner, then answers repeats and replays with the dismissed outcome", async () => {
    const proposalId = uuid("88");
    const preparation = { grantId: principal.grantId, clientId: principal.clientRecordId };
    let proposal = { id: proposalId, workspaceId: principal.workspaceId, operatorUserId: principal.userId, targetType: "directive" as const, status: "pending" as string };
    // The two repository reads cancellation performs, holding the preparation's grant/client binding
    // and the pending-only compare-and-set the database enforces.
    const proposals = {
      findMcpReviewedProposal: vi.fn(async (input: { id: string; grantId: string; clientId: string }) =>
        input.id === proposal.id && input.grantId === preparation.grantId && input.clientId === preparation.clientId ? proposal : null),
      cancelPendingProposal: vi.fn(async (input: { id: string }) => {
        if (input.id !== proposal.id || proposal.status !== "pending") return null;
        proposal = { ...proposal, status: "dismissed" };
        return proposal;
      }),
    };
    const ownerAudit = { record: vi.fn(async () => undefined), getLatestSuccessfulChatAnswerMetadata: vi.fn(), updateChatAnswerSuggestions: vi.fn() };
    const owner = new OperatorCopilotService({
      repository: proposals as unknown as CopilotRepositoryPort,
      capabilityRunner: { runStreaming: vi.fn() }, auditService: ownerAudit, prompt: "system", tools: [],
      usageLimitPolicy: { reserveAnswer: vi.fn(), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn() },
      workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "workspace-key" },
      currentAuthorization: { hasAllPermissions: vi.fn(async () => false) },
    });
    const [cancellation] = enrichCopilotToolCatalog(
      [{ ...createCancelReviewedProposalTool(owner), mcpDisposition: operatorMcpDispositions.cancel_reviewed_proposal }],
      { resolveWorkspaceKey: async () => "workspace-key" },
    );
    const { service, invocations, invocation } = build(cancellation, everyScope);
    const dismissed = { structuredContent: expect.objectContaining({ proposalId, status: "dismissed" }), safeOutcomeCode: "completed" };

    await expect(unkeyedCall(service, cancellation.name, { proposalId }, "edge-cancel")).resolves.toMatchObject(dismissed);
    invocations.consumeProof.mockResolvedValueOnce("consumed");
    await expect(unkeyedCall(service, cancellation.name, { proposalId }, "edge-cancel-repeat")).resolves.toMatchObject(dismissed);

    const operationId = "cancel-once";
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), method: "tools/call", descriptorName: cancellation.name, shape: "act", operationId, status: "completed", safeOutcomeCode: "completed", resultReference: proposalId },
    });
    invocations.consumeProof.mockResolvedValueOnce("consumed");
    const bodyDigest = digestOperatorMcpCall({ name: cancellation.name, arguments: { proposalId }, operationId });
    const replay = await service.admit({ accessToken: "operator-access", invocationId: uuid("14"), method: "tools/call", descriptorName: cancellation.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-cancel-replay", bodyDigest });
    await expect(service.invoke({ proof: replay.proof, name: cancellation.name, arguments: { proposalId }, operationId, bodyDigest })).resolves.toMatchObject(dismissed);

    expect(proposals.cancelPendingProposal).toHaveBeenCalledOnce();
    expect(ownerAudit.record).toHaveBeenCalledOnce();
    expect(ownerAudit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.dismissed" }));
  });
});
