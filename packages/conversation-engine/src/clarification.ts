import type {
  ClarificationCandidate,
  ClarificationDecision,
  ClarificationOfferMappingOutcome,
  ClarificationPolicy,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationTraceStage,
  PendingClarification,
  RecentClarificationReader,
  TurnContext,
} from "@radioso/conversation-contract";

const nowIso = (): string => new Date().toISOString();

export interface ClarificationDecisionContext {
  suppressAsk?: boolean;
  loopGuardCandidateIds?: string[];
  priorities?: Record<string, number>;
}

export interface PendingClarificationResolution {
  resolvedPending: boolean;
  suppressNewClarification?: boolean;
  loopGuardCandidateIds?: string[];
  source?: string;
  offerOutcome?: "accepted_alternative" | "ignored";
  outcome?: "resolved" | "declined" | "expired";
  chosen?: { source: string; candidate: ClarificationCandidate; originalQuery?: string };
  /** How a reply to an `offer` row resolved, and the stage the turn's trace records for it. */
  mappingOutcome?: ClarificationOfferMappingOutcome;
  mappingStage?: ConversationTraceStage;
}

const candidatePriority = (
  candidate: ClarificationCandidate,
  priorities: Record<string, number> = {},
): number =>
  typeof priorities[candidate.id] === "number" && Number.isFinite(priorities[candidate.id])
    ? priorities[candidate.id]
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

const isExpired = (pending: PendingClarification): boolean =>
  new Date(pending.expiresAt).getTime() <= Date.now();

const candidateIds = (pending: PendingClarification): string[] =>
  pending.candidates.map((candidate) => candidate.id);

export const resolvePendingClarification = async (input: {
  store: ConversationClarificationStore;
  recentReader?: RecentClarificationReader;
  clarifier: ConversationClarifier;
  turn: TurnContext;
}): Promise<PendingClarificationResolution> => {
  const pending = await input.store.loadPending({ sessionId: input.turn.sessionId });
  if (!pending) {
    const recent = await input.recentReader?.loadRecent({ sessionId: input.turn.sessionId });
    return recent && recent.status !== "pending" && !isExpired(recent)
      ? { resolvedPending: false, loopGuardCandidateIds: candidateIds(recent) }
      : { resolvedPending: false };
  }

  if (isExpired(pending)) {
    await input.store.clear({ sessionId: pending.sessionId, outcome: "expired" });
    return {
      resolvedPending: true,
      suppressNewClarification: true,
      outcome: "expired",
    };
  }

  const mode = pending.mode ?? "ask";
  const mapping = await input.clarifier.mapReply({
    candidates: pending.candidates,
    turn: input.turn,
    ...(mode === "offer" ? { mode, source: pending.source } : {}),
  });
  if (mapping.kind !== "chosen") {
    await input.store.clear({ sessionId: pending.sessionId, outcome: "declined" });
    if (mode === "offer") {
      const mappingOutcome = mapping.kind === "declined" ? "declined" : "ignored";
      return {
        resolvedPending: true,
        source: pending.source,
        outcome: "declined",
        offerOutcome: "ignored",
        loopGuardCandidateIds: candidateIds(pending),
        mappingOutcome,
        mappingStage: clarificationMappingStage({ surface: pending.source, candidates: pending.candidates, mappingOutcome }),
      };
    }
    return {
      resolvedPending: true,
      suppressNewClarification: true,
      outcome: "declined",
      loopGuardCandidateIds: candidateIds(pending),
    };
  }

  await input.store.clear({ sessionId: pending.sessionId, outcome: "resolved" });
  const candidate = pending.candidates.find((item) => item.id === mapping.id);
  const candidateIndex = pending.candidates.findIndex((item) => item.id === mapping.id);
  return {
    resolvedPending: true,
    suppressNewClarification: true,
    outcome: "resolved",
    ...(mode === "offer" && candidateIndex > 0 ? { offerOutcome: "accepted_alternative" as const } : {}),
    ...(mode === "offer"
      ? {
          mappingOutcome: "accepted" as const,
          mappingStage: clarificationMappingStage({
            surface: pending.source,
            candidates: pending.candidates,
            mappingOutcome: "accepted",
            chosenCandidateId: mapping.id,
          }),
        }
      : {}),
    ...(candidate
      ? {
          chosen: {
            source: pending.source,
            candidate,
            ...(pending.originalQuery ? { originalQuery: pending.originalQuery } : {}),
          },
        }
      : {}),
  };
};

export const decideClarification = (
  candidates: ClarificationCandidate[],
  policy: ClarificationPolicy,
  context: ClarificationDecisionContext = {},
): ClarificationDecision => {
  const askMargin = policy.askMargin ?? policy.margin;
  const eligible = orderClarificationCandidates(
    candidates.filter((candidate) => candidate.confidence >= policy.floor),
    context.priorities,
  );
  if (eligible.length === 0) {
    return { kind: "none" };
  }

  const top = eligible[0];
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
    return { kind: "auto_pick", candidate: priorityHolders[0], reason: "priority" };
  }

  if (runnerUp && top.confidence - runnerUp.confidence >= askMargin) {
    return { kind: "soft_pick", candidate: top, alternatives: presented.filter((candidate) => candidate.id !== top.id) };
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
  if (decision.kind === "soft_pick" || decision.kind === "offer") {
    return "offered";
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
  if (decision.kind === "soft_pick") {
    return [decision.candidate, ...decision.alternatives];
  }
  if (decision.kind === "auto_pick" || decision.kind === "offer") {
    return [decision.candidate];
  }
  return [];
};

export const clarificationStage = (input: {
  surface: string;
  decision: ClarificationDecision;
  consideredCandidates?: ClarificationCandidate[];
  reason?: string;
  margin?: number;
  mappingOutcome?: string;
}): ConversationTraceStage => {
  const timestamp = nowIso();
  const reason = input.reason ?? (input.decision.kind === "auto_pick" ? input.decision.reason : undefined);
  const consideredCandidates = input.consideredCandidates ?? decisionCandidates(input.decision);
  const chosenCandidateId = "candidate" in input.decision ? input.decision.candidate.id : undefined;
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
      ...(chosenCandidateId ? { chosenCandidateId } : {}),
      candidates: traceCandidates(consideredCandidates),
      ...(input.mappingOutcome ? { mappingOutcome: input.mappingOutcome } : {}),
    },
  };
};

/**
 * The stage a turn records when it resolves a reply to an `offer` row: what was offered and
 * whether the visitor accepted it, said no, or moved on. Ids, labels and confidences only.
 */
export const clarificationMappingStage = (input: {
  surface: string;
  candidates: ClarificationCandidate[];
  mappingOutcome: ClarificationOfferMappingOutcome;
  chosenCandidateId?: string;
}): ConversationTraceStage => {
  const timestamp = nowIso();
  return {
    id: "clarification",
    kind: "clarification",
    status: "applied",
    startedAt: timestamp,
    completedAt: timestamp,
    outputs: {
      surface: input.surface,
      decision: "mapped",
      mappingOutcome: input.mappingOutcome,
      ...(input.chosenCandidateId ? { chosenCandidateId: input.chosenCandidateId } : {}),
      candidates: traceCandidates(input.candidates),
    },
  };
};
