import { createHash } from "node:crypto";

import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import { MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS } from "../contracts/persistence.js";
import { isValidConversationSemanticIntent } from "../../../shared/domain/conversationInteractionMetadata.js";

export const MAX_OBSERVATION_SEMANTIC_INTENTS = MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS;

export interface ObservationSemanticIntentInput {
  id: string;
  text: string;
}

export interface ObservationEligibilityInput {
  interaction: {
    role: ConversationInteractionRole;
    semanticIntents: ReadonlyArray<ObservationSemanticIntentInput>;
  };
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  populationEligible: boolean;
  resolutionDeadline: Date;
}

export interface ReadyObservationContribution {
  semanticIntentId: string;
  semanticTextHash: string;
  observationState: "ready";
  resolutionDeadline?: never;
}

export interface PendingObservationContribution {
  semanticIntentId: "unresolved";
  semanticTextHash: null;
  observationState: "pending_context";
  resolutionDeadline: Date;
}

export type EligibleObservationContribution =
  | ReadyObservationContribution
  | PendingObservationContribution;

interface ObservationRegistrationDecision {
  kind: "register" | "finalize_pending";
  role: ConversationInteractionRole;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  contributions: EligibleObservationContribution[];
  /** Valid distinct intents beyond Retrieval's branch cap. */
  truncatedCount: number;
}

interface ObservationSkipDecision {
  kind: "skip";
  reason: "population_excluded" | "control" | "social";
}

interface ObservationExclusionDecision {
  kind: "exclude_pending";
  reason: "ambiguous";
  sourceUserMessageId: string;
}

export type ObservationEligibilityDecision =
  | ObservationRegistrationDecision
  | ObservationSkipDecision
  | ObservationExclusionDecision;

export const semanticIntentTextHash = (semanticText: string): string =>
  createHash("sha256").update(semanticText, "utf8").digest("hex");

const isValidSemanticIntent = (
  intent: ObservationSemanticIntentInput,
): boolean => isValidConversationSemanticIntent(intent);

export const boundObservationSemanticIntents = (
  semanticIntents: ReadonlyArray<ObservationSemanticIntentInput>,
): { semanticIntents: ObservationSemanticIntentInput[]; truncatedCount: number } => {
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const distinct: ObservationSemanticIntentInput[] = [];

  for (const intent of semanticIntents) {
    if (!isValidSemanticIntent(intent) || seenIds.has(intent.id)) {
      continue;
    }
    const semanticHash = semanticIntentTextHash(intent.text);
    if (seenHashes.has(semanticHash)) {
      continue;
    }
    seenIds.add(intent.id);
    seenHashes.add(semanticHash);
    distinct.push({ id: intent.id, text: intent.text });
  }

  const bounded = distinct.slice(0, MAX_OBSERVATION_SEMANTIC_INTENTS);
  return {
    semanticIntents: bounded,
    truncatedCount: Math.max(0, distinct.length - bounded.length),
  };
};

const readyContributions = (
  semanticIntents: ReadonlyArray<ObservationSemanticIntentInput>,
): { contributions: ReadyObservationContribution[]; truncatedCount: number } => {
  const bounded = boundObservationSemanticIntents(semanticIntents);
  return {
    contributions: bounded.semanticIntents.map((intent) => ({
      semanticIntentId: intent.id,
      semanticTextHash: semanticIntentTextHash(intent.text),
      observationState: "ready",
    })),
    truncatedCount: bounded.truncatedCount,
  };
};

const pendingContribution = (resolutionDeadline: Date): PendingObservationContribution => ({
  semanticIntentId: "unresolved",
  semanticTextHash: null,
  observationState: "pending_context",
  resolutionDeadline: new Date(resolutionDeadline),
});

/**
 * Converts already-structured turn meaning into durable, content-free observation
 * facts. It deliberately receives no visitor message and has no language rules.
 */
export const decideObservationEligibility = (
  input: ObservationEligibilityInput,
): ObservationEligibilityDecision => {
  if (!input.populationEligible) {
    return { kind: "skip", reason: "population_excluded" };
  }
  if (input.interaction.role === "control") {
    return { kind: "skip", reason: "control" };
  }
  if (input.interaction.role === "social") {
    return { kind: "skip", reason: "social" };
  }

  const ready = readyContributions(input.interaction.semanticIntents);
  if (input.interaction.role === "clarification_value") {
    if (ready.contributions.length === 0) {
      return {
        kind: "exclude_pending",
        reason: "ambiguous",
        sourceUserMessageId: input.sourceUserMessageId,
      };
    }
    return {
      kind: "finalize_pending",
      role: input.interaction.role,
      sourceUserMessageId: input.sourceUserMessageId,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      contributions: ready.contributions,
      truncatedCount: ready.truncatedCount,
    };
  }

  if (
    input.interaction.role === "substantive_new" ||
    input.interaction.role === "substantive_followup"
  ) {
    if (ready.contributions.length > 0) {
      return {
        kind: "register",
        role: input.interaction.role,
        sourceUserMessageId: input.sourceUserMessageId,
        sourceAssistantMessageId: input.sourceAssistantMessageId,
        contributions: ready.contributions,
        truncatedCount: ready.truncatedCount,
      };
    }
  }

  return {
    kind: "register",
    role: "unresolved",
    sourceUserMessageId: input.sourceUserMessageId,
    sourceAssistantMessageId: input.sourceAssistantMessageId,
    contributions: [pendingContribution(input.resolutionDeadline)],
    truncatedCount: 0,
  };
};
