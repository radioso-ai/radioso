import { CopilotRepository } from "../../db/repositories/copilotRepository.js";
import type { CopilotProposalTargetTypeSet, CopilotReviewedReceiptPort } from "../../modules/operatorCopilot/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** Assembles the only cross-module transaction: owner write plus reviewed receipt settlement. */
export const createReviewedReceiptSettlement = (_db: Db, proposalTargetTypes: CopilotProposalTargetTypeSet): CopilotReviewedReceiptPort => ({
  commitHook: ({ proposalId, executionInvocationId, workspaceId, operatorUserId, claimedAt, toAppliedRef }) =>
    async (transaction, committed) => {
      const settled = await new CopilotRepository(transaction, proposalTargetTypes).settleMcpAppliedOn({
        proposalId,
        executionInvocationId,
        workspaceId,
        operatorUserId,
        claimedAt,
        appliedRef: toAppliedRef(committed),
        now: new Date(),
      }, transaction);
      if (!settled) throw new Error("reviewed_proposal_receipt_conflict");
    },
});
