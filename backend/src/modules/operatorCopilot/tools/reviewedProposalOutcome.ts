import { z } from "zod";

import type { CopilotCurrentAuthorizationPort, CopilotToolDescriptor } from "../contracts.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { REVIEWED_OPERATION_NOT_FOUND } from "../reviewedOperation.js";

const inputSchema = z.object({
  proposalId: z.string().uuid(),
  reviewDetail: z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(4_000) }).strict().optional(),
}).strict();
const outputSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.enum(["pending", "applied", "dismissed", "failed", "stale"]),
  reviewDigest: z.string(),
  expiresAt: z.string().datetime().nullable(),
  currentVersionMatches: z.boolean(),
  appliedRef: z.unknown(),
  review: z.unknown(),
  reviewDetail: z.object({ text: z.string(), nextOffset: z.number().int().nullable(), totalLength: z.number().int().nonnegative() }).strict().optional(),
}).strict();

const boundedSnapshot = (value: unknown): { readonly visible: unknown; readonly full: unknown } | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!("fullReview" in snapshot)) return null;
  const { fullReview, ...visible } = snapshot;
  return { visible, full: fullReview };
};

export interface ReviewedProposalOutcomePort {
  getMcpReviewedProposal(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly operatorUserId: string;
    readonly grantId: string;
    readonly clientId: string;
    readonly proposalId: string;
    readonly currentAuthorization: CopilotCurrentAuthorizationPort;
  }): Promise<{
    readonly proposal: {
      readonly id: string;
      readonly status: "pending" | "applied" | "dismissed" | "failed" | "stale";
      readonly reviewDigest: string | null;
      readonly expiresAt: Date | null;
      readonly appliedRef: unknown;
      readonly reviewSnapshot: unknown;
    };
    readonly currentVersionMatches: boolean;
  } | null>;
  isDashboardReviewedProposal?(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly operatorUserId: string;
    readonly proposalId: string;
    readonly currentAuthorization: import("../contracts.js").CopilotCurrentAuthorizationPort;
  }): Promise<boolean>;
}

/** Reconciles the exact stored review and outcome; a proposal id alone never grants access. */
export const createReviewedProposalOutcomeTool = (outcomes: ReviewedProposalOutcomePort): CopilotToolDescriptor => ({
  name: "reviewed_proposal_outcome",
  shape: "read",
  verificationCost: () => 0,
  uiLabel: "Reading reviewed operation outcome",
  description: "Read the exact stored review and current outcome of one reviewed operation a prepare_* tool created. It does not execute or refresh the review.",
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "proposal" },
  requiredPermissions: [],
  inputSchema,
  outputSchema,
  createTool: (context) => ({
    name: "reviewed_proposal_outcome",
    description: "Read the exact stored review and current outcome of one reviewed operation a prepare_* tool created. It does not execute or refresh the review.",
    inputSchema,
    outputSchema,
    invoke: async (rawInput) => {
      const input = inputSchema.parse(rawInput);
      if (context.surface !== "mcp" || !context.operatorMcpGrantId || !context.operatorMcpClientId) {
        throw new Error("MCP reviewed-operation binding is required");
      }
      const outcome = await outcomes.getMcpReviewedProposal({
        workspaceId: context.workspaceId,
        accountId: context.accountId,
        operatorUserId: context.operatorUserId,
        grantId: context.operatorMcpGrantId,
        clientId: context.operatorMcpClientId,
        proposalId: input.proposalId,
        currentAuthorization: context.currentAuthorization,
      });
      if (!outcome || !outcome.proposal.reviewDigest || outcome.proposal.reviewSnapshot === null) {
        if (await outcomes.isDashboardReviewedProposal?.({
          workspaceId: context.workspaceId, accountId: context.accountId, operatorUserId: context.operatorUserId,
          proposalId: input.proposalId, currentAuthorization: context.currentAuthorization,
        })) throw badRequest("This is a dashboard-reviewed proposal. Read it with proposal_detail.");
        throw notFound(REVIEWED_OPERATION_NOT_FOUND);
      }
      const bounded = boundedSnapshot(outcome.proposal.reviewSnapshot);
      if (input.reviewDetail && !bounded) throw badRequest("Complete review detail is not available for this reviewed operation.");
      const full = input.reviewDetail && bounded ? JSON.stringify(bounded.full) : null;
      const reviewDetail = full === null ? undefined : {
        text: full.slice(input.reviewDetail!.offset, input.reviewDetail!.offset + input.reviewDetail!.limit),
        nextOffset: input.reviewDetail!.offset + input.reviewDetail!.limit < full.length ? input.reviewDetail!.offset + input.reviewDetail!.limit : null,
        totalLength: full.length,
      };
      return outputSchema.parse({
        proposalId: outcome.proposal.id,
        status: outcome.proposal.status,
        reviewDigest: outcome.proposal.reviewDigest,
        expiresAt: outcome.proposal.expiresAt?.toISOString() ?? null,
        currentVersionMatches: outcome.currentVersionMatches,
        appliedRef: outcome.proposal.appliedRef,
        review: bounded?.visible ?? outcome.proposal.reviewSnapshot,
        ...(reviewDetail ? { reviewDetail } : {}),
      });
    },
  }),
});
