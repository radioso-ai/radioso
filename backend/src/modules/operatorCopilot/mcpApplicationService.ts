import {
  digestOperatorMcpCall,
  digestOperatorMcpInput,
  sha256Digest,
  type OperatorAdmissionRequest,
  type OperatorAdmissionResponse,
  type OperatorCatalogResponse,
  type OperatorInvocationRequest,
  type OperatorInvocationResponse,
  type OperatorMcpProof,
  type OperatorMcpScope,
} from "@radioso/operator-mcp-contract";

import {
  createOperatorProof,
  verifyOperatorProof,
  type OperatorMcpCredentialValidationService,
  type OperatorMcpPrincipal,
} from "../operatorMcpAuthorization/public.js";
import type { AuditPort } from "../audit/contracts/index.js";
import type { CopilotCurrentAuthorizationPort, CopilotToolInvocationContext } from "./contracts.js";
import { OperatorMcpCatalogError, OperatorMcpCatalogService } from "./mcpCatalog.js";
import type { OperatorMcpInvocationRecord, OperatorMcpInvocationRepositoryPort } from "./mcpContracts.js";

const MAX_RESULT_BYTES = 256 * 1024;
const PROOF_TTL_MS = 15_000;

type CredentialValidation = Pick<OperatorMcpCredentialValidationService, "validate" | "revalidateCredential">;

export class OperatorMcpApplicationError extends Error {
  constructor(readonly code:
    | "invalid_admission" | "insufficient_scope" | "invalid_proof" | "proof_replay"
    | "unknown_tool" | "invalid_arguments" | "operation_required" | "operation_conflict" | "budget_exhausted" | "result_too_large" | "invalid_result",
  readonly requiredScope?: OperatorMcpScope) {
    super(code);
  }
}

const exactScopes = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const authorityMatches = (expected: OperatorMcpPrincipal, current: OperatorMcpPrincipal): boolean =>
  expected.credentialId === current.credentialId
  && expected.credentialEpoch === current.credentialEpoch
  && expected.grantId === current.grantId
  && expected.grantVersion === current.grantVersion
  && expected.accountId === current.accountId
  && expected.workspaceId === current.workspaceId
  && expected.userId === current.userId
  && expected.clientId === current.clientId
  && expected.clientVersion === current.clientVersion
  && expected.clientMetadataSnapshotId === current.clientMetadataSnapshotId
  && expected.resource === current.resource
  && exactScopes(expected.currentToolScopes, current.currentToolScopes)
  && expected.currentOfflineAccess === current.currentOfflineAccess;

const proofMatchesPrincipal = (proof: OperatorMcpProof, principal: OperatorMcpPrincipal): boolean => authorityMatches({
  ...principal,
  credentialId: proof.credentialId,
  credentialEpoch: proof.credentialEpoch,
  grantId: proof.grantId,
  grantVersion: proof.grantVersion,
  accountId: proof.accountId,
  workspaceId: proof.workspaceId,
  userId: proof.userId,
  clientId: proof.clientId,
  clientVersion: proof.clientVersion,
  clientMetadataSnapshotId: proof.clientMetadataSnapshotId,
  resource: proof.resource,
  currentToolScopes: proof.issuedToolScopes,
  currentOfflineAccess: proof.issuedOfflineAccess,
}, principal);

const contextFor = (
  principal: OperatorMcpPrincipal,
  invocationId: string,
  currentAuthorization: CopilotCurrentAuthorizationPort,
): CopilotToolInvocationContext => ({
  workspaceId: principal.workspaceId,
  accountId: principal.accountId,
  operatorUserId: principal.userId,
  surface: "mcp",
  permissions: undefined,
  currentAuthorization,
  operatorMcpInvocationId: invocationId,
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
});

const resultReference = (output: unknown): string | null => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  for (const key of ["proposalId", "dashboardUrl"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  }
  return null;
};

const replayResponse = (invocation: OperatorMcpInvocationRecord): OperatorInvocationResponse => ({
  content: [],
  isError: invocation.status === "failed" || invocation.status === "refused",
  safeOutcomeCode: invocation.safeOutcomeCode ?? (invocation.status === "completed" ? "completed" : "in_progress"),
  ...(invocation.resultReference ? { resultReference: invocation.resultReference } : {}),
});

