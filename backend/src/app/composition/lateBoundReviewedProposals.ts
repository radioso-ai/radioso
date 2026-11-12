import type { CancelReviewedProposalPort } from "../../modules/operatorCopilot/tools/cancelReviewedProposal.js";
import type { ReviewedProposalExecutionPort } from "../../modules/operatorCopilot/tools/reviewedProposalExecution.js";
import type { ReviewedProposalOutcomePort } from "../../modules/operatorCopilot/tools/reviewedProposalOutcome.js";
import type { CopilotProposalDetailReadPort } from "../../modules/operatorCopilot/service.js";

type ReviewedProposalService = ReviewedProposalExecutionPort & Required<ReviewedProposalOutcomePort> & CancelReviewedProposalPort & CopilotProposalDetailReadPort;

/**
 * The reviewed-proposal ports Ray's tool catalog needs from the copilot service, which is built
 * after the catalog. Each call reaches the service when it is made, and fails while the service
 * does not exist yet.
 */
export const lateBoundReviewedProposalPorts = (current: () => ReviewedProposalService | undefined): {
  readonly reviewedProposalExecution: ReviewedProposalExecutionPort;
  readonly reviewedProposalOutcome: Required<ReviewedProposalOutcomePort>;
  readonly cancelReviewedProposal: CancelReviewedProposalPort;
  readonly proposalDetail: CopilotProposalDetailReadPort;
} => {
  const built = (role: "execution" | "proposal"): ReviewedProposalService => {
    const service = current();
    if (!service) throw new Error(`Operator Copilot ${role} service is not initialized`);
    return service;
  };
  return {
    reviewedProposalExecution: {
      executeMcpReviewedProposal: async (input) => built("execution").executeMcpReviewedProposal(input),
    },
    reviewedProposalOutcome: {
      getMcpReviewedProposal: async (input) => built("execution").getMcpReviewedProposal(input),
      isDashboardReviewedProposal: async (input) => built("proposal").isDashboardReviewedProposal(input),
    },
    cancelReviewedProposal: {
      cancelMcpReviewedProposal: async (input) => built("execution").cancelMcpReviewedProposal(input),
    },
    proposalDetail: {
      getProposalDetail: async (input) => built("proposal").getProposalDetail(input),
    },
  };
};
