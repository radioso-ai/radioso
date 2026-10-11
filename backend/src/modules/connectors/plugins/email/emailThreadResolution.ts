export interface ThreadCandidates {
  forward: readonly { conversationId: string; matchedBy: "in_reply_to" | "references"; source: "index" | "reservation" }[];
  reverse: readonly { conversationId: string }[];
  /** Conversation the plus token in the delivered-to set names, if any. */
  byThreadToken: string | null;
  participantOf: (conversationId: string) => string;
}

export type ThreadResolution =
  | { kind: "existing"; conversationId: string; matchedBy: "in_reply_to" | "references" | "reverse_reference" | "thread_token"; conflict: boolean }
  | { kind: "participant_mismatch"; conversationId: string }
  | { kind: "new" };

type HeaderMatch = { conversationId: string; matchedBy: "in_reply_to" | "references" | "reverse_reference" };

const FORWARD_HEADER_RANK = { in_reply_to: 0, references: 1 } as const;
const FORWARD_SOURCE_RANK = { index: 0, reservation: 1 } as const;

const sameAddress = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Header matches in precedence order (FR-010): In-Reply-To before References, the committed index
 * before an in-flight reservation, and forward matches before reverse ones.
 */
const rankedHeaderMatches = (candidates: ThreadCandidates): HeaderMatch[] => [
  ...[...candidates.forward]
    .sort((a, b) => FORWARD_HEADER_RANK[a.matchedBy] - FORWARD_HEADER_RANK[b.matchedBy]
      || FORWARD_SOURCE_RANK[a.source] - FORWARD_SOURCE_RANK[b.source])
    .map(({ conversationId, matchedBy }) => ({ conversationId, matchedBy })),
  ...candidates.reverse.map(({ conversationId }) => ({ conversationId, matchedBy: "reverse_reference" as const })),
];

/**
 * Decides the thread for one delivery from the lookups of research B15 step 1. Header matches win;
 * the plus token is consulted only when no header matched. A thread continues only for its own
 * participant. Matches naming more than one conversation are a conflict the operator sees.
 */
export const resolveThread = (candidates: ThreadCandidates, sender: string): ThreadResolution => {
  const headerMatches = rankedHeaderMatches(candidates);
  const [best] = headerMatches;
  if (best !== undefined) {
    const conflict = new Set(headerMatches.map((match) => match.conversationId)).size > 1;
    const own = headerMatches.find((match) => sameAddress(candidates.participantOf(match.conversationId), sender));
    return own
      ? { kind: "existing", conversationId: own.conversationId, matchedBy: own.matchedBy, conflict }
      : { kind: "participant_mismatch", conversationId: best.conversationId };
  }

  const tokenConversation = candidates.byThreadToken;
  if (tokenConversation !== null) {
    return sameAddress(candidates.participantOf(tokenConversation), sender)
      ? { kind: "existing", conversationId: tokenConversation, matchedBy: "thread_token", conflict: false }
      : { kind: "participant_mismatch", conversationId: tokenConversation };
  }

  return { kind: "new" };
};
