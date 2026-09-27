import { z } from "zod";

import { agentPublicationReviewedEffect } from "../../agents/public.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { reviewedConfirmationSchema } from "../reviewedOperation.js";
import { persistReviewedPreparation, reviewedPreparationConfirmation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";
import { requiredPageAgent, type CopilotProposalToolDependencies } from "./shared.js";
import type { AgentPublicationRevisionPort } from "../agentPublicationProposalAdapter.js";

const id = z.string().uuid();
const readInput = z.object({ agentId: id.optional() }).strict();
const prepareInput = z.object({ agentId: id.optional() }).strict();
const publicationStateOutput = z.object({ draftGeneration: z.number().int().nonnegative(), publishedRevisionId: z.string().uuid().nullable(), canPublish: z.boolean() });
const publicationChangeSchema = z.object({ field: z.string(), id: z.string(), before: z.string().nullable(), after: z.string().nullable(), truncated: z.boolean() }).strict();
/** Bound into the review digest so an approver's consent is to this exact summary and hash, not to whatever the candidate happens to contain. */
const publicationChangesSummarySchema = z.object({ changeCount: z.number().int().nonnegative(), changes: z.array(publicationChangeSchema).max(20), truncated: z.boolean() }).strict();
const publicationReviewOutput = z.object({ proposalId: z.string().uuid(), candidateRevisionId: z.string().uuid(), reviewDigest: z.string(), expiresAt: z.string().datetime(), confirmation: reviewedConfirmationSchema, draftGeneration: z.number().int().nonnegative(), publishedRevisionId: z.string().uuid().nullable(), validation: z.object({ status: z.literal("valid") }), changesSummary: publicationChangesSummarySchema, contentHash: z.string() });
const candidateDetailInput = z.object({ agentId: id, candidateRevisionId: id, offset: z.number().int().min(0).optional() }).strict();
const candidateDetailOutput = z.object({ candidateRevisionId: z.string().uuid(), basePublishedRevisionId: z.string().uuid().nullable(), validation: z.object({ status: z.literal("valid") }), changes: z.array(z.object({ field: z.string(), id: z.string(), before: z.string().nullable(), after: z.string().nullable(), truncated: z.boolean() })).max(40), truncated: z.boolean(), nextOffset: z.number().int().nonnegative().nullable() });
const candidateChangeInput = z.object({ agentId: id, candidateRevisionId: id, field: z.enum(["customInstruction", "directives", "routines", "contextVariableEnablements", "agentSkills"]), id: z.string().min(1).max(200), side: z.enum(["before", "after"]), offset: z.number().int().min(0), limit: z.number().int().min(1).max(2000) }).strict();
const candidateChangeOutput = z.object({ text: z.string().max(2000).nullable(), nextOffset: z.number().int().nonnegative().nullable(), totalLength: z.number().int().nonnegative() });

export interface AgentPublicationCopilotToolDependencies extends ReviewedPreparationDependencies, CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly revisions: AgentPublicationRevisionPort;
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
}

