import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  RewriteContinuityState,
  StructuredRewriteResult,
} from "../../retrieval/domain/retrievalPipelineTypes.js";

interface ConversationIntentTurn {
  role: MessageRecord["role"];
  content: string;
}

export interface ConversationIntentSnapshot {
  recentTurns: ConversationIntentTurn[];
  activeSubject?: string;
  activeGoal?: string;
  latestQuery: string;
  latestAnswer: string;
}

const MAX_RECENT_TURNS = 6;
const EXPLICIT_RECENTER_KINDS = new Set(["fresh_subject", "explicit_recenter"]);
const CONTINUITY_TURN_KINDS = new Set(["referential_followup", "referential_relation", "comparative"]);

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const clampExcerpt = (value: string, maxLength: number): string => {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const isContextDependentQuery = (value: string): boolean =>
  /^(and|also|next|what next|what about|how about|what should i|should i|then|after that)\b/i.test(normalizeWhitespace(value));

const extractPivotSubject = (value: string): string | undefined => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }

  const patterns = [
    /^(?:and\s+)?what about\s+(.+)$/i,
    /^(?:and\s+)?how about\s+(.+)$/i,
    /^(?:and\s+)?what should i know about\s+(.+)$/i,
    /^(?:and\s+)?tell me about\s+(.+)$/i,
    /^(?:and\s+)?for\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]
      ?.replace(/[?.!,:;]+$/g, "")
      .trim();
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

const resolveContinuitySubject = (state?: RewriteContinuityState): string | undefined =>
  normalizeWhitespace(state?.activeSubject ?? state?.groundedTitles[0] ?? "");

const resolveActiveSubject = (input: {
  latestQuery: string;
  previousUserTurn?: string;
  priorRewriteContinuityState?: RewriteContinuityState;
  rewriteProposal?: StructuredRewriteResult;
}): string | undefined => {
  const pivotSubject = extractPivotSubject(input.latestQuery);
  const rewriteTurnKind = input.rewriteProposal?.turnKind;
  const continuitySubject = resolveContinuitySubject(input.priorRewriteContinuityState);

  if (rewriteTurnKind && EXPLICIT_RECENTER_KINDS.has(rewriteTurnKind)) {
    return normalizeWhitespace(
      input.rewriteProposal?.proposedActiveSubject
        ?? pivotSubject
        ?? input.latestQuery,
    );
  }

  if (pivotSubject) {
    return normalizeWhitespace(pivotSubject);
  }

  if (rewriteTurnKind && CONTINUITY_TURN_KINDS.has(rewriteTurnKind) && continuitySubject) {
    return continuitySubject;
  }

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
  const rewriteTurnKind = input.rewriteProposal?.turnKind;
  const continuitySubject = resolveContinuitySubject(input.priorRewriteContinuityState);

  if (rewriteTurnKind && EXPLICIT_RECENTER_KINDS.has(rewriteTurnKind)) {
    return normalizedLatestQuery;
  }

  if (extractPivotSubject(normalizedLatestQuery)) {
    return normalizedLatestQuery;
  }

  if (isContextDependentQuery(normalizedLatestQuery) && continuitySubject) {
    return `${continuitySubject}: ${normalizedLatestQuery}`;
  }

  return normalizedLatestQuery;
};

export const buildConversationIntentSnapshot = (input: {
  history: MessageRecord[];
  latestQuery: string;
  latestAnswer: string;
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
    latestQuery,
    latestAnswer: normalizeWhitespace(input.latestAnswer),
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
