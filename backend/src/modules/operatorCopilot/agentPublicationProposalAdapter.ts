import { z } from "zod";

import type { AgentRevisionService } from "../agents/public.js";
import type { CopilotAgentPublicationProposalAdapter, CopilotProposalApplyContext } from "./contracts.js";
import { isOwnerRefusal } from "./proposalVersioning.js";

export type AgentPublicationRevisionPort = Pick<AgentRevisionService, "state" | "createCandidate" | "detail" | "describeCandidateRelease" | "readCandidateReleaseChange" | "publish">;

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
export const createAgentPublicationProposalAdapter = (deps: { revisions: AgentPublicationRevisionPort }): CopilotAgentPublicationProposalAdapter => ({
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

  async preview(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = targetSchema.parse(rawTargetRef);
    const payload = payloadSchema.parse(rawPayload);
    const state = await deps.revisions.state(workspaceId, targetRef.agentId);
    return {
      targetLabel: "Agent publication",
      current: { draftGeneration: state.draft.generation, publishedRevisionId: state.publishedRevision?.id ?? null },
      proposed: { candidateRevisionId: targetRef.candidateRevisionId, ...payload },
    };
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
