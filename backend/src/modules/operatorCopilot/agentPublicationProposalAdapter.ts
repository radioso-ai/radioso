import { z } from "zod";

import type { AgentRevisionService } from "../agents/public.js";
import type { CopilotAgentPublicationProposalAdapter, CopilotProposalApplyContext } from "./contracts.js";
import { isOwnerRefusal } from "./proposalVersioning.js";

export type AgentPublicationRevisionPort = Pick<AgentRevisionService, "state" | "createCandidate" | "detail" | "describeCandidateRelease" | "describeCandidatePublicationReview" | "readCandidateReleaseChange" | "publish">;

const targetSchema = z.object({ agentId: z.string().uuid(), candidateRevisionId: z.string().uuid() }).strict();
const payloadSchema = z.object({ expectedDraftGeneration: z.number().int().nonnegative(), expectedPublishedRevisionId: z.string().uuid().nullable() }).strict();

interface AgentPublicationProposalPayload { readonly expectedDraftGeneration: number; readonly expectedPublishedRevisionId: string | null; }

const versionToken = (payload: AgentPublicationProposalPayload): string =>
  `${payload.expectedDraftGeneration}:${payload.expectedPublishedRevisionId ?? "none"}`;

const currentVersionToken = async (revisions: AgentPublicationRevisionPort, workspaceId: string, agentId: string): Promise<string> => {
  const state = await revisions.state(workspaceId, agentId);
  return versionToken({
    expectedDraftGeneration: state.draft.generation,
    expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
  });
};

/** Candidate preparation stays in the MCP tool; this adapter owns one standard apply path. */
export const createAgentPublicationProposalAdapter = (deps: {
  revisions: AgentPublicationRevisionPort;
  /** Names the agent a publication preview is about. */
  agents: { get(workspaceId: string, agentId: string): Promise<{ readonly name: string }> };
}): CopilotAgentPublicationProposalAdapter => ({
  targetType: "agent_publication",
  proposalDetailTargetRef: (rawTargetRef) => {
    const targetRef = targetSchema.parse(rawTargetRef);
    return { agentId: targetRef.agentId, candidateRevisionId: targetRef.candidateRevisionId };
  },

  async validatePayload(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = targetSchema.parse(rawTargetRef);
    const payload = payloadSchema.parse(rawPayload);
    await deps.revisions.detail(workspaceId, targetRef.agentId, targetRef.candidateRevisionId);
    return { targetRef, payload, versionToken: versionToken(payload) };
  },

  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = targetSchema.parse(rawTargetRef);
    return currentVersionToken(deps.revisions, workspaceId, targetRef.agentId);
  },

  /**
   * The change a publication makes: each field that differs between what is live and the candidate,
   * with the live value as current and the candidate's as proposed. A field the candidate adds has
   * no current value and one it removes has no proposed value. Fences and revision ids are the
   * adapter's own bookkeeping and stay out of the preview.
   */
  async preview(workspaceId, rawTargetRef) {
    const targetRef = targetSchema.parse(rawTargetRef);
    const [agent, review] = await Promise.all([
      deps.agents.get(workspaceId, targetRef.agentId),
      deps.revisions.describeCandidatePublicationReview(workspaceId, targetRef.agentId, targetRef.candidateRevisionId),
    ]);
    const current: Record<string, string> = {};
    const proposed: Record<string, string> = {};
    for (const change of review.changes) {
      const field = change.id === "agent" ? change.field : `${change.field} ${change.id}`;
      if (change.before !== null) current[field] = change.before;
      if (change.after !== null) proposed[field] = change.after;
    }
    return { targetLabel: `Publish ${agent.name}`, current, proposed };
  },

  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, suppliedVersionToken, context?: CopilotProposalApplyContext) {
    const targetRef = targetSchema.parse(rawTargetRef);
    const payload = payloadSchema.parse(rawPayload);
    if (suppliedVersionToken !== versionToken(payload)) return { outcome: "stale" as const };
    if (context?.surface !== "mcp" || !context.executionInvocationId) {
      return { outcome: "failed" as const, reason: "Publication requires a confirmed MCP execution receipt" };
    }
    try {
      const result = await deps.revisions.publish(workspaceId, targetRef.agentId, context.accountId, {
        revisionId: targetRef.candidateRevisionId,
        expectedDraftGeneration: payload.expectedDraftGeneration,
        expectedPublishedRevisionId: payload.expectedPublishedRevisionId,
        idempotencyKey: context.executionInvocationId,
      });
      return { outcome: "applied" as const, appliedRef: { publicationId: result.publicationId, revisionId: result.revisionId, publishedAt: result.publishedAt } };
    } catch (error) {
      if (error && typeof error === "object" && (error as { statusCode?: unknown }).statusCode === 409) return { outcome: "stale" as const };
      // `publish` throws only from its pre-write servability recheck (before `repository.publish`
      // runs at all) or from inside `repository.publish`'s own transaction, which rolls back
      // whatever it touched - so a non-stale owner refusal here proves nothing was published.
      if (isOwnerRefusal(error)) return { outcome: "failed" as const, reason: error.message };
      // The generic reviewed executor keeps its receipt claimed and reports an uncertain
      // outcome for an MCP failure here. It must not certify failure when the owner may have
      // committed the publication just before its response was lost.
      throw error;
    }
  },

  async reconcileMcpInterruptedApply(input) {
    const targetRef = targetSchema.parse(input.targetRef);
    const payload = payloadSchema.parse(input.payload);
    if (input.versionToken !== versionToken(payload)) return { outcome: "unknown" as const, reason: "The stored publication review is invalid." };
    try {
      // `publish` owns an idempotency record keyed by the execution receipt. Calling it before
      // inspecting current state is essential: the first attempt may have published successfully
      // and moved the draft fence before this process lost its response.
      const result = await deps.revisions.publish(input.workspaceId, targetRef.agentId, input.accountId, {
        revisionId: targetRef.candidateRevisionId,
        expectedDraftGeneration: payload.expectedDraftGeneration,
        expectedPublishedRevisionId: payload.expectedPublishedRevisionId,
        idempotencyKey: input.executionInvocationId,
      });
      return { outcome: "applied" as const, appliedRef: { publicationId: result.publicationId, revisionId: result.revisionId, publishedAt: result.publishedAt } };
    } catch (error) {
      if (error && typeof error === "object" && (error as { statusCode?: unknown }).statusCode === 409) return { outcome: "not_applied" as const };
      // A refusal cannot prove not_applied here: `publish` is fenced by draft generation and the
      // idempotency key, not by this apply claim, so an earlier attempt that already passed the
      // servability recheck can still commit. Rethrow; the executor logs it and answers uncertain.
      throw error;
    }
  },
});
