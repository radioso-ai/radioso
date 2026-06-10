import type {
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationRoutineActivator,
  PendingClarification,
  TurnContext,
} from "@radioso/conversation-contract";

export interface RecentClarificationReader {
  loadRecent(input: { sessionId: string }): Promise<PendingClarification | null>;
}

export type PendingClarificationResolution =
  | {
      kind: "routine_activation";
      resolvedPending: true;
      suppressNewClarification: true;
      activator: ConversationRoutineActivator;
    }
  | {
      kind: "normal";
      resolvedPending: boolean;
      suppressNewClarification?: boolean;
      loopGuardCandidateIds?: string[];
      outcome?: "declined" | "expired";
    };

const isExpired = (pending: PendingClarification): boolean =>
  new Date(pending.expiresAt).getTime() <= Date.now();

const candidateIds = (pending: PendingClarification): string[] =>
  pending.candidates.map((candidate) => candidate.id);

const payloadRecord = (payload: unknown): Record<string, unknown> | null =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

const forcedRoutineActivator = (pending: PendingClarification, candidateId: string): ConversationRoutineActivator | null => {
  const candidate = pending.candidates.find((item) => item.id === candidateId);
  const payload = payloadRecord(candidate?.payload);
  if (!payload || typeof payload.routineId !== "string") {
    return null;
  }
  const routineId = payload.routineId;
  const variables = payloadRecord(payload.variables) ?? undefined;
  return {
    async activate() {
      return { kind: "activate", routineId, variables };
    },
  };
};

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
      ? { kind: "normal", resolvedPending: false, loopGuardCandidateIds: candidateIds(recent) }
      : { kind: "normal", resolvedPending: false };
  }

  if (isExpired(pending)) {
    await input.store.clear({ sessionId: pending.sessionId, outcome: "expired" });
    return { kind: "normal", resolvedPending: true, suppressNewClarification: true, outcome: "expired" };
  }

  const mapping = await input.clarifier.mapReply({ candidates: pending.candidates, turn: input.turn });
  if (mapping.kind !== "chosen") {
    await input.store.clear({ sessionId: pending.sessionId, outcome: "declined" });
    return { kind: "normal", resolvedPending: true, suppressNewClarification: true, outcome: "declined" };
  }

  await input.store.clear({ sessionId: pending.sessionId, outcome: "resolved" });
  if (pending.source === "routine_activation") {
    const activator = forcedRoutineActivator(pending, mapping.id);
    if (activator) {
      return {
        kind: "routine_activation",
        resolvedPending: true,
        suppressNewClarification: true,
        activator,
      };
    }
  }
  return { kind: "normal", resolvedPending: true, suppressNewClarification: true };
};
