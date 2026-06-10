import type {
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationRoutineActivator,
  RecentClarificationReader,
  TurnContext,
} from "@radioso/conversation-contract";
import { conversationRoutineActivatorFromCandidate } from "@radioso/conversation-defaults";
import { resolvePendingClarification as resolveEnginePendingClarification } from "@radioso/conversation-engine";
import { documentScopeFromClarificationCandidate } from "../../../retrieval/public.js";

export type PendingClarificationResolution =
  | {
      kind: "routine_activation";
      resolvedPending: true;
      suppressNewClarification: true;
      activator: ConversationRoutineActivator;
    }
  | {
      kind: "retrieval_sense";
      resolvedPending: true;
      suppressNewClarification: true;
      documentScope: string[];
    }
  | {
      kind: "normal";
      resolvedPending: boolean;
      suppressNewClarification?: boolean;
      loopGuardCandidateIds?: string[];
      outcome?: "declined" | "expired";
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
      };
    }
  }
  return {
    kind: "normal",
    resolvedPending: resolution.resolvedPending,
    suppressNewClarification: resolution.suppressNewClarification,
    loopGuardCandidateIds: resolution.loopGuardCandidateIds,
    ...(resolution.outcome === "declined" || resolution.outcome === "expired"
      ? { outcome: resolution.outcome }
      : {}),
  };
};
