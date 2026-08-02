import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import {
  MAX_OBSERVATION_SEMANTIC_INTENTS,
  boundObservationSemanticIntents,
  semanticIntentTextHash,
  type ObservationSemanticIntentInput,
} from "../domain/observationEligibility.js";

export const MAX_HISTORICAL_CONTEXT_MESSAGES = 12;
const MAX_HISTORICAL_MESSAGE_CHARS = 4_000;
const MAX_FOLLOWING_CONTEXT_MESSAGES = 3;

const interactionRoles = new Set<unknown>([
  "substantive_new",
  "substantive_followup",
  "clarification_value",
  "control",
  "social",
  "unresolved",
] satisfies ConversationInteractionRole[]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const roleCarriesSemanticIntent = (role: ConversationInteractionRole): boolean =>
  role === "substantive_new" ||
  role === "substantive_followup" ||
  role === "clarification_value";

interface CanonicalInteractionMetadataAbsent {
  status: "absent";
}

interface CanonicalInteractionMetadataInvalid {
  status: "invalid";
}

interface CanonicalInteractionMetadataValid {
  status: "valid";
  role: ConversationInteractionRole;
  semanticIntents: ObservationSemanticIntentInput[];
}

interface CanonicalInteractionMetadataPointer {
  status: "pointer";
  sourceUserMessageId: string;
}

type CanonicalInteractionMetadata =
  | CanonicalInteractionMetadataAbsent
  | CanonicalInteractionMetadataInvalid
  | CanonicalInteractionMetadataValid
  | CanonicalInteractionMetadataPointer;

interface CanonicalInteractionResolutionValid {
  status: "valid";
  valueUserMessageId: string;
  semanticIntents: ObservationSemanticIntentInput[];
}

type CanonicalInteractionResolution =
  | { status: "absent" }
  | { status: "invalid" }
  | CanonicalInteractionResolutionValid;

const isBoundedMessageId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128;

const parseCanonicalInteractionMetadata = (metadata: unknown): CanonicalInteractionMetadata => {
  if (!isRecord(metadata) || !Object.hasOwn(metadata, "conversationInteraction")) {
    return { status: "absent" };
  }
  const interaction = metadata.conversationInteraction;
  if (
    isRecord(interaction)
    && interaction.version === 1
    && interaction.role === "clarification_value"
    && isBoundedMessageId(interaction.sourceUserMessageId)
    && !Object.hasOwn(interaction, "semanticIntents")
  ) {
    return { status: "pointer", sourceUserMessageId: interaction.sourceUserMessageId };
  }
  if (
    !isRecord(interaction) ||
    interaction.version !== 1 ||
    !interactionRoles.has(interaction.role) ||
    !Array.isArray(interaction.semanticIntents) ||
    interaction.semanticIntents.length > MAX_OBSERVATION_SEMANTIC_INTENTS
  ) {
    return { status: "invalid" };
  }

  const role = interaction.role as ConversationInteractionRole;
  const candidates: ObservationSemanticIntentInput[] = [];
  for (const value of interaction.semanticIntents) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") {
      return { status: "invalid" };
    }
    candidates.push({ id: value.id, text: value.text });
  }
  const bounded = boundObservationSemanticIntents(candidates);
  if (
    candidates.some((candidate) =>
      boundObservationSemanticIntents([candidate]).semanticIntents.length !== 1,
    ) ||
    (roleCarriesSemanticIntent(role) && bounded.semanticIntents.length === 0) ||
    (!roleCarriesSemanticIntent(role) && bounded.semanticIntents.length !== 0)
  ) {
    return { status: "invalid" };
  }
  return { status: "valid", role, semanticIntents: bounded.semanticIntents };
};

const parseCanonicalInteractionResolution = (
  metadata: unknown,
): CanonicalInteractionResolution => {
  if (!isRecord(metadata) || !Object.hasOwn(metadata, "conversationInteractionResolution")) {
    return { status: "absent" };
  }
  const resolution = metadata.conversationInteractionResolution;
  if (
    !isRecord(resolution)
    || resolution.version !== 1
    || resolution.role !== "clarification_value"
    || !isBoundedMessageId(resolution.valueUserMessageId)
    || !Array.isArray(resolution.semanticIntents)
    || resolution.semanticIntents.length > MAX_OBSERVATION_SEMANTIC_INTENTS
  ) {
    return { status: "invalid" };
  }
  const candidates: ObservationSemanticIntentInput[] = [];
  for (const value of resolution.semanticIntents) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") {
      return { status: "invalid" };
    }
    candidates.push({ id: value.id, text: value.text });
  }
  const bounded = boundObservationSemanticIntents(candidates);
  if (
    bounded.semanticIntents.length === 0
    || candidates.some((candidate) =>
      boundObservationSemanticIntents([candidate]).semanticIntents.length !== 1,
    )
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    valueUserMessageId: resolution.valueUserMessageId,
    semanticIntents: bounded.semanticIntents,
  };
};

