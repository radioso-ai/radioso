import type { CopilotMcpProposalRecoveryPort, CopilotProposal, CopilotToolInvocationContext } from "../contracts.js";
import { REVIEWED_AFFECTED_AGENTS_LIMIT, canonicalReviewedOperationDigest, withReviewedPresentation, withoutStoredPresentation } from "../reviewedOperation.js";
import { reviewedConfirmationRequirement } from "../reviewedOperation.js";
import type { ReviewedChangeEffect } from "../../../shared/domain/reviewedChangeEffect.js";
import { buildAbsoluteOperatorMcpProposalLink } from "../dashboardLinks.js";
import { copilotProposalOrigin, recordProposalCreated, type CopilotAgentLookupPort, type CopilotProposalToolDependencies } from "./shared.js";

export interface ReviewedPreparationDependencies extends CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
  readonly appBaseUrl?: string | null;
  /** Names the agents a preparation declares by id only. */
  readonly agentLookup?: CopilotAgentLookupPort;
}

/** The agents a change reaches, declared by the preparation that knows its own scope. */
interface ReviewedAffectedAgentsDeclaration {
  readonly agents: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  /** True when the owner knows more agents are affected than `agents` lists. */
  readonly truncated?: boolean;
}

const resolveAffectedAgents = async (deps: ReviewedPreparationDependencies, workspaceId: string, declared: ReviewedAffectedAgentsDeclaration) => {
  const unnamed = declared.agents.some((agent) => agent.name === undefined);
  const known = unnamed && deps.agentLookup ? new Map((await deps.agentLookup.listExisting(workspaceId)).map((agent) => [agent.id, agent.name])) : new Map<string, string>();
  const seen = new Set<string>();
  const named = declared.agents.flatMap((agent) => {
    const name = agent.name ?? known.get(agent.id);
    if (name === undefined || seen.has(agent.id)) return [];
    seen.add(agent.id);
    return [{ id: agent.id, name: name.slice(0, 200) }];
  });
  return { agents: named.slice(0, REVIEWED_AFFECTED_AGENTS_LIMIT), truncated: (declared.truncated ?? false) || named.length > REVIEWED_AFFECTED_AGENTS_LIMIT };
};

/** Generic persistence and recovery only: target owners provide every semantic value. */
export const persistReviewedPreparation = async (input: {
  readonly deps: ReviewedPreparationDependencies;
  readonly context: CopilotToolInvocationContext;
  readonly targetType: CopilotProposal["targetType"];
  readonly targetRef: unknown;
  readonly payload: unknown;
  readonly versionToken: string;
  readonly reviewSnapshot: unknown;
  readonly operation: string;
  readonly metadata?: Record<string, unknown>;
  readonly effect: ReviewedChangeEffect;
  /** Every preparation states who its change reaches, `[]` for a workspace-level one. */
  readonly affectedAgents: ReviewedAffectedAgentsDeclaration;
  /** A one-line, caller-authored statement of intent shown on the approval page. */
  readonly summary?: string;
  /** Whether the change alters who can reach an agent. */
  readonly reach?: boolean;
}) => {
  const reviewSnapshot = withReviewedPresentation(input.reviewSnapshot, {
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    affectedAgents: await resolveAffectedAgents(input.deps, input.context.workspaceId, input.affectedAgents),
    ...(input.reach === undefined ? {} : { reach: input.reach }),
  });
  const reviewDigest = canonicalReviewedOperationDigest({
    targetRef: input.targetRef,
    payload: input.payload,
    versionToken: input.versionToken,
    reviewSnapshot,
  });
  const now = input.deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.deps.reviewTtlMs ?? 15 * 60_000));
  const confirmationRequirement = reviewedConfirmationRequirement(input.effect);
  const proposal = await input.deps.proposalRepository.createProposal({
    workspaceId: input.context.workspaceId,
    operatorUserId: input.context.operatorUserId,
    origin: copilotProposalOrigin(input.context),
    targetType: input.targetType,
    targetRef: input.targetRef,
    payload: input.payload,
    versionToken: input.versionToken,
    evidence: null,
    reviewDigest,
    reviewSnapshot,
    expiresAt,
    confirmationRequirement,
    changeEffect: input.effect,
  });
  await recordProposalCreated(input.deps.auditService, input.context, proposal, {
    reviewed: true,
    operation: input.operation,
    ...input.metadata,
  });
  return { proposal, reviewDigest, expiresAt, confirmation: { requirement: confirmationRequirement, effect: input.effect, ...(confirmationRequirement === "signed_in_approval" ? { approvalUrl: buildAbsoluteOperatorMcpProposalLink(proposal.id, input.deps.appBaseUrl) } : {}) } };
};

export const reviewedPreparationConfirmation = (deps: Pick<ReviewedPreparationDependencies, "appBaseUrl">, proposal: CopilotProposal) => {
  if (!proposal.confirmationRequirement || !proposal.changeEffect) return null;
  return {
    requirement: proposal.confirmationRequirement,
    effect: proposal.changeEffect,
    ...(proposal.confirmationRequirement === "signed_in_approval" ? { approvalUrl: buildAbsoluteOperatorMcpProposalLink(proposal.id, deps.appBaseUrl) } : {}),
  };
};

export const recoverReviewedPreparation = (input: {
  readonly deps: ReviewedPreparationDependencies;
  readonly invocationId: string;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly operationId: string | null;
  readonly descriptorName: string;
  readonly inputDigest: string;
  readonly staleBefore: Date;
  readonly now: Date;
}) => input.operationId
  ? withoutStoredPresentation(input.deps.proposalRecovery).recoverOperatorMcpProposal({
    invocationId: input.invocationId, grantId: input.grantId, workspaceId: input.workspaceId,
    operatorUserId: input.operatorUserId, operationId: input.operationId,
    descriptorName: input.descriptorName, inputDigest: input.inputDigest,
    staleBefore: input.staleBefore, now: input.now,
  })
  : Promise.resolve({ status: "conflict" as const });
