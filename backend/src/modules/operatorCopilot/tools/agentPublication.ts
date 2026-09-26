import { z } from "zod";

import { requireCurrentCopilotPermissions } from "../authorization.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { canonicalReviewedOperationDigest } from "../reviewedOperation.js";
import { copilotProposalOrigin, recordProposalCreated, requiredPageAgent, type CopilotProposalToolDependencies } from "./shared.js";
import type { AgentPublicationRevisionPort } from "../agentPublicationProposalAdapter.js";

const id = z.string().uuid();
const readInput = z.object({ agentId: id.optional() }).strict();
const prepareInput = z.object({ agentId: id.optional() }).strict();
const publicationStateOutput = z.object({ draftGeneration: z.number().int().nonnegative(), publishedRevisionId: z.string().uuid().nullable(), canPublish: z.boolean() });
const publicationReviewOutput = z.object({ proposalId: z.string().uuid(), candidateRevisionId: z.string().uuid(), reviewDigest: z.string(), expiresAt: z.string().datetime(), draftGeneration: z.number().int().nonnegative(), publishedRevisionId: z.string().uuid().nullable(), validation: z.object({ status: z.literal("valid") }) });
const candidateDetailInput = z.object({ agentId: id, candidateRevisionId: id, offset: z.number().int().min(0).optional() }).strict();
const candidateDetailOutput = z.object({ candidateRevisionId: z.string().uuid(), basePublishedRevisionId: z.string().uuid().nullable(), validation: z.object({ status: z.literal("valid") }), changes: z.array(z.object({ field: z.string(), id: z.string(), before: z.string().nullable(), after: z.string().nullable(), truncated: z.boolean() })).max(40), truncated: z.boolean(), nextOffset: z.number().int().nonnegative().nullable() });
const candidateChangeInput = z.object({ agentId: id, candidateRevisionId: id, field: z.enum(["customInstruction", "directives", "routines", "contextVariableEnablements", "agentSkills"]), id: z.string().min(1).max(200), side: z.enum(["before", "after"]), offset: z.number().int().min(0), limit: z.number().int().min(1).max(2000) }).strict();
const candidateChangeOutput = z.object({ text: z.string().max(2000).nullable(), nextOffset: z.number().int().nonnegative().nullable(), totalLength: z.number().int().nonnegative() });

export interface AgentPublicationCopilotToolDependencies extends CopilotProposalToolDependencies {
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
    name: "prepare_agent_publication", shape: "propose", verificationCost: () => 0, uiLabel: "Preparing agent publication", contributingModule: "agentPublication", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.manage"],
    description: "Create an immutable publication candidate and reviewed proposal. It does not publish. If validation names a routine, use validate_routine or prepare_routine_structure before preparing publication again.", inputSchema: prepareInput, outputSchema: publicationReviewOutput,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: "prepare_agent_publication", inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "agent_publication" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ candidateRevisionId: id, draftGeneration: z.number().int().nonnegative(), publishedRevisionId: id.nullable(), validation: z.object({ status: z.literal("valid") }) }).safeParse(recovered.proposal.reviewSnapshot);
      if (!snapshot.success) return { status: "conflict" };
      return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } };
    },
    createTool: (context) => ({ name: "prepare_agent_publication", description: "Create an immutable publication candidate and reviewed proposal. It does not publish. If validation names a routine, use validate_routine or prepare_routine_structure before preparing publication again.", inputSchema: prepareInput, outputSchema: z.unknown(), invoke: async ({ agentId }) => {
      const selectedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const state = await deps.revisions.state(context.workspaceId, selectedAgentId);
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const candidate = await deps.revisions.createCandidate(context.workspaceId, selectedAgentId, state.draft.generation);
      const targetRef = { agentId: selectedAgentId, candidateRevisionId: candidate.id };
      const payload = { expectedDraftGeneration: state.draft.generation, expectedPublishedRevisionId: state.draft.basePublishedRevisionId };
      const now = deps.now?.() ?? new Date(); const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
      const reviewSnapshot = { candidateRevisionId: candidate.id, draftGeneration: payload.expectedDraftGeneration, publishedRevisionId: payload.expectedPublishedRevisionId, validation: { status: "valid" as const } };
      const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, reviewSnapshot });
      await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
      const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "agent_publication", targetRef, payload, versionToken: `${payload.expectedDraftGeneration}:${payload.expectedPublishedRevisionId ?? "none"}`, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
      await recordProposalCreated(deps.auditService, context, proposal);
      return { proposalId: proposal.id, reviewDigest, expiresAt: expiresAt.toISOString(), ...reviewSnapshot };
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
