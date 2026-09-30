import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { digestOperatorMcpCall, OPERATOR_MCP_SCOPES, sha256Digest } from "@radioso/operator-mcp-contract";

import { OperatorMcpApplicationError, OperatorMcpApplicationService } from "../../../src/modules/operatorCopilot/mcpApplicationService.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { OperatorMcpAccessError, type OperatorMcpPrincipal } from "../../../src/modules/operatorMcpAuthorization/public.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";
import type { CopilotToolInvocationContext } from "../../../src/modules/operatorCopilot/contracts.js";
import type { OperatorMcpInvocationRecord, OperatorMcpInvocationRepositoryPort } from "../../../src/modules/operatorCopilot/mcpContracts.js";
import { AppError, badRequest, conflict, notFound, serviceUnavailable } from "../../../src/shared/domain/errors.js";
import { OperatorCopilotService, type CopilotRepositoryPort } from "../../../src/modules/operatorCopilot/service.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { REVIEWED_APPROVAL_ACCEPT_WAIT_MS } from "../../../src/modules/operatorCopilot/reviewedOperation.js";
import { createTestChatCopilotTools, type CopilotTestChatPort } from "../../../src/modules/operatorCopilot/tools/testChat.js";
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
    budgetKind: "verification" as const, budgetReservedAt: null, proofNonceDigest: "nonce", proofConsumedAt: null, status: "admitted" as const,
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

  it("answers a completed act replay with no recovery hook as a not-retained tool error, not a silent success", async () => {
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

    const response = await service.invoke({ proof: admitted.proof, name: terminalAct.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "completed" });
    expect(response).not.toHaveProperty("structuredContent");
    expect(response.content).toEqual([{ type: "text", text: expect.any(String) }]);
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

    const response = await service.invoke({ proof: admitted.proof, name: activeAct.name, arguments: argumentsValue, operationId: "operation-1", bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "in_progress" });
    expect(response.content).toEqual([{ type: "text", text: expect.any(String) }]);
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

  it("carries the repository's retry timing on a budget-exhausted refusal and names the ceiling in the audit record", async () => {
    const resetAt = new Date("2026-09-30T00:01:00.000Z");
    const { service, invocations, audit } = build();
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "budget_exhausted", retryAfterSeconds: 42, resetAt });
    const argumentsValue = { section: "retrieval" };
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: descriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "budget-exhausted", bodyDigest: callDigest(argumentsValue),
    });

    await expect(service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest: callDigest(argumentsValue) }))
      .rejects.toMatchObject({ code: "budget_exhausted", retry: { retryAfterSeconds: 42, resetAt } });

    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ budgetKind: "verification" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
      metadata: expect.objectContaining({ outcome: "refused", reason: "budget_exhausted", budgetKind: "verification" }),
    }));
  });

  it("omits retry timing entirely when the repository reports a cost that can never fit", async () => {
    const { service, invocations } = build();
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "budget_exhausted" });
    const argumentsValue = { section: "retrieval" };
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: descriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "budget-exhausted-no-retry", bodyDigest: callDigest(argumentsValue),
    });

    const invoked = service.invoke({ proof: admitted.proof, name: descriptor.name, arguments: argumentsValue, bodyDigest: callDigest(argumentsValue) });

    await expect(invoked).rejects.toMatchObject({ code: "budget_exhausted", retry: undefined });
  });

  it("charges a descriptor's own budget kind rather than the shared verification ceiling", async () => {
    const testChatDescriptor: CopilotToolDescriptor = { ...descriptor, name: "send_test_chat_message", operatorMcpBudgetKind: "test_chat" };
    const { service, invocations } = build(testChatDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: testChatDescriptor.name, arguments: argumentsValue });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: testChatDescriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "test-chat-budget", bodyDigest,
    });

    await service.invoke({ proof: admitted.proof, name: testChatDescriptor.name, arguments: argumentsValue, bodyDigest });

    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ budgetKind: "test_chat" }));
  });

  it("re-runs a read fresh even when the client repeats an earlier operation id", async () => {
    const { service, invocations } = build();
    const operationId = "stable-operation";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue, operationId);
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: descriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    // A read is idempotent with no recovery hook, so it is never keyed: the client's own operation
    // id must not make the second call a dedup replay of the first's (possibly stale) answer.

    await expect(service.invoke({
      proof: admitted.proof,
      name: descriptor.name,
      arguments: argumentsValue,
      operationId,
      bodyDigest,
    })).resolves.toMatchObject({ structuredContent: argumentsValue, safeOutcomeCode: "completed" });
    expect(invocations.prepareInvocation).toHaveBeenCalledWith(expect.objectContaining({ operationId: null }));
    expect(invocations.claimRunning).toHaveBeenCalledOnce();
  });

  it.each(["running", "failed", "completed"] as const)("recovers a proposal committed before its original %s invocation outcome", async (priorStatus) => {
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

  it("answers a completed proposal replay as not retained, not a conflict, when reconciliation proves no proposal committed", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    proposalReconciliation.mockResolvedValueOnce({ status: "retry_prepare" });
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
    const { service, invocations, invocation } = build(enriched);
    const operationId = "completed-before-proposal";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: enriched.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: enriched.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), status: "completed", safeOutcomeCode: "completed", descriptorName: enriched.name, shape: "propose", operationId },
    });

    const response = await service.invoke({ proof: admitted.proof, name: enriched.name, arguments: argumentsValue, operationId, bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "completed" });
    expect(response).not.toHaveProperty("structuredContent");
    expect(proposalInvoke).not.toHaveBeenCalled();
  });

  it("answers a completed probe replay as not retained instead of spending another probe", async () => {
    const probeInvoke = vi.fn(async () => ({ section: "retrieval" }));
    const probeDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      name: "retrieval_probe",
      mcpDisposition: operatorMcpDispositions.retrieval_probe,
      createTool: () => ({ name: "retrieval_probe", description: "probe", inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, invoke: probeInvoke }),
    };
    const { service, invocations, invocation } = build(probeDescriptor, { ...principal, currentToolScopes: ["operator:probe"] });
    const operationId = "probe-once";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: probeDescriptor.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: probeDescriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge-probe", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), status: "completed", safeOutcomeCode: "completed", descriptorName: probeDescriptor.name, shape: "probe", operationId },
    });

    const response = await service.invoke({ proof: admitted.proof, name: probeDescriptor.name, arguments: argumentsValue, operationId, bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "completed" });
    expect(probeInvoke).not.toHaveBeenCalled();
  });

  it("answers a still-running probe replay as in progress without spending another probe", async () => {
    const probeInvoke = vi.fn();
    const probeDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      name: "retrieval_probe",
      mcpDisposition: operatorMcpDispositions.retrieval_probe,
      createTool: () => ({ name: "retrieval_probe", description: "probe", inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, invoke: probeInvoke }),
    };
    const { service, invocations, invocation } = build(probeDescriptor, { ...principal, currentToolScopes: ["operator:probe"] });
    const operationId = "probe-running";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: probeDescriptor.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: probeDescriptor.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge-probe-running", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), status: "running", descriptorName: probeDescriptor.name, shape: "probe", operationId },
    });

    const response = await service.invoke({ proof: admitted.proof, name: probeDescriptor.name, arguments: argumentsValue, operationId, bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "in_progress" });
    expect(probeInvoke).not.toHaveBeenCalled();
  });

  it("answers a refused replay as not retained without invoking reconciliation", async () => {
    proposalReconciliation.mockReset();
    proposalInvoke.mockClear();
    const enriched = enrichCopilotToolCatalog([rawProposalDescriptor], { resolveWorkspaceKey: async () => "workspace-key" })[0];
    const { service, invocations, invocation } = build(enriched);
    const operationId = "refused-once";
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: enriched.name, arguments: argumentsValue, operationId });
    const admitted = await service.admit({
      accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: enriched.name,
      resource: principal.resource, timestamp: "1788480000", nonce: "edge-refused", bodyDigest,
    });
    invocations.prepareInvocation.mockResolvedValueOnce({
      status: "replay",
      invocation: { ...invocation, id: uuid("13"), status: "refused", safeOutcomeCode: "operation_conflict", descriptorName: enriched.name, shape: "propose", operationId },
    });

    const response = await service.invoke({ proof: admitted.proof, name: enriched.name, arguments: argumentsValue, operationId, bodyDigest });

    expect(response).toMatchObject({ isError: true, safeOutcomeCode: "operation_conflict" });
    expect(proposalReconciliation).not.toHaveBeenCalled();
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

  /**
   * Finding 1 of the stacked review: only an accepted URL-elicitation retry should ask a reviewed
   * descriptor to wait for approval. This is generic plumbing at the application-service boundary
   * -- it derives a plain context field from the transport's `approvalResponse`, with no opinion
   * about what a descriptor does with it (`execute_reviewed_proposal`'s own use of it is covered in
   * reviewed-approval-gate.test.ts).
   */
  describe("the accepted-retry wait budget", () => {
    it("sets awaitApprovalMs on a fresh call's context only for an accepted elicitation response", async () => {
      const createToolSpy = vi.fn((_context: CopilotToolInvocationContext) => ({ name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, invoke: vi.fn(async (value: { section: string }) => value) }));
      const waitDescriptor: CopilotToolDescriptor = { ...descriptor, createTool: createToolSpy };
      const { service } = build(waitDescriptor);
      const argumentsValue = { section: "retrieval" };
      const bodyDigest = digestOperatorMcpCall({ name: waitDescriptor.name, arguments: argumentsValue });
      const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("20"), method: "tools/call", descriptorName: waitDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "accept-nonce", bodyDigest });

      await service.invoke({ proof: admitted.proof, name: waitDescriptor.name, arguments: argumentsValue, bodyDigest, approvalResponse: { action: "accept" } });

      expect(createToolSpy).toHaveBeenCalledWith(expect.objectContaining({ awaitApprovalMs: REVIEWED_APPROVAL_ACCEPT_WAIT_MS }));
    });

    it.each([
      { label: "no elicitation response at all", approvalResponse: undefined },
      { label: "a decline", approvalResponse: { action: "decline" as const } },
      { label: "a cancel", approvalResponse: { action: "cancel" as const } },
    ])("leaves awaitApprovalMs unset for $label", async ({ approvalResponse }) => {
      const createToolSpy = vi.fn((_context: CopilotToolInvocationContext) => ({ name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema, invoke: vi.fn(async (value: { section: string }) => value) }));
      const waitDescriptor: CopilotToolDescriptor = { ...descriptor, createTool: createToolSpy };
      const { service } = build(waitDescriptor);
      const argumentsValue = { section: "retrieval" };
      const bodyDigest = digestOperatorMcpCall({ name: waitDescriptor.name, arguments: argumentsValue });
      const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("21"), method: "tools/call", descriptorName: waitDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: `nonce-${String(approvalResponse?.action ?? "absent")}`, bodyDigest });

      await service.invoke({ proof: admitted.proof, name: waitDescriptor.name, arguments: argumentsValue, bodyDigest, ...(approvalResponse ? { approvalResponse } : {}) });

      const [context] = createToolSpy.mock.calls[0];
      expect(context.awaitApprovalMs).toBeUndefined();
    });

    it("threads the same wait budget and a bounded signal into a reconciled retry's context", async () => {
      const reconcileMcpInvocation = vi.fn(async () => ({ status: "recovered" as const, output: { section: "retrieval" } }));
      const recoveryDescriptor: CopilotToolDescriptor = {
        ...descriptor,
        name: "reviewed_act_wait",
        mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
        reconcileMcpInvocation,
      };
      const { service, invocations, invocation } = build(recoveryDescriptor);
      const original = { ...invocation, method: "tools/call" as const, descriptorName: recoveryDescriptor.name, shape: "act" as const, operationId: "operation-wait", status: "failed" as const };
      invocations.prepareInvocation.mockResolvedValueOnce({ status: "replay", invocation: original });
      const argumentsValue = { section: "retrieval" };
      const bodyDigest = digestOperatorMcpCall({ name: recoveryDescriptor.name, arguments: argumentsValue, operationId: "operation-wait" });
      const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("22"), method: "tools/call", descriptorName: recoveryDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "accept-retry", bodyDigest });

      await service.invoke({ proof: admitted.proof, name: recoveryDescriptor.name, arguments: argumentsValue, operationId: "operation-wait", bodyDigest, approvalResponse: { action: "accept" } });

      expect(reconcileMcpInvocation).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ awaitApprovalMs: REVIEWED_APPROVAL_ACCEPT_WAIT_MS }),
        signal: expect.any(AbortSignal),
      }));
    });
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

  it("ignores a client-sent operation id for an input-identity act, keying by its input digest instead", async () => {
    const act = inputKeyedAct(vi.fn());
    const { service, invocations } = build(act);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: act.name, arguments: argumentsValue, operationId: "client-operation" });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: act.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-keyed", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: act.name, arguments: argumentsValue, operationId: "client-operation", bodyDigest }))
      .resolves.toMatchObject({ safeOutcomeCode: "completed" });
    const prepared = invocations.prepareInvocation.mock.calls[0][0];
    expect(prepared.operationId).toBe(prepared.inputDigest);
    expect(prepared.operationId).not.toBe("client-operation");
  });

  it("abandons an input-keyed act's key when it is refused before any effect, keeping the real reason in the audit trail", async () => {
    const act: CopilotToolDescriptor = {
      ...inputKeyedAct(vi.fn()),
      createTool: () => ({
        name: "reviewed_act", description: descriptor.description, inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema,
        invoke: vi.fn(async () => { throw new AppError(400, "target_permission_denied", "You no longer have permission for this reviewed operation target."); }),
      }),
    };
    const { service, invocations, audit } = build(act);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: act.name, arguments: argumentsValue });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: act.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-abandon", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: act.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "invalid_arguments" });

    // A derived key is the call itself, not something the caller can change by retrying -- pinning
    // this refusal to it would replay a stale `target_permission_denied` forever, even after the
    // permission is restored. The row is abandoned instead, freeing the key for a fresh admission,
    // while the audit trail still names the real cause.
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "abandoned_before_effect" }));
    expect(invocations.recordOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
  });

  it("abandons an input-keyed act's key on an operation_conflict refusal too", async () => {
    const act = inputKeyedAct(vi.fn());
    const { service, invocations, audit } = build(act);
    invocations.prepareInvocation.mockResolvedValueOnce({ status: "conflict" });
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: act.name, arguments: argumentsValue });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: act.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-abandon-conflict", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: act.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "operation_conflict" });

    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "abandoned_before_effect" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "operation_conflict" }),
    }));
  });

  it("leaves a receipt alone after a concurrent retry reopened it before this request's running claim", async () => {
    const act = inputKeyedAct(vi.fn());
    const { service, invocations, audit } = build(act);
    invocations.claimRunning.mockResolvedValueOnce(null);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = digestOperatorMcpCall({ name: act.name, arguments: argumentsValue });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: act.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-lost-running-claim", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: act.name, arguments: argumentsValue, bodyDigest }))
      .rejects.toMatchObject({ code: "operation_conflict" });

    // The retry that reopened the receipt may be applying under it right now; only it may settle it.
    expect(invocations.recordOutcome).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "operation_taken_over" }),
    }));
  });

  it("keeps a client-keyed refusal pinned to its key, since the caller can send a fresh operation id", async () => {
    const rejectingDescriptor: CopilotToolDescriptor = {
      ...descriptor,
      createTool: () => ({
        name: "workspace_settings", description: "Read settings",
        inputSchema: z.object({ section: z.string() }), outputSchema: z.object({ section: z.string() }),
        invoke: vi.fn(async () => { throw new AppError(400, "target_permission_denied", "denied"); }),
      }),
    };
    const { service, invocations } = build(rejectingDescriptor);
    const argumentsValue = { section: "retrieval" };
    const bodyDigest = callDigest(argumentsValue, "client-operation");
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: rejectingDescriptor.name, resource: principal.resource, timestamp: "1788480000", nonce: "edge-client-keyed-refused", bodyDigest });

    await expect(service.invoke({ proof: admitted.proof, name: rejectingDescriptor.name, arguments: argumentsValue, operationId: "client-operation", bodyDigest }))
      .rejects.toMatchObject({ code: "invalid_arguments" });

    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
  });

  it("shares one receipt for execute_reviewed_proposal whether or not the client sends an operation id", async () => {
    const proposalId = uuid("55");
    const execution: CopilotToolDescriptor = {
      ...descriptor,
      name: "execute_reviewed_proposal",
      shape: "act",
      inputSchema: z.object({ proposalId: z.string().uuid() }).strict(),
      outputSchema: z.object({ proposalId: z.string().uuid(), status: z.literal("applied") }).strict(),
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:read", retry: { effect: "act", idempotent: true, operationIdentity: "input" } },
      createTool: () => ({ name: "execute_reviewed_proposal", description: "execute", inputSchema: z.object({ proposalId: z.string().uuid() }), outputSchema: z.unknown(), invoke: vi.fn(async () => ({ proposalId, status: "applied" as const })) }),
    };
    const { service, invocations } = build(execution);
    const args = { proposalId };

    const keyedDigest = digestOperatorMcpCall({ name: execution.name, arguments: args, operationId: "client-op" });
    const keyedAdmit = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: execution.name, resource: principal.resource, timestamp: "1788480000", nonce: "share-1", bodyDigest: keyedDigest });
    await service.invoke({ proof: keyedAdmit.proof, name: execution.name, arguments: args, operationId: "client-op", bodyDigest: keyedDigest });
    const keyedKey = invocations.prepareInvocation.mock.calls[0][0].operationId;

    invocations.consumeProof.mockResolvedValueOnce("consumed");
    const unkeyedDigest = digestOperatorMcpCall({ name: execution.name, arguments: args });
    const unkeyedAdmit = await service.admit({ accessToken: "operator-access", invocationId: uuid("13"), method: "tools/call", descriptorName: execution.name, resource: principal.resource, timestamp: "1788480000", nonce: "share-2", bodyDigest: unkeyedDigest });
    await service.invoke({ proof: unkeyedAdmit.proof, name: execution.name, arguments: args, bodyDigest: unkeyedDigest });
    const unkeyedKey = invocations.prepareInvocation.mock.calls[1][0].operationId;

    expect(unkeyedKey).toBe(keyedKey);
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
    // A caller cannot act on an in-progress answer it cannot tell apart from success -- both
    // protocol versions must see this as a retryable error, not a completed empty result.
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: expect.any(String) }]);
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

