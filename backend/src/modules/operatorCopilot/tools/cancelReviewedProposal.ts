import { z } from "zod";

import type { CopilotCurrentAuthorizationPort, CopilotToolDescriptor, CopilotToolInvocationContext } from "../contracts.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { REVIEWED_OPERATION_NOT_CANCELLABLE, REVIEWED_OPERATION_NOT_FOUND } from "../reviewedOperation.js";

const inputSchema = z.object({ proposalId: z.string().uuid() }).strict();
const outputSchema = z.object({ proposalId: z.string().uuid(), status: z.literal("dismissed") }).strict();

export interface CancelReviewedProposalPort {
  cancelMcpReviewedProposal(input: { workspaceId: string; accountId: string; operatorUserId: string; grantId: string; clientId: string; proposalId: string; currentAuthorization: CopilotCurrentAuthorizationPort }): Promise<{ readonly status: "dismissed" | "not_found" | "not_cancellable" }>;
}

const DESCRIPTION = "Cancel one pending reviewed operation a prepare_* tool created, bound to this MCP grant and client.";

type CancelReviewedProposalContext = Pick<CopilotToolInvocationContext, "workspaceId" | "accountId" | "operatorUserId" | "currentAuthorization">;

/** Turns the owner's refusals into correctable rejections for both the replay path and the live call. */
const cancel = async (
  canceller: CancelReviewedProposalPort,
  context: CancelReviewedProposalContext,
  binding: { grantId: string; clientId: string },
  proposalId: string,
): Promise<{ proposalId: string; status: "dismissed" }> => {
  const result = await canceller.cancelMcpReviewedProposal({
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    operatorUserId: context.operatorUserId,
    grantId: binding.grantId,
    clientId: binding.clientId,
    proposalId,
    currentAuthorization: context.currentAuthorization,
  });
  if (result.status === "not_found") throw notFound(REVIEWED_OPERATION_NOT_FOUND);
  if (result.status === "not_cancellable") throw badRequest(REVIEWED_OPERATION_NOT_CANCELLABLE);
  return { proposalId, status: result.status };
};

export const createCancelReviewedProposalTool = (canceller: CancelReviewedProposalPort): CopilotToolDescriptor => ({
  name: "cancel_reviewed_proposal", shape: "act", verificationCost: () => 0,
  uiLabel: "Cancelling reviewed operation", description: DESCRIPTION,
  contributingModule: "operatorCopilot", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"], inputSchema, outputSchema,
  // Cancellation stamps no receipt on the proposal, so a replay asks the owner again under the fresh
  // request's authority. The owner answers an already-dismissed proposal with its dismissed outcome.
  reconcileMcpInvocation: async ({ arguments: rawInput, context }) => {
    const { proposalId } = inputSchema.parse(rawInput);
    if (!context.operatorMcpGrantId || !context.operatorMcpClientId) return { status: "conflict" };
    const output = await cancel(canceller, context, { grantId: context.operatorMcpGrantId, clientId: context.operatorMcpClientId }, proposalId);
    return { status: "recovered", output };
  },
  createTool: (context) => ({ name: "cancel_reviewed_proposal", description: DESCRIPTION, inputSchema, outputSchema,
    invoke: async (rawInput) => {
      const { proposalId } = inputSchema.parse(rawInput);
      if (context.surface !== "mcp" || !context.operatorMcpGrantId || !context.operatorMcpClientId) throw new Error("MCP reviewed-operation binding is required");
      return cancel(canceller, context, { grantId: context.operatorMcpGrantId, clientId: context.operatorMcpClientId }, proposalId);
    },
  }),
});