const parseLegacyAuditSemanticIntents = (
  auditMetadata: unknown,
): ObservationSemanticIntentInput[] => {
  if (!isRecord(auditMetadata) || !isRecord(auditMetadata.retrieval)) {
    return [];
  }
  const retrieval = auditMetadata.retrieval;
  const candidates: ObservationSemanticIntentInput[] = [];
  if (Array.isArray(retrieval.retrievalSubqueries)) {
    for (const value of retrieval.retrievalSubqueries) {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.semanticQuery !== "string") {
        continue;
      }
      candidates.push({ id: value.id, text: value.semanticQuery });
    }
  }
  if (isRecord(retrieval.parsedQuery) && typeof retrieval.parsedQuery.semanticQuery === "string") {
    candidates.push({ id: "primary", text: retrieval.parsedQuery.semanticQuery });
  }
  return boundObservationSemanticIntents(candidates).semanticIntents;
};

export interface ResolvedObservationSource {
  status: "resolved";
  source: "message_metadata" | "legacy_audit" | "historical_interpretation";
  semanticIntentId: string;
  semanticText: string;
  semanticTextHash: string;
}

export interface UnavailableObservationSource {
  status: "unavailable";
  reason: "semantic_intent_missing" | "hash_mismatch" | "ambiguous" | "source_unavailable";
}

export type ObservationSourceResolution =
  | ResolvedObservationSource
  | UnavailableObservationSource;

const validateResolvedIntent = (input: {
  source: ResolvedObservationSource["source"];
  intent: ObservationSemanticIntentInput | undefined;
  expectedHash: string | null;
}): ObservationSourceResolution => {
  if (!input.intent || input.expectedHash === null) {
    return { status: "unavailable", reason: "semantic_intent_missing" };
  }
  const semanticTextHash = semanticIntentTextHash(input.intent.text);
  if (semanticTextHash !== input.expectedHash) {
    return { status: "unavailable", reason: "hash_mismatch" };
  }
  return {
    status: "resolved",
    source: input.source,
    semanticIntentId: input.intent.id,
    semanticText: input.intent.text,
    semanticTextHash,
  };
};

export const resolveStructuredObservationSource = (input: {
  semanticIntentId: string;
  semanticTextHash: string | null;
  messageMetadata: unknown;
  legacyAuditMetadata: unknown;
  /** Present on hydrated rows for evidence/history only; never a semantic fallback. */
  rawSourceContent?: unknown;
}): ObservationSourceResolution => {
  const clarificationResolution = parseCanonicalInteractionResolution(input.messageMetadata);
  if (clarificationResolution.status !== "absent") {
    if (clarificationResolution.status === "invalid") {
      return { status: "unavailable", reason: "semantic_intent_missing" };
    }
    return validateResolvedIntent({
      source: "message_metadata",
      intent: clarificationResolution.semanticIntents.find(({ id }) => id === input.semanticIntentId),
      expectedHash: input.semanticTextHash,
    });
  }
  const canonical = parseCanonicalInteractionMetadata(input.messageMetadata);
  if (canonical.status !== "absent") {
    if (canonical.status === "invalid" || canonical.status === "pointer") {
      return { status: "unavailable", reason: "semantic_intent_missing" };
    }
    return validateResolvedIntent({
      source: "message_metadata",
      intent: canonical.semanticIntents.find(({ id }) => id === input.semanticIntentId),
      expectedHash: input.semanticTextHash,
    });
  }

  const legacyIntents = parseLegacyAuditSemanticIntents(input.legacyAuditMetadata);
  return validateResolvedIntent({
    source: "legacy_audit",
    intent: legacyIntents.find(({ id }) => id === input.semanticIntentId),
    expectedHash: input.semanticTextHash,
  });
};

