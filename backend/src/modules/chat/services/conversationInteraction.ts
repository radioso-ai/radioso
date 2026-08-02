import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  RetrievalExecutionDiagnostics,
  StructuredRewriteResult,
} from "../../retrieval/public.js";

export const CONVERSATION_INTERACTION_ROLES = [
  "substantive_new",
  "substantive_followup",
  "clarification_value",
  "control",
  "social",
  "unresolved",
] as const satisfies readonly ConversationInteractionRole[];

const interactionRoleSet = new Set<unknown>(CONVERSATION_INTERACTION_ROLES);

/** Invalid or absent model output remains explicitly unresolved; no text classifier fallback. */
export const parseConversationInteractionRole = (value: unknown): ConversationInteractionRole =>
  interactionRoleSet.has(value) ? value as ConversationInteractionRole : "unresolved";

export interface ConversationSemanticIntent {
  /** Stable identity shared with retrieval's semantic vector envelope. */
  id: string;
  /** Ephemeral contextual text; message-owned metadata is the durable source. */
  text: string;
}

export interface PreparedConversationInteraction {
  role: ConversationInteractionRole;
  semanticIntents: ConversationSemanticIntent[];
}

export const unresolvedConversationInteraction = (): PreparedConversationInteraction => ({
  role: "unresolved",
  semanticIntents: [],
});

const nonEmptyText = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Mirrors Retrieval's existing intent identities: one branch is `primary`, while
 * a real decomposition is ordered `subquery_1..n`. Retrieval normalizes only
 * decompositions with at least two valid branches, so a singleton uses primary.
 */
export const semanticIntentsFromRewrite = (
  rewrite: StructuredRewriteResult | undefined,
): ConversationSemanticIntent[] => {
  if (!rewrite) {
    return [];
  }
  const subqueries = (rewrite.retrievalSubqueries ?? [])
    .map((subquery) => nonEmptyText(subquery.semanticQuery))
    .filter((text): text is string => text !== null);
  if (subqueries.length > 1) {
    return subqueries.map((text, index) => ({ id: `subquery_${index + 1}`, text }));
  }
  const primary = nonEmptyText(rewrite.semanticQuery) ?? nonEmptyText(rewrite.rewrittenQuery);
  return primary ? [{ id: "primary", text: primary }] : [];
};

/** Canonicalize against the semantic queries Retrieval actually prepared. */
export const semanticIntentsFromRetrieval = (
  diagnostics: unknown,
): ConversationSemanticIntent[] => {
  const candidate = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? diagnostics as Partial<RetrievalExecutionDiagnostics>
    : {};
  const subqueries = (candidate.retrievalSubqueries ?? [])
    .map((subquery) => ({ id: subquery.id, text: nonEmptyText(subquery.semanticQuery) }))
    .filter((intent): intent is { id: string; text: string } => Boolean(intent.id) && intent.text !== null);
  if (subqueries.length > 1) {
    return subqueries;
  }
  const primary = nonEmptyText(candidate.parsedQuery?.semanticQuery);
  return primary ? [{ id: "primary", text: primary }] : [];
};

const roleCarriesSemanticIntents = (role: ConversationInteractionRole): boolean =>
  role === "substantive_new" ||
  role === "substantive_followup" ||
  role === "clarification_value";

export const interactionFromTurnInterpretation = (input: {
  interactionRole?: unknown;
  rewriteProposal?: StructuredRewriteResult;
}): PreparedConversationInteraction => {
  const role = parseConversationInteractionRole(input.interactionRole);
  return {
    role,
    semanticIntents: roleCarriesSemanticIntents(role)
      ? semanticIntentsFromRewrite(input.rewriteProposal)
      : [],
  };
};

export const interactionWithRetrievalIntents = (
  interaction: PreparedConversationInteraction | undefined,
  diagnostics: unknown,
): PreparedConversationInteraction => {
  const current = interaction ?? unresolvedConversationInteraction();
  if (!roleCarriesSemanticIntents(current.role)) {
    return current;
  }
  const semanticIntents = semanticIntentsFromRetrieval(diagnostics);
  return semanticIntents.length > 0 ? { ...current, semanticIntents } : current;
};

export interface ConversationInteractionLifecycleFacts {
  socialTerminal?: boolean;
  routineTurn?: boolean;
  pendingDecisionTurn?: boolean;
  clarificationOutcome?: "value" | "declined" | "expired";
}

export const resolveInteractionSourceUserMessageId = (input: {
  currentUserMessageId: string;
  history: ReadonlyArray<Pick<MessageRecord, "id" | "role">>;
  useEarlierUserMessage: boolean;
}): string => {
  if (!input.useEarlierUserMessage) {
    return input.currentUserMessageId;
  }
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index];
    if (message?.role === "user" && message.id && message.id !== input.currentUserMessageId) {
      return message.id;
    }
  }
  return input.currentUserMessageId;
};

/**
 * Applies authoritative lifecycle facts without topic/report policy. Clarification
 * takes precedence because a value may activate a routine; routine/decision values
 * then override as control, followed by terminal social handling.
 */
export const resolveConversationInteraction = (input: {
  inferred: PreparedConversationInteraction;
  currentUserMessageId: string;
  history: ReadonlyArray<Pick<MessageRecord, "id" | "role">>;
  lifecycle: ConversationInteractionLifecycleFacts;
  priorUnresolvedSourceUserMessageId?: string;
}): {
  interaction: PreparedConversationInteraction;
  sourceUserMessageId: string;
  expiresUnresolvedSourceUserMessageId?: string;
} => {
  const hasClarificationOutcome = input.lifecycle.clarificationOutcome !== undefined;
  const sourceUserMessageId = resolveInteractionSourceUserMessageId({
    currentUserMessageId: input.currentUserMessageId,
    history: input.history,
    useEarlierUserMessage: hasClarificationOutcome,
  });

  let role = input.inferred.role;
  if (input.lifecycle.clarificationOutcome === "value") {
    role = "clarification_value";
  } else if (
    input.lifecycle.clarificationOutcome === "declined" ||
    input.lifecycle.clarificationOutcome === "expired" ||
    input.lifecycle.routineTurn ||
    input.lifecycle.pendingDecisionTurn
  ) {
    role = "control";
  } else if (input.lifecycle.socialTerminal) {
    role = "social";
  }

  const interaction: PreparedConversationInteraction = {
    role,
    semanticIntents: roleCarriesSemanticIntents(role) ? input.inferred.semanticIntents : [],
  };
  const finalizesPrior =
    role === "clarification_value" &&
    input.priorUnresolvedSourceUserMessageId === sourceUserMessageId;
  const expiresPrior = Boolean(
    input.priorUnresolvedSourceUserMessageId &&
    role !== "unresolved" &&
    !finalizesPrior,
  );

  return {
    interaction,
    sourceUserMessageId,
    ...(expiresPrior
      ? { expiresUnresolvedSourceUserMessageId: input.priorUnresolvedSourceUserMessageId }
      : {}),
  };
};
