import { z } from "zod";

import type { CopilotCurrentAuthorizationPort, CopilotToolDescriptor } from "../contracts.js";

const inputSchema = z.object({ proposalId: z.string().uuid() }).strict();
const outputSchema = z.object({ proposalId: z.string().uuid(), status: z.literal("dismissed") }).strict();

export interface CancelReviewedProposalPort {
  cancelMcpReviewedProposal(input: { workspaceId: string; accountId: string; operatorUserId: string; grantId: string; clientId: string; proposalId: string; currentAuthorization: CopilotCurrentAuthorizationPort }): Promise<{ status: "dismissed" }>;
}

export const createCancelReviewedProposalTool = (canceller: CancelReviewedProposalPort): CopilotToolDescriptor => ({
  name: "cancel_reviewed_proposal", shape: "act", verificationCost: () => 0,
  uiLabel: "Cancelling reviewed operation", description: "Cancel one pending reviewed operation bound to this MCP grant and client.",
  contributingModule: "operatorCopilot", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"], inputSchema, outputSchema,
  createTool: (context) => ({ name: "cancel_reviewed_proposal", description: "Cancel one pending reviewed operation bound to this MCP grant and client.", inputSchema, outputSchema,
    invoke: async (rawInput) => {
      const { proposalId } = inputSchema.parse(rawInput);
      if (context.surface !== "mcp" || !context.operatorMcpGrantId || !context.operatorMcpClientId) throw new Error("MCP reviewed-operation binding is required");
      return { proposalId, ...(await canceller.cancelMcpReviewedProposal({ workspaceId: context.workspaceId, accountId: context.accountId, operatorUserId: context.operatorUserId, grantId: context.operatorMcpGrantId, clientId: context.operatorMcpClientId, proposalId, currentAuthorization: context.currentAuthorization })) };
    },
  }),
});