export class OperatorMcpApplicationService {
  constructor(private readonly dependencies: {
    credentialValidation: CredentialValidation;
    invocations: OperatorMcpInvocationRepositoryPort;
    catalog: OperatorMcpCatalogService;
    currentAuthorization: CopilotCurrentAuthorizationPort;
    audit?: Pick<AuditPort, "record">;
    secret: string;
    receiptRetentionDays?: number;
    now?: () => Date;
  }) {}

  private now(): Date { return this.dependencies.now?.() ?? new Date(); }

  private currentAuthorizationFor(principal: OperatorMcpPrincipal): CopilotCurrentAuthorizationPort {
    return {
      hasAllPermissions: async (input) => {
        try {
          const current = await this.dependencies.credentialValidation.revalidateCredential({
            credentialId: principal.credentialId,
            resource: principal.resource,
            now: this.now(),
          });
          return authorityMatches(principal, current)
            && await this.dependencies.currentAuthorization.hasAllPermissions(input);
        } catch {
          return false;
        }
      },
    };
  }

  private async audit(input: {
    principal: OperatorMcpPrincipal;
    invocationId: string;
    method: OperatorMcpProof["method"];
    descriptorName: string | null;
    capabilityShape: "read" | "probe" | "act" | "propose" | null;
    eventStatus: "success" | "failure";
    outcome: string;
    reason: string;
  }): Promise<void> {
    await this.dependencies.audit?.record({
      accountId: input.principal.accountId,
      workspaceId: input.principal.workspaceId,
      eventType: "operator_mcp.invocation",
      eventStatus: input.eventStatus,
      metadata: {
        userId: input.principal.userId,
        clientId: input.principal.clientRecordId,
        grantId: input.principal.grantId,
        invocationId: input.invocationId,
        callingSurface: "operator_mcp",
        method: input.method,
        descriptorName: input.descriptorName,
        capabilityShape: input.capabilityShape,
        outcome: input.outcome,
        reason: input.reason,
      },
    }).catch(() => undefined);
  }

  private async currentProofPrincipal(proof: OperatorMcpProof, expectedMethod: OperatorMcpProof["method"]): Promise<OperatorMcpPrincipal> {
    const now = this.now();
    if (proof.method !== expectedMethod || !verifyOperatorProof(proof, this.dependencies.secret, now.getTime())) {
      throw new OperatorMcpApplicationError("invalid_proof");
    }
    const principal = await this.dependencies.credentialValidation.revalidateCredential({
      credentialId: proof.credentialId, resource: proof.resource, now,
    });
    if (!proofMatchesPrincipal(proof, principal)) throw new OperatorMcpApplicationError("invalid_proof");
    const consumed = await this.dependencies.invocations.consumeProof(sha256Digest(proof.nonce), now);
    if (consumed !== "consumed") throw new OperatorMcpApplicationError(consumed === "replay" ? "proof_replay" : "invalid_proof");
    return principal;
  }