export const resolvePendingStructuredObservationSource = (input: {
  messageMetadata: unknown;
  legacyAuditMetadata: unknown;
}): ObservationSourceResolution => {
  const clarificationResolution = parseCanonicalInteractionResolution(input.messageMetadata);
  if (clarificationResolution.status !== "absent") {
    if (clarificationResolution.status !== "valid" || clarificationResolution.semanticIntents.length !== 1) {
      return {
        status: "unavailable",
        reason: clarificationResolution.status === "valid" ? "ambiguous" : "semantic_intent_missing",
      };
    }
    const intent = clarificationResolution.semanticIntents[0]!;
    return {
      status: "resolved",
      source: "message_metadata",
      semanticIntentId: intent.id,
      semanticText: intent.text,
      semanticTextHash: semanticIntentTextHash(intent.text),
    };
  }
  const canonical = parseCanonicalInteractionMetadata(input.messageMetadata);
  if (canonical.status !== "absent") {
    if (canonical.status !== "valid" || canonical.semanticIntents.length !== 1) {
      return {
        status: "unavailable",
        reason: canonical.status === "valid" ? "ambiguous" : "semantic_intent_missing",
      };
    }
    const intent = canonical.semanticIntents[0]!;
    return {
      status: "resolved",
      source: "message_metadata",
      semanticIntentId: intent.id,
      semanticText: intent.text,
      semanticTextHash: semanticIntentTextHash(intent.text),
    };
  }

  const legacyIntents = parseLegacyAuditSemanticIntents(input.legacyAuditMetadata);
  if (legacyIntents.length !== 1) {
    return {
      status: "unavailable",
      reason: legacyIntents.length > 1 ? "ambiguous" : "semantic_intent_missing",
    };
  }
  const intent = legacyIntents[0]!;
  return {
    status: "resolved",
    source: "legacy_audit",
    semanticIntentId: intent.id,
    semanticText: intent.text,
    semanticTextHash: semanticIntentTextHash(intent.text),
  };
};

export interface ObservationSourceMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface HistoricalInteractionInterpreterPort {
  interpret(input: {
    sourceUserMessageId: string;
    workspaceId?: string;
    conversationId?: string;
    messages: ReadonlyArray<Pick<ObservationSourceMessage, "id" | "role" | "content">>;
  }): Promise<{
    role: ConversationInteractionRole;
    semanticIntents: ReadonlyArray<ObservationSemanticIntentInput>;
  }>;
}

const boundedHistoricalContext = (input: {
  sourceUserMessageId: string;
  messages: ReadonlyArray<ObservationSourceMessage>;
}): Array<Pick<ObservationSourceMessage, "id" | "role" | "content">> => {
  const sourceIndex = input.messages.findIndex(({ id }) => id === input.sourceUserMessageId);
  if (sourceIndex < 0) {
    return [];
  }
  const precedingCapacity = MAX_HISTORICAL_CONTEXT_MESSAGES - 1 - MAX_FOLLOWING_CONTEXT_MESSAGES;
  let start = Math.max(0, sourceIndex - precedingCapacity);
  let end = Math.min(input.messages.length, start + MAX_HISTORICAL_CONTEXT_MESSAGES);
  if (end === input.messages.length) {
    start = Math.max(0, end - MAX_HISTORICAL_CONTEXT_MESSAGES);
  }

  return input.messages.slice(start, end).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content.slice(0, MAX_HISTORICAL_MESSAGE_CHARS),
  }));
};

export type HistoricalTurnInteractionResolution =
  | {
      status: "resolved";
      source: "message_metadata" | "legacy_audit" | "historical_interpretation";
      sourceUserMessageId: string;
      role: ConversationInteractionRole;
      semanticIntents: ObservationSemanticIntentInput[];
    }
  | { status: "requires_interpretation" }
  | {
      status: "skip";
      reason: "superseded_by_clarification" | "referenced_source_unavailable";
    }
  | {
      status: "unavailable";
      reason: "semantic_intent_missing" | "ambiguous" | "source_unavailable";
    };

/** Resolve a complete historical turn without making a provider call. */
export const inspectHistoricalTurnInteraction = (input: {
  sourceUserMessageId: string;
  messages: ReadonlyArray<ObservationSourceMessage>;
  legacyAuditMetadata?: unknown;
}): HistoricalTurnInteractionResolution => {
  const sourceMessage = input.messages.find(({ id }) => id === input.sourceUserMessageId);
  if (!sourceMessage) {
    return { status: "unavailable", reason: "source_unavailable" };
  }
  const sourceResolution = parseCanonicalInteractionResolution(sourceMessage.metadata);
  if (sourceResolution.status !== "absent") {
    return { status: "skip", reason: "superseded_by_clarification" };
  }
  const canonical = parseCanonicalInteractionMetadata(sourceMessage.metadata);
  if (canonical.status === "pointer") {
    const referencedSource = input.messages.find(({ id }) => id === canonical.sourceUserMessageId);
    if (!referencedSource) {
      return { status: "skip", reason: "referenced_source_unavailable" };
    }
    const clarificationResolution = parseCanonicalInteractionResolution(referencedSource.metadata);
    if (
      clarificationResolution.status !== "valid"
      || clarificationResolution.valueUserMessageId !== sourceMessage.id
    ) {
      return { status: "skip", reason: "referenced_source_unavailable" };
    }
    return {
      status: "resolved",
      source: "message_metadata",
      sourceUserMessageId: referencedSource.id,
      role: "clarification_value",
      semanticIntents: clarificationResolution.semanticIntents,
    };
  }
  if (canonical.status === "valid") {
    return {
      status: "resolved",
      source: "message_metadata",
      sourceUserMessageId: input.sourceUserMessageId,
      role: canonical.role,
      semanticIntents: canonical.semanticIntents,
    };
  }
  if (canonical.status === "invalid") {
    return { status: "unavailable", reason: "semantic_intent_missing" };
  }
  const legacy = parseLegacyAuditSemanticIntents(input.legacyAuditMetadata);
  if (legacy.length > 0) {
    return {
      status: "resolved",
      source: "legacy_audit",
      sourceUserMessageId: input.sourceUserMessageId,
      role: "substantive_new",
      semanticIntents: legacy,
    };
  }
  return { status: "requires_interpretation" };
};

