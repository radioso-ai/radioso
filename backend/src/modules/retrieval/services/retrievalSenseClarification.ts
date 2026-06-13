import type {
  ClarificationCandidate,
  ClarificationDecision,
  ClarificationPolicy,
  ConversationTraceStage,
  PendingClarification,
} from "@radioso/conversation-contract";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { RetrievalPipelineResult } from "./retrievalPipelineService.js";
import {
  documentScopeFromClarificationCandidate,
  type RetrievalSenseClarificationCandidate,
} from "./senseGroupingService.js";
import {
  clarificationStage,
  decideClarification,
} from "./clarification/composition.js";

export interface RetrievalSenseDetectorPort {
  detect(input: {
    workspaceId: string;
    question: string;
    rankedCandidates: RetrievalPipelineResult["contexts"];
    conversationLanguage?: string;
    usageContext?: ModelCallUsageContext;
  }): Promise<RetrievalSenseClarificationCandidate[]>;
}

export type RetrievalSenseClarificationEffect =
  | {
      kind: "ask";
      candidates: ClarificationCandidate[];
      pending: Omit<PendingClarification, "askedEventId">;
      stage: ConversationTraceStage;
    }
  | {
      kind: "offer";
      candidates: ClarificationCandidate[];
      alternatives: ClarificationCandidate[];
      pending: Omit<PendingClarification, "askedEventId">;
      stage: ConversationTraceStage;
      documentScope?: string[];
    }
  | {
      kind: "proceed";
      candidates: ClarificationCandidate[];
      stage?: ConversationTraceStage;
      documentScope?: string[];
    };

export const evaluateRetrievalSenseClarification = async (input: {
  detector?: RetrievalSenseDetectorPort;
  workspaceId: string;
  rankedCandidates: RetrievalPipelineResult["contexts"];
  conversationId: string;
  messageId: string;
  originalQuery: string;
  conversationLanguage?: string;
  usageContext?: ModelCallUsageContext;
  policy: ClarificationPolicy;
  suppressAsk: boolean;
  suppressNewClarification?: boolean;
  loopGuardCandidateIds?: string[];
  expiresAt: Date;
}): Promise<RetrievalSenseClarificationEffect | null> => {
  if (!input.detector || input.suppressNewClarification) {
    return null;
  }

  const candidates = await input.detector.detect({
    workspaceId: input.workspaceId,
    question: input.originalQuery,
    rankedCandidates: input.rankedCandidates,
    conversationLanguage: input.conversationLanguage,
    usageContext: input.usageContext,
  });
  if (candidates.length === 0) {
    return null;
  }

  const decision = decideClarification(candidates, input.policy, {
    suppressAsk: input.suppressAsk,
    loopGuardCandidateIds: input.loopGuardCandidateIds,
  });
  if (decision.kind === "none") {
    return { kind: "proceed", candidates };
  }

  const labelFallbackCandidate = labelFallbackAutoPickCandidate(decision);
  if (labelFallbackCandidate) {
    const labelFallbackDecision: ClarificationDecision = {
      kind: "auto_pick",
      candidate: labelFallbackCandidate,
      reason: "clear_margin",
    };
    return {
      kind: "proceed",
      candidates,
      stage: clarificationStage({
        surface: "retrieval_sense",
        decision: labelFallbackDecision,
        consideredCandidates: candidates,
        reason: "label_fallback",
      }),
      documentScope: documentScopeFromClarificationCandidate(labelFallbackCandidate),
    };
  }

  const stage = clarificationStage({
    surface: "retrieval_sense",
    decision,
    consideredCandidates: candidates,
  });
  if (decision.kind === "soft_pick") {
    return {
      kind: "offer",
      candidates: [decision.candidate, ...decision.alternatives],
      alternatives: decision.alternatives,
      stage,
      documentScope: documentScopeFromClarificationCandidate(decision.candidate),
      pending: {
        sessionId: input.conversationId,
        source: "retrieval_sense",
        originalQuery: input.originalQuery,
        mode: "offer",
        candidates: [decision.candidate, ...decision.alternatives],
        status: "pending",
        expiresAt: input.expiresAt,
      },
    };
  }
  if (decision.kind !== "ask") {
    return {
      kind: "proceed",
      candidates,
      stage,
      documentScope: documentScopeFromClarificationCandidate(decision.candidate),
    };
  }

  return {
    kind: "ask",
    candidates: decision.candidates,
    stage,
    pending: {
      sessionId: input.conversationId,
      source: "retrieval_sense",
      originalQuery: input.originalQuery,
      mode: "ask",
      candidates: decision.candidates,
      status: "pending",
      expiresAt: input.expiresAt,
    },
  };
};

const labelFallbackAutoPickCandidate = (
  decision: ClarificationDecision,
): ClarificationCandidate | null => {
  if (decision.kind === "ask") {
    return decision.candidates.some(hasMissingLabel) ? decision.candidates[0] ?? null : null;
  }
  if (decision.kind === "soft_pick") {
    return [decision.candidate, ...decision.alternatives].some(hasMissingLabel) ? decision.candidate : null;
  }
  return null;
};

const hasMissingLabel = (candidate: ClarificationCandidate): boolean =>
  (candidate as { labelStatus?: unknown }).labelStatus === "missing";
