import { z } from "zod";

import type { CopilotCurrentAuthorizationPort, CopilotToolDescriptor } from "../contracts.js";
import { reviewedChangeEffectSchema, reviewedOperationDigestPattern } from "../reviewedOperation.js";

const inputSchema = z.object({
  proposalId: z.string().uuid(),
  reviewDigest: z.string().regex(reviewedOperationDigestPattern),
}).strict();

const outputSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.enum(["applied", "stale", "failed", "refused", "uncertain", "approval_required"]),
  appliedRef: z.unknown().optional(),
  reason: z.string().optional(),
  approval: z.object({ url: z.string().max(2048), expiresAt: z.string().datetime(), effect: reviewedChangeEffectSchema }).strict().optional(),
}).strict();

type ReviewedProposalExecutionResult = Omit<z.infer<typeof outputSchema>, "proposalId">;

export interface ReviewedProposalExecutionPort {
  executeMcpReviewedProposal(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly operatorUserId: string;
    readonly proposalId: string;
    readonly reviewDigest: string;
    readonly executionInvocationId: string;
    /**
     * The MCP request making this attempt. It is the execution receipt's own request on a first
     * call, and a retry when one reconciles that receipt; the claim records it as the receipt's
     * attempt, so only it records the receipt's outcome from then on.
     */
    readonly attemptInvocationId: string;
    readonly grantId: string;
    readonly clientId: string;
    /** Request-bound MCP credential/grant authorization, rechecked by the owner before mutation. */
    readonly currentAuthorization: CopilotCurrentAuthorizationPort;
    /** Set only for an accepted elicitation retry; bounds a wait for the approval before answering. */
    readonly awaitApprovalMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<ReviewedProposalExecutionResult>;
}

/** The client confirms the reviewed digest before calling this write-scoped descriptor. */
export const createReviewedProposalExecutionTool = (
  executor: ReviewedProposalExecutionPort,
): CopilotToolDescriptor => ({
  name: "execute_reviewed_proposal",
  shape: "act",
  verificationCost: () => 0,
  uiLabel: "Applying reviewed operation",
  description: "Apply a previously prepared operation after the MCP client has shown and confirmed its exact review digest. Operations that go live, cannot be undone, or spend quota return approval_required until their owner approves the exact review in Radioso.",
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "proposal" },
  surfaces: ["mcp"],
  requiredPermissions: [],
  inputSchema,
  outputSchema,
  reconcileMcpInvocation: async ({ invocation, arguments: rawInput, context, staleBefore, signal }) => {
    const input = inputSchema.parse(rawInput);
    if (!context.operatorMcpInvocationId || !context.operatorMcpGrantId || !context.operatorMcpClientId) return { status: "conflict" };
    // An open receipt whose proof is inside the recovery lease belongs to its first runner: a
    // retry that reached the owner first could claim under that receipt before the runner does.
    if (invocation.status === "admitted" || invocation.status === "running") {
      if (!invocation.proofConsumedAt) return { status: "conflict" };
      if (invocation.proofConsumedAt.getTime() > staleBefore.getTime()) return { status: "in_progress" };
    }
    const result = await executor.executeMcpReviewedProposal({
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operatorUserId: context.operatorUserId,
      proposalId: input.proposalId,
      reviewDigest: input.reviewDigest,
      // The durable proposal is bound to the first receipt. A fresh request provides only
      // current authority; it must never become a replacement execution receipt. A claim makes it
      // that receipt's attempt instead, which fences out the request it took the receipt over from.
      executionInvocationId: invocation.id,
      attemptInvocationId: context.operatorMcpInvocationId,
      grantId: context.operatorMcpGrantId,
      clientId: context.operatorMcpClientId,
      currentAuthorization: context.currentAuthorization,
      awaitApprovalMs: context.awaitApprovalMs,
      signal,
    });
    // `recovered` settles the original receipt, so only a durable outcome may take that path. The
    // snapshot above can be stale: a concurrent retry's claim may have reopened the receipt, and
    // settling it from here would fence that retry's atomic owner+receipt settlement.
    if (result.status === "uncertain") return { status: "unconfirmed", output: { proposalId: input.proposalId, ...result } };
    return { status: "recovered", output: { proposalId: input.proposalId, ...result } };
  },
  createTool: (context) => ({
    name: "execute_reviewed_proposal",
    description: "Apply a previously prepared operation after the MCP client has shown and confirmed its exact review digest. Operations that go live, cannot be undone, or spend quota return approval_required until their owner approves the exact review in Radioso.",
    inputSchema,
    outputSchema,
    invoke: async (rawInput, options) => {
      const input = inputSchema.parse(rawInput);
      if (context.surface !== "mcp" || !context.operatorMcpInvocationId || !context.operatorMcpGrantId || !context.operatorMcpClientId) {
        throw new Error("MCP execution receipt is required");
      }
      const result = await executor.executeMcpReviewedProposal({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        proposalId: input.proposalId,
        reviewDigest: input.reviewDigest,
        executionInvocationId: context.operatorMcpInvocationId,
        attemptInvocationId: context.operatorMcpInvocationId,
        grantId: context.operatorMcpGrantId,
        clientId: context.operatorMcpClientId,
        currentAuthorization: context.currentAuthorization,
        awaitApprovalMs: context.awaitApprovalMs,
        signal: options?.signal,
      });
      return { proposalId: input.proposalId, ...result };
    },
  }),
});