  async admit(request: OperatorAdmissionRequest): Promise<OperatorAdmissionResponse> {
    const now = this.now();
    const principal = await this.dependencies.credentialValidation.validate({ accessToken: request.accessToken, resource: request.resource, now });
    let requiredScope: OperatorMcpScope | undefined;
    let shape: "read" | "probe" | "act" | "propose" | null = null;
    if (request.method === "tools/call") {
      if (!request.descriptorName) throw new OperatorMcpApplicationError("unknown_tool");
      const descriptor = this.dependencies.catalog.descriptor(request.descriptorName);
      const disposition = descriptor?.mcpDisposition;
      if (!descriptor || !disposition || disposition.status !== "eligible") throw new OperatorMcpApplicationError("unknown_tool");
      requiredScope = disposition.scope;
      shape = descriptor.shape;
      if (!principal.currentToolScopes.includes(requiredScope)) throw new OperatorMcpApplicationError("insufficient_scope", requiredScope);
      const visible = await this.dependencies.catalog.list({
        context: contextFor(principal, request.invocationId, this.currentAuthorizationFor(principal)),
        scopes: new Set(principal.currentToolScopes),
      });
      if (!visible.some((tool) => tool.name === request.descriptorName)) throw new OperatorMcpApplicationError("unknown_tool");
    } else if (request.descriptorName) {
      throw new OperatorMcpApplicationError("invalid_admission");
    }

    const proofNonce = sha256Digest(`${request.nonce}\0${request.invocationId}\0${now.getTime()}\0${this.dependencies.secret}`);
    const admitted = await this.dependencies.invocations.admit({
      id: request.invocationId,
      credentialId: principal.credentialId,
      grantId: principal.grantId,
      grantVersion: principal.grantVersion,
      accountId: principal.accountId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      clientId: principal.clientRecordId,
      method: request.method,
      descriptorName: request.descriptorName ?? null,
      shape,
      operationId: null,
      inputDigest: request.bodyDigest,
      verificationCost: 0,
      proofNonceDigest: sha256Digest(proofNonce),
      now,
      retainedUntil: new Date(now.getTime() + (this.dependencies.receiptRetentionDays ?? 90) * 86_400_000),
    });
    if (admitted.status !== "admitted") throw new OperatorMcpApplicationError("invalid_admission");
    if (request.method === "ping") {
      await this.dependencies.invocations.recordOutcome({ invocationId: request.invocationId, status: "completed", safeOutcomeCode: "completed", now });
    }
    const issuedAt = now.getTime();
    const proof = createOperatorProof({
      version: 1,
      credentialId: principal.credentialId,
      credentialEpoch: principal.credentialEpoch,
      grantId: principal.grantId,
      grantVersion: principal.grantVersion,
      accountId: principal.accountId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      clientId: principal.clientId,
      clientVersion: principal.clientVersion,
      clientMetadataSnapshotId: principal.clientMetadataSnapshotId,
      resource: principal.resource,
      method: request.method,
      ...(request.descriptorName ? { descriptorName: request.descriptorName } : {}),
      invocationId: request.invocationId,
      bodyDigest: request.bodyDigest,
      issuedToolScopes: [...principal.currentToolScopes],
      issuedOfflineAccess: principal.currentOfflineAccess,
      issuedAt,
      expiresAt: issuedAt + PROOF_TTL_MS,
      nonce: proofNonce,
    }, this.dependencies.secret);
    return { proof, ...(requiredScope ? { requiredScope } : {}) };
  }

  async list(input: { proof: OperatorMcpProof }): Promise<OperatorCatalogResponse> {
    const principal = await this.currentProofPrincipal(input.proof, "tools/list");
    try {
      const response = { tools: await this.dependencies.catalog.list({
        context: contextFor(principal, input.proof.invocationId, this.currentAuthorizationFor(principal)),
        scopes: new Set(principal.currentToolScopes),
      }) };
      await this.dependencies.invocations.recordOutcome({
        invocationId: input.proof.invocationId, status: "completed", safeOutcomeCode: "completed", now: this.now(),
      });
      await this.audit({
        principal, invocationId: input.proof.invocationId, method: "tools/list", descriptorName: null,
        capabilityShape: null, eventStatus: "success", outcome: "completed", reason: "completed",
      });
      return response;
    } catch (error) {
      await this.dependencies.invocations.recordOutcome({
        invocationId: input.proof.invocationId, status: "failed", safeOutcomeCode: "failed", now: this.now(),
      }).catch(() => undefined);
      await this.audit({
        principal, invocationId: input.proof.invocationId, method: "tools/list", descriptorName: null,
        capabilityShape: null, eventStatus: "failure", outcome: "failed", reason: "dependency_error",
      });
      throw error;
    }
  }

