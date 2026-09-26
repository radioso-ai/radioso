import { z } from "zod";

import { notFound } from "../../../shared/domain/errors.js";
import { buildOperatorMcpProposalLink } from "../dashboardLinks.js";
import { copilotProposalTargetTypes, type CopilotToolDescriptor } from "../contracts.js";
import { CopilotAuthorizationError, type CopilotProposalDetailReadPort } from "../service.js";

const inputSchema = z.object({ proposalId: z.string().uuid() }).strict();
const targetSchema = z.object({
  agentId: z.string().uuid().nullable(),
  directiveId: z.string().uuid().nullable(),
  routineId: z.string().uuid().nullable(),
  skillId: z.string().uuid().nullable(),
  documentId: z.string().uuid().nullable(),
  settingKey: z.string().max(200).nullable(),
  label: z.string().max(300),
  reference: z.record(z.union([z.string().max(300), z.boolean(), z.null()])),
}).strict();
const outputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(copilotProposalTargetTypes),
  target: targetSchema,
  summary: z.string().max(2_000),
  draftedChange: z.unknown(),
  status: z.enum(["pending", "applied", "dismissed", "failed", "stale"]),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  failureReason: z.string().max(2_000).nullable(),
  reviewUrl: z.string().max(500).nullable(),
  reviewedOperation: z.boolean(),
  nextStep: z.enum(["reviewed_proposal_outcome", "dashboard_review", "none"]),
}).strict();

export const createProposalDetailTool = (details: CopilotProposalDetailReadPort): CopilotToolDescriptor => ({
  name: "proposal_detail", shape: "read", verificationCost: () => 0, uiLabel: "Reading proposal detail",
  description: "Read one proposal's dashboard-safe review, draft, and outcome. Reviewed operations continue with reviewed_proposal_outcome.",
  contributingModule: "operatorCopilot", dashboardSubject: { type: "proposal" }, requiredPermissions: [], inputSchema, outputSchema,
  createTool: (context) => ({
    name: "proposal_detail", description: "Read one proposal's dashboard-safe review, draft, and outcome. Reviewed operations continue with reviewed_proposal_outcome.", inputSchema, outputSchema,
    invoke: async (rawInput) => {
      const { proposalId } = inputSchema.parse(rawInput);
      let result;
      try {
        result = await details.getProposalDetail({ workspaceId: context.workspaceId, accountId: context.accountId, operatorUserId: context.operatorUserId, proposalId, currentAuthorization: context.currentAuthorization });
      } catch (error) {
        if (error instanceof CopilotAuthorizationError) throw notFound("Copilot proposal not found");
        throw error;
      }
      if (!result) throw notFound("Copilot proposal not found");
      return outputSchema.parse({
        ...result,
        createdAt: result.createdAt.toISOString(), decidedAt: result.decidedAt?.toISOString() ?? null,
        reviewUrl: result.status === "pending" ? buildOperatorMcpProposalLink(result.proposalId) : null,
        nextStep: result.reviewedOperation ? "reviewed_proposal_outcome" : result.status === "pending" ? "dashboard_review" : "none",
      });
    },
  }),
});
