import type {
  ClarificationOfferMappingOutcome,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationRoutineActivator,
  ConversationTraceStage,
  RecentClarificationReader,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  conversationRoutineActivatorFromCandidate,
  resolveEnginePendingClarification,
} from "./composition.js";
import { documentScopeFromClarificationCandidate } from "../../../retrieval/public.js";

export type PendingClarificationResolution =
  | {
      kind: "routine_activation";
      resolvedPending: true;
      suppressNewClarification: true;
      activator: ConversationRoutineActivator;
      mappingOutcome?: "accepted";
      mappingStage?: ConversationTraceStage;
    }
  | {
      kind: "retrieval_sense";
      resolvedPending: true;
      suppressNewClarification: true;
      documentScope: string[];
      originalQuery?: string;
      offerOutcome?: "accepted_alternative";
    }
  | {
      kind: "normal";
      resolvedPending: boolean;
      suppressNewClarification?: boolean;
      loopGuardCandidateIds?: string[];
      source?: string;
      offerOutcome?: "ignored";
      outcome?: "declined" | "expired";
      /** How a reply to an offer resolved, and the stage the turn records for it. */
      mappingOutcome?: ClarificationOfferMappingOutcome;
      mappingStage?: ConversationTraceStage;
    };

export const resolvePendingClarification = async (input: {
  store: ConversationClarificationStore;
  recentReader?: RecentClarificationReader;
  clarifier: ConversationClarifier;
  turn: TurnContext;
}): Promise<PendingClarificationResolution> => {
  const resolution = await resolveEnginePendingClarification(input);
  if (resolution.chosen?.source === "routine_activation") {
    const activator = conversationRoutineActivatorFromCandidate(resolution.chosen.candidate);
    if (activator) {
      return {
        kind: "routine_activation",
        resolvedPending: true,
        suppressNewClarification: true,
        activator,
        ...(resolution.mappingOutcome === "accepted" ? { mappingOutcome: resolution.mappingOutcome } : {}),
        ...(resolution.mappingStage ? { mappingStage: resolution.mappingStage } : {}),
      };
    }
  }
  if (resolution.chosen?.source === "retrieval_sense") {
    const documentScope = documentScopeFromClarificationCandidate(resolution.chosen.candidate);
    if (documentScope && documentScope.length > 0) {
      return {
        kind: "retrieval_sense",
        resolvedPending: true,
        suppressNewClarification: true,
        documentScope,
        ...(resolution.offerOutcome === "accepted_alternative"
          ? { offerOutcome: resolution.offerOutcome }
          : {}),
        ...(resolution.chosen.originalQuery ? { originalQuery: resolution.chosen.originalQuery } : {}),
      };
    }
  }
  return {
    kind: "normal",
    resolvedPending: resolution.resolvedPending,
    suppressNewClarification: resolution.suppressNewClarification,
    loopGuardCandidateIds: resolution.loopGuardCandidateIds,
    ...(resolution.offerOutcome === "ignored" && resolution.source ? { source: resolution.source } : {}),
    ...(resolution.offerOutcome === "ignored" ? { offerOutcome: resolution.offerOutcome } : {}),
    ...(resolution.outcome === "declined" || resolution.outcome === "expired"
      ? { outcome: resolution.outcome }
      : {}),
    ...(resolution.mappingOutcome ? { mappingOutcome: resolution.mappingOutcome } : {}),
    ...(resolution.mappingStage ? { mappingStage: resolution.mappingStage } : {}),
  };
};

/** The trace stage of a reply to a pending offer, when this turn resolved one. */
export const offerMappingStage = (resolution?: PendingClarificationResolution): ConversationTraceStage | undefined =>
  resolution && "mappingStage" in resolution ? resolution.mappingStage : undefined;