/** Unregistered descriptors; catalog ownership remains with the MCP delivery composition. */
export const createAgentPublicationCopilotTools = (deps: AgentPublicationCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_publication_state", shape: "read", verificationCost: () => 0, uiLabel: "Reading publication state", contributingModule: "agentPublication", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: "Read the saved draft generation and currently published revision for an agent.", inputSchema: readInput, outputSchema: publicationStateOutput,
    createTool: (context) => ({ name: "agent_publication_state", description: "Read the saved draft generation and currently published revision for an agent.", inputSchema: readInput, outputSchema: publicationStateOutput, invoke: async ({ agentId }) => { const state = await deps.revisions.state(context.workspaceId, agentId ?? requiredPageAgent(context.pageContext.agentId)); return { draftGeneration: state.draft.generation, publishedRevisionId: state.publishedRevision?.id ?? null, canPublish: state.canPublish }; } }),
    describeEntity: (input, context) => ({ type: "agent", id: (input as { agentId?: string }).agentId ?? context?.pageContext.agentId ?? "" }),
  },
  {
    name: "prepare_agent_publication", shape: "propose", verificationCost: () => 0, uiLabel: "Preparing agent publication", contributingModule: "agentPublication", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.manage"], surfaces: ["mcp"],
    description: "Create an immutable publication candidate and reviewed proposal. It does not publish. If validation names a routine, use validate_routine or prepare_routine_structure before preparing publication again.", inputSchema: prepareInput, outputSchema: publicationReviewOutput,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: "prepare_agent_publication", inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "agent_publication" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ candidateRevisionId: id, draftGeneration: z.number().int().nonnegative(), publishedRevisionId: id.nullable(), validation: z.object({ status: z.literal("valid") }), changesSummary: publicationChangesSummarySchema, contentHash: z.string() }).safeParse(recovered.proposal.reviewSnapshot);
      const confirmation = reviewedPreparationConfirmation(deps, recovered.proposal);
      if (!snapshot.success || !confirmation) return { status: "conflict" };
      return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), confirmation, ...snapshot.data } };
    },
    createTool: (context) => ({ name: "prepare_agent_publication", description: "Create an immutable publication candidate and reviewed proposal. It does not publish. If validation names a routine, use validate_routine or prepare_routine_structure before preparing publication again.", inputSchema: prepareInput, outputSchema: z.unknown(), invoke: async ({ agentId }) => {
      const selectedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const state = await deps.revisions.state(context.workspaceId, selectedAgentId);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const candidate = await deps.revisions.createCandidate(context.workspaceId, selectedAgentId, state.draft.generation);
      const publicationReview = await deps.revisions.describeCandidatePublicationReview(context.workspaceId, selectedAgentId, candidate.id);
      const targetRef = { agentId: selectedAgentId, candidateRevisionId: candidate.id };
      const payload = { expectedDraftGeneration: state.draft.generation, expectedPublishedRevisionId: state.draft.basePublishedRevisionId };
      const reviewSnapshot = {
        candidateRevisionId: candidate.id, draftGeneration: payload.expectedDraftGeneration, publishedRevisionId: payload.expectedPublishedRevisionId, validation: { status: "valid" as const },
        changesSummary: { changeCount: publicationReview.changeCount, changes: publicationReview.changes, truncated: publicationReview.changesTruncated },
        contentHash: publicationReview.contentHash,
      };
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const stored = await persistReviewedPreparation({ deps, context, targetType: "agent_publication", targetRef, payload, versionToken: `${payload.expectedDraftGeneration}:${payload.expectedPublishedRevisionId ?? "none"}`, reviewSnapshot, operation: "prepare_agent_publication", effect: agentPublicationReviewedEffect });
      return { proposalId: stored.proposal.id, reviewDigest: stored.reviewDigest, expiresAt: stored.expiresAt.toISOString(), confirmation: stored.confirmation, ...reviewSnapshot };
    }}),
    describeEntity: (input, context) => ({ type: "agent", id: (input as { agentId?: string }).agentId ?? context?.pageContext.agentId ?? "" }),
  },
  {
    name: "agent_publication_candidate", shape: "read", verificationCost: () => 0, uiLabel: "Reading publication candidate", contributingModule: "agentPublication", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: "Read the immutable candidate and its publication fences.", inputSchema: candidateDetailInput, outputSchema: candidateDetailOutput,
    createTool: (context) => ({ name: "agent_publication_candidate", description: "Read the immutable candidate and its publication fences.", inputSchema: candidateDetailInput, outputSchema: candidateDetailOutput, invoke: async ({ agentId, candidateRevisionId, offset }) => deps.revisions.describeCandidateRelease(context.workspaceId, agentId, candidateRevisionId, { offset, limit: 40 }) }),
    describeEntity: (input) => ({ type: "agent", id: (input as { agentId: string }).agentId }),
  },
  {
    name: "agent_publication_candidate_change", shape: "read", verificationCost: () => 0, uiLabel: "Reading publication change", contributingModule: "agentPublication", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: "Read the complete before and after values for a truncated candidate change.", inputSchema: candidateChangeInput, outputSchema: candidateChangeOutput,
    createTool: (context) => ({ name: "agent_publication_candidate_change", description: "Read the complete before and after values for a truncated candidate change.", inputSchema: candidateChangeInput, outputSchema: candidateChangeOutput, invoke: async ({ agentId, candidateRevisionId, field, id: changeId, side, offset, limit }) => deps.revisions.readCandidateReleaseChange(context.workspaceId, agentId, candidateRevisionId, { field, id: changeId, side, offset, limit }) }),
    describeEntity: (input) => ({ type: "agent", id: (input as { agentId: string }).agentId }),
  },
];