/** Provider-backed fallback for history that predates canonical interaction metadata. */
export const interpretHistoricalTurnInteraction = async (input: {
  sourceUserMessageId: string;
  workspaceId?: string;
  conversationId?: string;
  messages: ReadonlyArray<ObservationSourceMessage>;
  interpreter: HistoricalInteractionInterpreterPort;
}): Promise<HistoricalTurnInteractionResolution> => {
  const messages = boundedHistoricalContext(input);
  if (messages.length === 0) {
    return { status: "unavailable", reason: "source_unavailable" };
  }
  const interpreted = await input.interpreter.interpret({
    sourceUserMessageId: input.sourceUserMessageId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messages,
  });
  const semanticIntents = boundObservationSemanticIntents(interpreted.semanticIntents).semanticIntents;
  if (roleCarriesSemanticIntent(interpreted.role) && semanticIntents.length === 0) {
    return { status: "unavailable", reason: "ambiguous" };
  }
  if (!roleCarriesSemanticIntent(interpreted.role) && semanticIntents.length > 0) {
    return { status: "unavailable", reason: "ambiguous" };
  }
  return {
    status: "resolved",
    source: "historical_interpretation",
    sourceUserMessageId: input.sourceUserMessageId,
    role: interpreted.role,
    semanticIntents,
  };
};

export const resolveHistoricalObservationSource = async (input: {
  sourceUserMessageId: string;
  semanticIntentId: string;
  semanticTextHash: string | null;
  messages: ReadonlyArray<ObservationSourceMessage>;
  legacyAuditMetadata?: unknown;
  interpreter?: HistoricalInteractionInterpreterPort;
}): Promise<ObservationSourceResolution> => {
  const sourceMessage = input.messages.find(({ id }) => id === input.sourceUserMessageId);
  if (!sourceMessage) {
    return { status: "unavailable", reason: "source_unavailable" };
  }

  if (parseCanonicalInteractionMetadata(sourceMessage.metadata).status === "pointer") {
    return { status: "unavailable", reason: "source_unavailable" };
  }

  if (input.semanticTextHash !== null) {
    const structured = resolveStructuredObservationSource({
      semanticIntentId: input.semanticIntentId,
      semanticTextHash: input.semanticTextHash,
      messageMetadata: sourceMessage.metadata,
      legacyAuditMetadata: input.legacyAuditMetadata,
      rawSourceContent: sourceMessage.content,
    });
    if (structured.status === "resolved" || structured.reason === "hash_mismatch") {
      return structured;
    }
  }

  if (!input.interpreter) {
    return { status: "unavailable", reason: "semantic_intent_missing" };
  }
  const messages = boundedHistoricalContext(input);
  if (messages.length === 0) {
    return { status: "unavailable", reason: "source_unavailable" };
  }
  const interpreted = await input.interpreter.interpret({
    sourceUserMessageId: input.sourceUserMessageId,
    messages,
  });
  if (!roleCarriesSemanticIntent(interpreted.role)) {
    return { status: "unavailable", reason: "ambiguous" };
  }
  const bounded = boundObservationSemanticIntents(interpreted.semanticIntents);
  const intent = input.semanticIntentId === "unresolved"
    ? bounded.semanticIntents.length === 1 ? bounded.semanticIntents[0] : undefined
    : bounded.semanticIntents.find(({ id }) => id === input.semanticIntentId);
  if (!intent) {
    return { status: "unavailable", reason: "ambiguous" };
  }
  const semanticTextHash = semanticIntentTextHash(intent.text);
  if (input.semanticTextHash !== null && semanticTextHash !== input.semanticTextHash) {
    return { status: "unavailable", reason: "hash_mismatch" };
  }
  return {
    status: "resolved",
    source: "historical_interpretation",
    semanticIntentId: intent.id,
    semanticText: intent.text,
    semanticTextHash,
  };
};
