import { CopilotRepository } from "../../db/repositories/copilotRepository.js";
import type { CopilotReviewedReceiptPort } from "../../modules/operatorCopilot/contracts.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** Assembles the only cross-module transaction: owner write plus reviewed receipt settlement. */
export const createReviewedReceiptSettlement = (_db: Db): CopilotReviewedReceiptPort => ({
  commitHook: ({ proposalId, executionInvocationId, workspaceId, operatorUserId, claimedAt, toAppliedRef }) =>
    async (transaction, committed) => {
      const settled = await new CopilotRepository(transaction).settleMcpAppliedOn({
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
