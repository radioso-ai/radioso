import type { AgentTraceEvent } from "../../shared/agent-runtime/index.js";
import {
  copilotProposalTargetTypes,
  type CopilotProposal,
  type CopilotProposalCard,
  type CopilotProposalEvidenceSummary,
} from "./contracts.js";
import { summarizeProposalEvidence } from "./proposalEvidence.js";

/**
 * A proposal card has two producers: the drafting tool's output during the turn, and the stored
 * proposal after a reload. They live side by side here so a field one of them states cannot be
 * forgotten by the other; every field either reads comes from what the drafting tool stored on the
 * payload.
 */

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textValue = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;

/** The card a stored proposal reloads as. */
export const presentProposalCard = (proposal: CopilotProposal): CopilotProposalCard => {
  const targetRef = asRecord(proposal.targetRef);
  const payload = asRecord(proposal.payload);
  // agent_setting is the only target type with no drafted name of its own - it targets an existing
  // setting key instead. Every other target type (present or future) proposes a named thing, so
  // this reads as "not agent_setting" rather than an OR-chain a new target type could miss.
  const targetLabel = proposal.targetType !== "agent_setting" ? textValue(payload.name, "") : textValue(targetRef.settingKey, "");
  // A payload states its own irreversibility, so a reloaded card warns about deletion without the
  // reader having to recognise each target type's word for it - the pairing that silently dropped
  // the warning when document removal arrived. The directive clause reads rows written before the
  // flag existed; every proposal drafted since carries `removesTarget`.
  const removal = payload.removesTarget === true || (proposal.targetType === "directive" && payload.op === "remove");
  // Read from the payload for the same reason as removal: the draft decided reach against the
  // settings it was made from, and a reader re-deriving it from field names would have to know
  // which of them mean reach.
  const reach = payload.changesReach === true;
  const card = { id: proposal.id, targetType: proposal.targetType, targetLabel, summary: textValue(payload.summary, textValue(payload.rationale, targetLabel)), status: proposal.status, reason: proposal.reason ?? null, ...(removal ? { removal: true as const } : {}), ...(reach ? { reach: true as const } : {}) };
  return proposal.evidence ? { ...card, evidence: summarizeProposalEvidence(proposal.evidence) } : card;
};

const isProposalOutput = (value: unknown): value is { proposalId: string; targetType: CopilotProposal["targetType"]; targetLabel: string; summary: string; evidence?: CopilotProposalEvidenceSummary; removal?: boolean; reach?: boolean } => {
  if (!value || typeof value !== "object") return false;
  const output = value as Record<string, unknown>;
  return typeof output.proposalId === "string" && (copilotProposalTargetTypes as ReadonlyArray<unknown>).includes(output.targetType) && typeof output.targetLabel === "string" && typeof output.summary === "string";
};

/** The card a drafting tool's output streams as, on the turn that drafted it. */
export const proposalCardFromTrace = (trace: AgentTraceEvent): CopilotProposalCard | null => {
  if (trace.kind !== "tool_call_completed" || !isProposalOutput(trace.output)) return null;
  const card = { id: trace.output.proposalId, targetType: trace.output.targetType, targetLabel: trace.output.targetLabel, summary: trace.output.summary, status: "pending" as const };
  // The draft tool already summarized what it measured, so the card states it on the turn that
  // drafted it rather than only after a reload. Same reasoning for removal (Finding 1, issue
  // triage next-ray-epic-issue): the tool already knows it drafted a deletion, so the card
  // carries that structural signal from the turn that drafted it, not only after a reload.
  return {
    ...card,
    ...(trace.output.evidence ? { evidence: trace.output.evidence } : {}),
    ...(trace.output.removal ? { removal: true as const } : {}),
    ...(trace.output.reach ? { reach: true as const } : {}),
  };
};
