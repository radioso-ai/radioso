import type { CopilotMcpProposalRecoveryPort, CopilotProposal, CopilotToolInvocationContext } from "../contracts.js";
import { canonicalReviewedOperationDigest } from "../reviewedOperation.js";
import { copilotProposalOrigin, recordProposalCreated, type CopilotProposalToolDependencies } from "./shared.js";

export interface ReviewedPreparationDependencies extends CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
}

/** Generic persistence and recovery only: target owners provide every semantic value. */
export const persistReviewedPreparation = async (input: {
  readonly deps: ReviewedPreparationDependencies;
  readonly context: CopilotToolInvocationContext;
  readonly targetType: CopilotProposal["targetType"];
  readonly targetRef: unknown;
  readonly payload: unknown;
  readonly versionToken: string;
  readonly reviewSnapshot: unknown;
  readonly operation: string;
  readonly metadata?: Record<string, unknown>;
}) => {
  const reviewDigest = canonicalReviewedOperationDigest({
    targetRef: input.targetRef,
    payload: input.payload,
    versionToken: input.versionToken,
    reviewSnapshot: input.reviewSnapshot,
  });
  const now = input.deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.deps.reviewTtlMs ?? 15 * 60_000));
  const proposal = await input.deps.proposalRepository.createProposal({
    workspaceId: input.context.workspaceId,
    operatorUserId: input.context.operatorUserId,
    origin: copilotProposalOrigin(input.context),
    targetType: input.targetType,
    targetRef: input.targetRef,
    payload: input.payload,
    versionToken: input.versionToken,
    evidence: null,
    reviewDigest,
    reviewSnapshot: input.reviewSnapshot,
    expiresAt,
  });
  await recordProposalCreated(input.deps.auditService, input.context, proposal, {
    reviewed: true,
    operation: input.operation,
    ...input.metadata,
  });
  return { proposal, reviewDigest, expiresAt };
};

export const recoverReviewedPreparation = (input: {
  readonly deps: ReviewedPreparationDependencies;
  readonly invocationId: string;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly operationId: string | null;
  readonly descriptorName: string;
  readonly inputDigest: string;
  readonly staleBefore: Date;
  readonly now: Date;
}) => input.operationId
  ? input.deps.proposalRecovery.recoverOperatorMcpProposal({
    invocationId: input.invocationId, grantId: input.grantId, workspaceId: input.workspaceId,
    operatorUserId: input.operatorUserId, operationId: input.operationId,
    descriptorName: input.descriptorName, inputDigest: input.inputDigest,
    staleBefore: input.staleBefore, now: input.now,
  })
  : Promise.resolve({ status: "conflict" as const });