// #1361: over operator MCP the dashboard page context this catalog otherwise falls back to
// (`pageContext.agentId`) is always null, so a Test Chat call naming only a `testExecutionId` used
// to fall through to a plain thrown Error the boundary above could not classify -- recorded as an
// opaque `dependency_error` and reported to the caller as a 503 runtime outage instead of a call it
// could correct. These exercise the real `createTestChatCopilotTools` descriptors through the same
// `enrichCopilotToolCatalog` + `OperatorMcpCatalogService` + `OperatorMcpApplicationService` stack
// operator MCP runs in production, not a stand-in.
describe("Test Chat tools resolve an agent without dashboard page context", () => {
  const mcpNow = new Date("2026-09-30T00:00:00Z");
  const mcpRevision = { id: uuid("60"), kind: "candidate" as const, versionNumber: null, createdAt: mcpNow.toISOString() };
  const readScope: OperatorMcpPrincipal = { ...principal, currentToolScopes: ["operator:read"] };
  const probeScope: OperatorMcpPrincipal = { ...principal, currentToolScopes: ["operator:probe"] };
  const unkeyedCall = async (service: OperatorMcpApplicationService, name: string, argumentsValue: Record<string, unknown>, nonce = "edge-unkeyed") => {
    const bodyDigest = digestOperatorMcpCall({ name, arguments: argumentsValue });
    const admitted = await service.admit({ accessToken: "operator-access", invocationId: uuid("12"), method: "tools/call", descriptorName: name, resource: principal.resource, timestamp: "1788480000", nonce, bodyDigest });
    return service.invoke({ proof: admitted.proof, name, arguments: argumentsValue, bodyDigest });
  };

  const stubTestChat = (overrides: Partial<CopilotTestChatPort> = {}): CopilotTestChatPort => ({
    listSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    readSession: vi.fn(async () => ({
      testExecutionId: uuid("61"), mode: "single" as const, state: "completed" as const, skillEffects: "suppressed" as const, createdAt: mcpNow.toISOString(),
      sides: [{ sideId: uuid("62"), revision: mcpRevision, state: "completed" as const, turns: [] }],
    })),
    readTurn: vi.fn(async () => ({
      testExecutionId: uuid("61"), sideId: uuid("62"), revision: mcpRevision,
      turn: { turnId: uuid("63"), userMessage: "hi", answer: { messageId: uuid("64"), content: "hello" }, state: "completed" as const, failureCode: null, createdAt: mcpNow.toISOString(), turnTrace: undefined },
    })),
    sendMessage: vi.fn(async () => ({
      testExecutionId: uuid("61"), started: false, sideId: uuid("62"), revision: mcpRevision, turnId: uuid("63"),
      outcome: "completed" as const, failureCode: null, answer: "hello", messageId: uuid("64"), turnTrace: undefined,
    })),
    findAgentId: vi.fn(async () => uuid("6")),
    ...overrides,
  });

  /** One real, enriched, MCP-dispositioned Test Chat descriptor -- the same shape `dependencies.ts` assembles. */
  const testChatMcpDescriptor = (
    name: "test_chat_sessions" | "test_chat_transcript" | "test_chat_turn_trace" | "send_test_chat_message",
    testChat: CopilotTestChatPort,
    agentLookup: { listExisting: (workspaceId: string) => Promise<ReadonlyArray<{ id: string; name: string; isDefault: boolean; assistantBootstrapActive: boolean }>> } = { listExisting: async () => [] },
  ): CopilotToolDescriptor => {
    const [enriched] = enrichCopilotToolCatalog(
      createTestChatCopilotTools({ testChat, agentLookup })
        .filter((candidate) => candidate.name === name)
        .map((candidate) => ({ ...candidate, mcpDisposition: operatorMcpDispositions[candidate.name] })),
      { resolveWorkspaceKey: async () => "acme" },
    );
    if (!enriched) throw new Error(`missing test chat descriptor ${name}`);
    return enriched;
  };

  const notDependencyError = (invocations: { recordOutcome: ReturnType<typeof vi.fn> }, audit: { record: ReturnType<typeof vi.fn> }) => {
    expect(invocations.recordOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ safeOutcomeCode: "dependency_error" }));
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ reason: "dependency_error" }) }));
  };

  it("(a) resolves send_test_chat_message's agent from testExecutionId alone, and never records a dependency_error", async () => {
    const testExecutionId = uuid("70");
    const testChat = stubTestChat();
    const send = testChatMcpDescriptor("send_test_chat_message", testChat);
    const { service, invocations, audit } = build(send, probeScope);

    const response = await unkeyedCall(service, send.name, { testExecutionId, message: "Can I book a demo?" });

    expect(response).toMatchObject({ safeOutcomeCode: "completed" });
    expect(testChat.findAgentId).toHaveBeenCalledWith({ workspaceId: principal.workspaceId, testExecutionId });
    expect(testChat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ agentId: uuid("6"), testExecutionId }));
    notDependencyError(invocations, audit);
  });

  it("(b) resolves test_chat_transcript's and test_chat_turn_trace's agent from testExecutionId alone", async () => {
    const testExecutionId = uuid("71");
    const turnId = uuid("72");
    const testChat = stubTestChat();

    const transcript = testChatMcpDescriptor("test_chat_transcript", testChat);
    const transcriptCall = build(transcript, readScope);
    const transcriptResponse = await unkeyedCall(transcriptCall.service, transcript.name, { testExecutionId }, "edge-transcript");
    expect(transcriptResponse).toMatchObject({ safeOutcomeCode: "completed" });
    expect(testChat.readSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: uuid("6"), testExecutionId }));
    notDependencyError(transcriptCall.invocations, transcriptCall.audit);

    const turnTrace = testChatMcpDescriptor("test_chat_turn_trace", testChat);
    const turnTraceCall = build(turnTrace, readScope);
    const turnTraceResponse = await unkeyedCall(turnTraceCall.service, turnTrace.name, { testExecutionId, turnId }, "edge-turn-trace");
    expect(turnTraceResponse).toMatchObject({ safeOutcomeCode: "completed" });
    expect(testChat.readTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: uuid("6"), testExecutionId, turnId }));
    notDependencyError(turnTraceCall.invocations, turnTraceCall.audit);

    expect(testChat.findAgentId).toHaveBeenCalledTimes(2);
  });

  it("(c) rejects test_chat_sessions with no agent as invalid_arguments, not a runtime outage -- it has no testExecutionId to fall back on", async () => {
    const testChat = stubTestChat();
    const sessions = testChatMcpDescriptor("test_chat_sessions", testChat);
    const { service, invocations, audit } = build(sessions, readScope);

    const rejection = await unkeyedCall(service, sessions.name, {})
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    expect(rejection).toMatchObject({ code: "invalid_arguments" });
    expect(rejection?.details?.[0]).toBe("No agent is selected. Pass agentId or agentName.");
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
    expect(testChat.listSessions).not.toHaveBeenCalled();
  });

  it("(d) resolves agentName the same way Ray does: a unique match runs the call; an unknown or ambiguous name reports a resolution, not a runtime error", async () => {
    const agentLookup = { listExisting: vi.fn(async () => [
      { id: uuid("80"), name: "Support", isDefault: true, assistantBootstrapActive: false },
      { id: uuid("81"), name: "Support", isDefault: false, assistantBootstrapActive: false },
      { id: uuid("82"), name: "Sales", isDefault: false, assistantBootstrapActive: false },
    ]) };
    const testChat = stubTestChat();
    const sessions = testChatMcpDescriptor("test_chat_sessions", testChat, agentLookup);

    const unique = build(sessions, readScope);
    await expect(unkeyedCall(unique.service, sessions.name, { agentName: "Sales" }, "edge-name-unique"))
      .resolves.toMatchObject({ safeOutcomeCode: "completed" });
    expect(testChat.listSessions).toHaveBeenCalledWith(expect.objectContaining({ agentId: uuid("82") }));

    const ambiguousCall = build(sessions, readScope);
    const ambiguous = await unkeyedCall(ambiguousCall.service, sessions.name, { agentName: "Support" }, "edge-name-ambiguous");
    expect(ambiguous).toMatchObject({ safeOutcomeCode: "completed" });
    expect(ambiguous.structuredContent).toMatchObject({
      resolution: { status: "ambiguous", candidates: expect.arrayContaining([expect.objectContaining({ id: uuid("80") }), expect.objectContaining({ id: uuid("81") })]) },
    });

    const unknownCall = build(sessions, readScope);
    const unknown = await unkeyedCall(unknownCall.service, sessions.name, { agentName: "Nonexistent" }, "edge-name-unknown");
    expect(unknown).toMatchObject({ safeOutcomeCode: "completed" });
    expect(unknown.structuredContent).toMatchObject({ resolution: { status: "not_found" } });

    // Only the one unique-name call actually reached the read; ambiguous/unknown resolved to a
    // dashboard-style answer instead of ever calling the owning port.
    expect(testChat.listSessions).toHaveBeenCalledTimes(1);
  });

  it("(e) reads a cross-workspace testExecutionId as not found, not as a missing-agent rejection", async () => {
    const testExecutionId = uuid("90");
    const testChat = stubTestChat({ findAgentId: vi.fn(async () => null) });
    const send = testChatMcpDescriptor("send_test_chat_message", testChat);
    const { service, invocations, audit } = build(send, probeScope);

    const rejection = await unkeyedCall(service, send.name, { testExecutionId, message: "hi" })
      .then(() => null, (error: OperatorMcpApplicationError) => error);

    expect(rejection).toMatchObject({ code: "invalid_arguments" });
    expect(rejection?.details?.[0]).toBe("Test execution is unavailable.");
    expect(invocations.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "refused", safeOutcomeCode: "invalid_arguments" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure", metadata: expect.objectContaining({ outcome: "refused", reason: "invalid_arguments" }),
    }));
    expect(testChat.sendMessage).not.toHaveBeenCalled();
  });
});
