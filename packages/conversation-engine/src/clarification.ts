import type {
  ClarificationCandidate,
  ClarificationDecision,
  ClarificationPolicy,
  ConversationTraceStage,
} from "@radioso/conversation-contract";

const nowIso = (): string => new Date().toISOString();

export interface ClarificationDecisionContext {
  suppressAsk?: boolean;
  loopGuardCandidateIds?: string[];
  priorities?: Record<string, number>;
}

const candidatePriority = (
  candidate: ClarificationCandidate,
  priorities: Record<string, number> = {},
): number =>
  typeof priorities[candidate.id] === "number" && Number.isFinite(priorities[candidate.id])
    ? priorities[candidate.id]!
    : 0;

export const orderClarificationCandidates = (
  candidates: ClarificationCandidate[],
  priorities: Record<string, number> = {},
): ClarificationCandidate[] =>
  [...candidates].sort((left, right) => {
    const confidenceDelta = right.confidence - left.confidence;
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    const priorityDelta = candidatePriority(right, priorities) - candidatePriority(left, priorities);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.id.localeCompare(right.id);
  });

const sameCandidateSet = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((id, index) => id === normalizedRight[index]);
};

export const decideClarification = (
  candidates: ClarificationCandidate[],
  policy: ClarificationPolicy,
  context: ClarificationDecisionContext = {},
): ClarificationDecision => {
  const eligible = orderClarificationCandidates(
    candidates.filter((candidate) => candidate.confidence >= policy.floor),
    context.priorities,
  );
  if (eligible.length === 0) {
    return { kind: "none" };
  }

  const top = eligible[0]!;
  const runnerUp = eligible[1];
  if (context.suppressAsk) {
    return { kind: "auto_pick", candidate: top, reason: "suppressed" };
  }

  if (!runnerUp || top.confidence - runnerUp.confidence >= policy.margin) {
    return { kind: "auto_pick", candidate: top, reason: "clear_margin" };
  }

  // The "too-close set": only candidates within the margin of the leader are in
  // genuine contention; weaker ones are never offered in the question.
  const tooClose = eligible.filter((candidate) => top.confidence - candidate.confidence < policy.margin);
  const presented = tooClose.slice(0, policy.maxOptions);

  if (context.loopGuardCandidateIds && sameCandidateSet(context.loopGuardCandidateIds, presented.map((candidate) => candidate.id))) {
    return { kind: "auto_pick", candidate: top, reason: "loop_guard" };
  }

  // Authored priority is the operator's explicit arbitration: a unique highest
  // priority within the too-close set wins silently, even when it is not the
  // confidence leader. Ties on priority fall through to asking.
  const highestPriority = Math.max(...tooClose.map((candidate) => candidatePriority(candidate, context.priorities)));
  const priorityHolders = tooClose.filter(
    (candidate) => candidatePriority(candidate, context.priorities) === highestPriority,
  );
  if (priorityHolders.length === 1) {
    return { kind: "auto_pick", candidate: priorityHolders[0]!, reason: "priority" };
  }

  return { kind: "ask", candidates: presented };
};

const traceCandidates = (candidates: ClarificationCandidate[]) =>
  candidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    confidence: candidate.confidence,
  }));

const decisionName = (decision: ClarificationDecision): string => {
  if (decision.kind === "ask") {
    return "asked";
  }
  if (decision.kind === "auto_pick") {
    return decision.reason === "suppressed" ? "suppressed" : "auto_picked";
  }
  return "none";
};

const decisionCandidates = (decision: ClarificationDecision): ClarificationCandidate[] => {
  if (decision.kind === "ask") {
    return decision.candidates;
  }
  if (decision.kind === "auto_pick") {
    return [decision.candidate];
  }
  return [];
};

export const clarificationStage = (input: {
  surface: string;
  decision: ClarificationDecision;
  reason?: string;
  margin?: number;
  mappingOutcome?: string;
}): ConversationTraceStage => {
  const timestamp = nowIso();
  const reason = input.reason ?? (input.decision.kind === "auto_pick" ? input.decision.reason : undefined);
  return {
    id: "clarification",
    kind: "clarification",
    status: input.decision.kind === "none" ? "skipped" : "applied",
    startedAt: timestamp,
    completedAt: timestamp,
    outputs: {
      surface: input.surface,
      decision: decisionName(input.decision),
      ...(reason ? { reason } : {}),
      ...(input.margin !== undefined ? { margin: input.margin } : {}),
      candidates: traceCandidates(decisionCandidates(input.decision)),
      ...(input.mappingOutcome ? { mappingOutcome: input.mappingOutcome } : {}),
    },
  };
};
