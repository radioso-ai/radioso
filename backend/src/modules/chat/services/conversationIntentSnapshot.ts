import type { MessageRecord } from "../../../db/repositories/messageRepository.js";

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

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const clampExcerpt = (value: string, maxLength: number): string => {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const isContextDependentQuery = (value: string): boolean =>
  /^(and|also|next|what next|what about|how about|what should i|should i|then|after that)\b/i.test(normalizeWhitespace(value));

export const buildConversationIntentSnapshot = (input: {
  history: MessageRecord[];
  latestQuery: string;
  latestAnswer: string;
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
    activeSubject: previousUserTurn ?? latestQuery,
    activeGoal:
      previousUserTurn && isContextDependentQuery(latestQuery)
        ? previousUserTurn
        : latestQuery,
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
