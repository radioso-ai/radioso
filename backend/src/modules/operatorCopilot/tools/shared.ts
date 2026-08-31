import { z } from "zod";

import {
  copilotProposalTargetTypes,
  MAX_COPILOT_PROPOSAL_SUMMARY,
  type CopilotAnyProposalAdapter,
  type CopilotAuditPort,
  type CopilotEntityDescription,
  type CopilotProposal,
  type CopilotProposalAdapterRegistry,
  type CopilotProposalEvidence,
  type CopilotProposalTargetType,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { summarizeProposalEvidence } from "../proposalEvidence.js";
import { resolveProposalEvidence, type ProposalChange, type ProposalEvidenceDependencies } from "../services/proposalEvidenceService.js";

export interface CopilotAgentListItem {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly assistantBootstrapActive: boolean;
}

export interface CopilotAgentLookupPort {
  listExisting(workspaceId: string): Promise<ReadonlyArray<CopilotAgentListItem>>;
}

export const entity = (type: string, id: string | null | undefined) => id ? { type, id } : null;

/**
 * The sentence a card states, clamped to what its payload can hold. A tool composes this from
 * operator- and model-supplied text whose combined length no per-field bound can usefully constrain,
 * so the sentence is shortened here rather than the draft being refused - an over-long summary is a
 * display problem, and refusing the whole proposal over one would be a worse answer than eliding it.
 */
export const boundedSummary = (summary: string): string => {
  if (summary.length <= MAX_COPILOT_PROPOSAL_SUMMARY) return summary;
  // Sliced by code point, not by UTF-16 unit: cutting an emoji in half leaves a lone surrogate,
  // which survives the schema's length check and then makes Postgres reject the jsonb payload.
  const kept = Array.from(summary).slice(0, MAX_COPILOT_PROPOSAL_SUMMARY - 1);
  while (kept.length > 0 && kept.join("").length > MAX_COPILOT_PROPOSAL_SUMMARY - 1) kept.pop();
  return `${kept.join("").trimEnd()}\u2026`;
};

/**
 * The adapter a proposal tool writes through, looked up by the target type it owns. Every proposal
 * tool needs exactly this, so the lookup lives here rather than as a private copy per tool file.
 */
export const proposalAdapterFor = <TTargetType extends CopilotProposalTargetType>(
  adapters: CopilotProposalAdapterRegistry,
  targetType: TTargetType,
): Extract<CopilotAnyProposalAdapter, { targetType: TTargetType }> => {
  const adapter = adapters.find((candidate) => candidate.targetType === targetType);
  if (!adapter) throw new Error(`No copilot proposal adapter registered for ${targetType}`);
  return adapter as Extract<CopilotAnyProposalAdapter, { targetType: TTargetType }>;
};

/** What every proposal tool needs to persist and audit a draft, whatever it proposes. */
export interface CopilotProposalToolDependencies {
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: CopilotProposalAdapterRegistry;
  readonly auditService: CopilotAuditPort;
}

type NamedAgentInput = { readonly agentId?: string; readonly agentName?: string };

export const describeNamedAgent = async <TInput extends NamedAgentInput>(
  input: TInput,
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  agentLookup: CopilotAgentLookupPort | undefined,
): Promise<CopilotEntityDescription<TInput> | null> => {
  if (input.agentId) return entity("agent", input.agentId);
  if (!input.agentName) return entity("agent", context?.pageContext.agentId);
  if (!context || !agentLookup) return { kind: "not_found" };
  const candidates = (await agentLookup.listExisting(context.workspaceId))
    .filter((agent) => normalizeEntityName(agent.name) === normalizeEntityName(input.agentName!))
    .map((agent) => ({ type: "agent", id: agent.id, label: agent.name }));
  if (candidates.length !== 1) {
    return candidates.length === 0 ? { kind: "not_found" } : { kind: "ambiguous", candidates };
  }
  const candidate = candidates[0]!;
  return {
    kind: "resolved",
    entity: candidate,
    input: { ...input, agentId: candidate.id, agentName: undefined } as TInput,
  };
};

export const normalizeEntityName = (value: string): string => value.trim().normalize("NFKC").toLowerCase();
export const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;
export const requiredPageAgent = (agentId: string | null): string => {
  if (!agentId) throw new Error("No agent context is available");
  return agentId;
};
export const requiredPageConversation = (conversationId: string | null): string => {
  if (!conversationId) throw new Error("No conversation context is available");
  return conversationId;
};
export const requiredCopilotConversation = (context: { copilotConversationId?: string }): string => {
  const conversationId = context.copilotConversationId;
  if (!conversationId) throw new Error("Copilot proposal drafting requires a persisted conversation");
  return conversationId;
};
export const recordProposalCreated = async (
  auditService: CopilotAuditPort,
  context: { accountId: string; workspaceId: string },
  proposal: CopilotProposal,
): Promise<void> => {
  await auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: proposal.targetType } });
};

/**
 * One ceiling on how much a single draft may claim. A proposal citing dozens of replays is not a
 * more reviewed proposal; it is a card the operator stops reading.
 */
const MAX_CITED_EVIDENCE = 10;

/** Ids from prior replay_eval_case calls. The measurement itself is read server-side. */
export const citedEvidenceSchema = z.array(z.string().uuid()).max(MAX_CITED_EVIDENCE).optional();

export const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(copilotProposalTargetTypes),
  targetLabel: z.string(),
  summary: z.string(),
  /** Absent when the change was proposed unmeasured, so silence never reads as verified. */
  evidence: z.object({
    total: z.number().int().nonnegative(),
    improved: z.number().int().nonnegative(),
    regressed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }).strict().optional(),
  /** True only for a proposal that permanently deletes its target; absent for an ordinary update. */
  removal: z.boolean().optional(),
});

export interface CopilotProposalEvidenceDependencies {
  readonly proposalEvidence: ProposalEvidenceDependencies;
}

/** Resolves the ids a draft cites into the measurements stored on the proposal. */
export const citedProposalEvidence = async (
  deps: CopilotProposalEvidenceDependencies,
  context: { workspaceId: string; operatorUserId: string; copilotConversationId?: string },
  agentId: string,
  evidenceIds: ReadonlyArray<string> | undefined,
  change: ProposalChange,
): Promise<CopilotProposalEvidence | null> => resolveProposalEvidence(deps.proposalEvidence, {
  workspaceId: context.workspaceId,
  operatorUserId: context.operatorUserId,
  copilotConversationId: requiredCopilotConversation(context),
  agentId,
  evidenceIds: evidenceIds ?? [],
  change,
});

export const proposalEvidenceOutput = (evidence: CopilotProposalEvidence | null) =>
  evidence ? { evidence: summarizeProposalEvidence(evidence) } : {};