  async invoke(input: OperatorInvocationRequest): Promise<OperatorInvocationResponse> {
    const principal = await this.currentProofPrincipal(input.proof, "tools/call");
    let capabilityShape: "read" | "probe" | "act" | "propose" | null = null;
    try {
      const expectedBodyDigest = digestOperatorMcpCall({
        name: input.name,
        arguments: input.arguments,
        ...(input.operationId ? { operationId: input.operationId } : {}),
      });
      if (input.bodyDigest !== input.proof.bodyDigest || expectedBodyDigest !== input.bodyDigest) {
        throw new OperatorMcpApplicationError("invalid_proof");
      }
      if (input.proof.descriptorName !== input.name) throw new OperatorMcpApplicationError("unknown_tool");
      const descriptor = this.dependencies.catalog.descriptor(input.name);
      const disposition = descriptor?.mcpDisposition;
      if (!descriptor || !disposition || disposition.status !== "eligible") throw new OperatorMcpApplicationError("unknown_tool");
      capabilityShape = descriptor.shape;
      if (disposition.retry.requiresOperationId && !input.operationId) throw new OperatorMcpApplicationError("operation_required");
      const parsed = descriptor.inputSchema.safeParse(input.arguments);
      if (!parsed.success) throw new OperatorMcpApplicationError("invalid_arguments");
      const verificationCost = descriptor.verificationCost(parsed.data);
      const prepared = await this.dependencies.invocations.prepareInvocation({
        invocationId: input.proof.invocationId,
        operationId: input.operationId ?? null,
        descriptorName: input.name,
        shape: descriptor.shape,
        inputDigest: digestOperatorMcpInput({ secret: this.dependencies.secret, descriptorName: input.name, descriptorVersion: "1", value: parsed.data }),
        verificationCost,
        now: this.now(),
      });
      if (prepared.status === "conflict") throw new OperatorMcpApplicationError("operation_conflict");
      if (prepared.status === "budget_exhausted") throw new OperatorMcpApplicationError("budget_exhausted");
      if (prepared.status === "replay") {
        await this.dependencies.invocations.recordOutcome({
          invocationId: input.proof.invocationId,
          status: "completed",
          safeOutcomeCode: "replayed",
          ...(prepared.invocation.resultReference ? { resultReference: prepared.invocation.resultReference } : {}),
          now: this.now(),
        });
        await this.audit({
          principal, invocationId: input.proof.invocationId, method: "tools/call", descriptorName: input.name,
          capabilityShape, eventStatus: "success", outcome: "replayed", reason: "operation_replay",
        });
        return replayResponse(prepared.invocation);
      }
      await this.dependencies.invocations.markRunning({ invocationId: input.proof.invocationId, now: this.now() });
      const output = await this.dependencies.catalog.invoke({
        name: input.name,
        arguments: parsed.data,
        context: contextFor(principal, input.proof.invocationId, this.currentAuthorizationFor(principal)),
        scopes: new Set(principal.currentToolScopes),
        signal: AbortSignal.timeout(60_000),
      });
      const serialized = JSON.stringify(output);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) throw new OperatorMcpApplicationError("result_too_large");
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new OperatorMcpApplicationError("invalid_result");
      const reference = resultReference(output);
      await this.dependencies.invocations.recordOutcome({
        invocationId: input.proof.invocationId, status: "completed", safeOutcomeCode: "completed",
        ...(reference ? { resultReference: reference } : {}), now: this.now(),
      });
      await this.audit({
        principal,
        invocationId: input.proof.invocationId,
        method: "tools/call",
        descriptorName: input.name,
        capabilityShape: descriptor.shape,
        eventStatus: "success",
        outcome: "completed",
        reason: "completed",
      });
      return { structuredContent: output as Record<string, unknown>, content: [], safeOutcomeCode: "completed", ...(reference ? { resultReference: reference } : {}) };
    } catch (error) {
      const reason = error instanceof OperatorMcpApplicationError
        ? error.code
        : error instanceof OperatorMcpCatalogError ? error.code : "dependency_error";
      const refused = error instanceof OperatorMcpApplicationError
        && ["unknown_tool", "invalid_arguments", "operation_required", "operation_conflict", "budget_exhausted"].includes(error.code);
      await this.dependencies.invocations.recordOutcome({
        invocationId: input.proof.invocationId,
        status: refused ? "refused" : "failed",
        safeOutcomeCode: reason,
        now: this.now(),
      }).catch(() => undefined);
      await this.audit({
        principal, invocationId: input.proof.invocationId, method: "tools/call", descriptorName: input.name,
        capabilityShape, eventStatus: "failure", outcome: refused ? "refused" : "failed", reason,
      });
      throw error;
    }
  }
}
