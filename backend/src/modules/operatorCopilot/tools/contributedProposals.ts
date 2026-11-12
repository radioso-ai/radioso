import { z } from "zod";

import { requireCurrentCopilotPermissions } from "../authorization.js";
import type { CopilotToolContribution } from "../contribution.js";
import type { CopilotAuditPort, CopilotToolDescriptor } from "../contracts.js";
import {
  copilotProposalPresentationSchema,
  type CopilotContributedProposalDraft,
  type CopilotProposalAdapterContribution,
} from "../proposalContribution.js";
import type { CopilotRepositoryPort } from "../service.js";
import { boundedSummary, copilotProposalOrigin, proposalOutputSchemaFor, recordProposalCreated } from "./shared.js";

interface ContributedProposalToolDependencies {
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly auditService: CopilotAuditPort;
}

const draftSchema = z.object({
  targetRef: z.unknown(),
  change: z.unknown(),
  versionToken: z.string().min(1).max(500),
  targetLabel: z.string().min(1).max(300),
  summary: z.string().min(1),
  presentation: copilotProposalPresentationSchema,
  removesTarget: z.boolean().optional(),
});

/** An adapter is compiled elsewhere, so its draft is checked before anything is stored. */
const parseDraft = (targetType: string, draft: CopilotContributedProposalDraft) => {
  const parsed = draftSchema.safeParse(draft);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");
  throw new Error(`The "${targetType}" proposal adapter drafted an invalid proposal: ${issues}`);
};

const MCP_EXCLUSION_REASON = "A contributed proposal is drafted for review in the dashboard; the Operator MCP surface has no reviewed transport contract for a contributed target type.";

const createContributedProposalDescriptor = (
  contribution: CopilotProposalAdapterContribution,
  deps: ContributedProposalToolDependencies,
): CopilotToolDescriptor => {
  const { adapter, tool, moduleId } = contribution;
  const manage = [...adapter.permissions.manage];
  const outputSchema = proposalOutputSchemaFor([adapter.targetType]).extend({ presentation: copilotProposalPresentationSchema });
  const shared = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema };
  return {
    ...shared,
    shape: "propose",
    // Drafting runs no replay; the adapter's draft is its own module's read.
    verificationCost: () => 0,
    uiLabel: tool.uiLabel,
    contributingModule: moduleId,
    capabilityProvenance: tool.capabilityProvenance,
    mcpDisposition: { status: "excluded", reason: MCP_EXCLUSION_REASON },
    dashboardSubject: { type: "proposal" },
    requiredPermissions: manage,
    createTool: (context) => ({
      ...shared,
      invoke: async (rawInput) => {
        const input = tool.inputSchema.parse(rawInput);
        await requireCurrentCopilotPermissions(context, manage);
        const draft = parseDraft(adapter.targetType, await adapter.draft(input, {
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
        }));
        const summary = boundedSummary(draft.summary);
        const removal = draft.removesTarget === true;
        await requireCurrentCopilotPermissions(context, manage);
        // The card's fields sit beside the adapter's change, never inside it: both card producers
        // read them from here, and the adapter is handed back only its change.
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          origin: copilotProposalOrigin(context),
          targetType: adapter.targetType,
          targetRef: draft.targetRef,
          payload: { name: draft.targetLabel, summary, presentation: draft.presentation, ...(removal ? { removesTarget: true } : {}), change: draft.change },
          versionToken: draft.versionToken,
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: adapter.targetType,
          targetLabel: draft.targetLabel,
          summary,
          presentation: draft.presentation,
          ...(removal ? { removal: true } : {}),
        };
      },
    }),
  };
};

/**
 * The propose tool Ray offers for each contributed adapter, as tool contributions: the catalog then
 * holds them to the same governance a contributed read or act gets, against the identities their
 * contribution declares.
 */
export const createContributedProposalToolContributions = (
  contributions: ReadonlyArray<CopilotProposalAdapterContribution>,
  deps: ContributedProposalToolDependencies,
): CopilotToolContribution[] => contributions.map((contribution) => ({
  moduleId: contribution.moduleId,
  descriptors: [createContributedProposalDescriptor(contribution, deps)],
  ...(contribution.operationPermissions ? { operationPermissions: contribution.operationPermissions } : {}),
  ...(contribution.applicationPrimitives ? { applicationPrimitives: contribution.applicationPrimitives } : {}),
}));
