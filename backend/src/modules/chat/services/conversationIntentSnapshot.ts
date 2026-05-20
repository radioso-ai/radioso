import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  RewriteContinuityState,
  StructuredRewriteResult,
} from "../../retrieval/public.js";

interface ConversationIntentTurn {
  role: MessageRecord["role"];
  content: string;
}

export interface ConversationIntentSnapshot {
  recentTurns: ConversationIntentTurn[];
  activeSubject?: string;
  activeGoal?: string;
}

const MAX_RECENT_TURNS = 6;

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const clampExcerpt = (value: string, maxLength: number): string => {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const resolveContinuitySubject = (state?: RewriteContinuityState): string | undefined => {
  const normalized = normalizeWhitespace(state?.activeSubject ?? state?.groundedTitles[0] ?? "");
  return normalized.length > 0 ? normalized : undefined;
};

const resolveActiveSubject = (input: {
  latestQuery: string;
  previousUserTurn?: string;
  priorRewriteContinuityState?: RewriteContinuityState;
  rewriteProposal?: StructuredRewriteResult;
}): string | undefined => {
  const continuitySubject = resolveContinuitySubject(input.priorRewriteContinuityState);
  return normalizeWhitespace(
    input.rewriteProposal?.proposedActiveSubject
      ?? continuitySubject
      ?? input.previousUserTurn
      ?? input.latestQuery,
  );
};

const resolveActiveGoal = (input: {
  latestQuery: string;
  previousUserTurn?: string;
  priorRewriteContinuityState?: RewriteContinuityState;
  rewriteProposal?: StructuredRewriteResult;
}): string => {
  const normalizedLatestQuery = normalizeWhitespace(input.latestQuery);
  const continuitySubject = resolveContinuitySubject(input.priorRewriteContinuityState);
  return continuitySubject ? `${continuitySubject}: ${normalizedLatestQuery}` : normalizedLatestQuery;
};

export const buildConversationIntentSnapshot = (input: {
  history: MessageRecord[];
  latestQuery: string;
  priorRewriteContinuityState?: RewriteContinuityState;
  rewriteProposal?: StructuredRewriteResult;
}): ConversationIntentSnapshot => {
  const nonSystemHistory = input.history
    .filter((message) => message.role !== "system")
    .slice(-MAX_RECENT_TURNS)
    .map((message) => ({
      role: message.role,
      content: clampExcerpt(message.content, 220),
    }));
  const userTurns = nonSystemHistory.filter((message) => message.role === "user");
  const previousUserTurn = userTurns.at(-1)?.content;
  const latestQuery = normalizeWhitespace(input.latestQuery);

  return {
    recentTurns: nonSystemHistory,
    activeSubject: resolveActiveSubject({
      latestQuery,
      previousUserTurn,
      priorRewriteContinuityState: input.priorRewriteContinuityState,
      rewriteProposal: input.rewriteProposal,
    }),
    activeGoal: resolveActiveGoal({
      latestQuery,
      previousUserTurn,
      priorRewriteContinuityState: input.priorRewriteContinuityState,
      rewriteProposal: input.rewriteProposal,
    }),
  };
};

export const formatConversationIntentSnapshot = (snapshot: ConversationIntentSnapshot): string =>
  JSON.stringify(
    {
      recentTurns: snapshot.recentTurns,
      activeSubject: snapshot.activeSubject ?? null,
      activeGoal: snapshot.activeGoal ?? null,
    },
    null,
    2,
  );
