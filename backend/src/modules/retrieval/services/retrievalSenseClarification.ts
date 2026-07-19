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

  // Complementary facets are not competing senses: the visitor asked one question
  // whose answer spans several documents (e.g. "what X is" + "how to learn X").
  // Clarifying would be over-asking, so proceed over all ranked chunks — that IS
  // the combined answer — with no document scoping. Conservative: only when the
  // gateway judged the whole set complementary (absent/failed ⇒ exclusive path).
  if (candidates.every((candidate) => candidate.relationship === "complementary")) {
    return {
      kind: "proceed",
      candidates,
      stage: clarificationStage({
        surface: "retrieval_sense",
        decision: { kind: "none" },
        consideredCandidates: candidates,
        reason: "compatible_facets",
      }),
    };
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

const normalizeChoice = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * A candidate is presentable only when its label is a real visitor-facing reading:
 * non-empty and not structurally degenerate (equal to its own id). This is a pure
 * structural guard — no English vocabulary — so it holds in any conversation language.
 */
const isPresentableCandidate = (candidate: ClarificationCandidate): boolean => {
  const label = candidate.label?.trim() ?? "";
  return label.length > 0 && normalizeChoice(label) !== normalizeChoice(candidate.id);
};

export const presentableSenseCandidates = <T extends ClarificationCandidate>(candidates: T[]): T[] =>
  candidates.filter(isPresentableCandidate);

/**
 * A phrased lead-in is degenerate when it is empty or collapses to a single bare
 * option label / candidate id (the production failure this guards against). The
 * numbered option list, when present, keeps the normalized string from matching a
 * single label, so a real question is never flagged.
 */
const isDegeneratePhrasing = (answer: string, candidates: ClarificationCandidate[]): boolean => {
  const normalized = normalizeChoice(answer);
  if (!normalized) {
    return true;
  }
  return candidates.some(
    (candidate) =>
      normalizeChoice(candidate.id) === normalized || normalizeChoice(candidate.label) === normalized,
  );
};

export type PhrasedSenseClarification =
  | { kind: "ask"; answer: string; presented: ClarificationCandidate[]; stage: ConversationTraceStage }
  | { kind: "fallback"; documentScope?: string[]; stage: ConversationTraceStage };

/**
 * Turns an `ask` decision into either a real clarifying question or the FR-019
 * silent auto-pick. When fewer than two options are presentable, or the model's
 * lead-in degenerates to a bare label, the top candidate is picked silently with a
 * `phrasing_fallback` trace reason rather than rendering a broken menu. This is the
 * clarification-owned seam; the host only routes the outcome.
 */
export const phraseRetrievalSenseAsk = async (input: {
  candidates: ClarificationCandidate[];
  askStage: ConversationTraceStage;
  phraseQuestion: (candidates: ClarificationCandidate[]) => Promise<string>;
}): Promise<PhrasedSenseClarification> => {
  const presented = presentableSenseCandidates(input.candidates);
  if (presented.length >= 2) {
    const answer = await input.phraseQuestion(presented);
    if (!isDegeneratePhrasing(answer, presented)) {
      return { kind: "ask", answer, presented, stage: input.askStage };
    }
  }
  const top = input.candidates[0]!;
  const documentScope = documentScopeFromClarificationCandidate(top);
  return {
    kind: "fallback",
    ...(documentScope ? { documentScope } : {}),
    stage: clarificationStage({
      surface: "retrieval_sense",
      decision: { kind: "auto_pick", candidate: top, reason: "clear_margin" },
      consideredCandidates: input.candidates,
      reason: "phrasing_fallback",
    }),
  };
};
