import type { OwnerCommitHook } from "../../shared/infra/kysely/types.js";
import type { CopilotProposalApplyContext, CopilotReviewedReceiptPort } from "./contracts.js";
import { isOwnerRefusal, isStale, staleReason } from "./proposalVersioning.js";

/** Binds an owner CAS to the exact reviewed-execution receipt without leaking receipt rules to it. */
export const reviewedCommitHook = <TCommitted>(
  receipt: CopilotReviewedReceiptPort | undefined,
  context: CopilotProposalApplyContext | undefined,
  workspaceId: string,
  toAppliedRef: (committed: TCommitted) => unknown,
): OwnerCommitHook<TCommitted> | undefined => {
  if (!receipt || context?.surface !== "mcp" || !context.proposalId || !context.executionInvocationId
    || !context.operatorUserId || !context.applyClaimedAt) return undefined;
  return receipt.commitHook({
    proposalId: context.proposalId,
    executionInvocationId: context.executionInvocationId,
    workspaceId,
    operatorUserId: context.operatorUserId,
    claimedAt: context.applyClaimedAt,
    toAppliedRef,
  });
};

/** Only deterministic owner refusals become failed. Infrastructure errors deliberately escape. */
export const reviewedApplyError = (error: unknown, staleFields: readonly string[] = []) => {
  if (isStale(error)) return { outcome: "stale" as const, reason: staleReason(error, staleFields) };
  if (isOwnerRefusal(error)) return { outcome: "failed" as const, reason: error.message };
  throw error;
};
