import { randomUUID } from "node:crypto";

import { badRequest } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { isDynamicDateToken, normalizeDateRuleValue } from "./dynamicDateToken.js";

export const metadataRuleOperators = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "lt",
  "lte",
  "gt",
  "gte",
] as const;
export type MetadataRuleOperator = (typeof metadataRuleOperators)[number];

export const metadataRuleEffects = ["boost", "filter"] as const;
export type MetadataRuleEffect = (typeof metadataRuleEffects)[number];

export const metadataRuleTriggerModes = ["always_on", "match_turn"] as const;
export type MetadataRuleTriggerMode = (typeof metadataRuleTriggerModes)[number];

export const metadataRuleCombinators = ["and", "or"] as const;
export type MetadataRuleCombinator = (typeof metadataRuleCombinators)[number];

export const metadataValueTypes = ["string", "number", "date", "boolean"] as const;
export type MetadataValueType = (typeof metadataValueTypes)[number];

export interface MetadataFieldSuggestion {
  field: string;
  inferredType: MetadataValueType;
}

export interface RetrievalMetadataCondition {
  id: string;
  field: string;
  valueType: MetadataValueType;
  operator: MetadataRuleOperator;
  value: string;
}

export interface RetrievalMetadataRule {
  id: string;
  field: string;
  valueType: MetadataValueType;
  operator: MetadataRuleOperator;
  value: string;
  combinator?: MetadataRuleCombinator;
  conditions?: RetrievalMetadataCondition[];
  effect: MetadataRuleEffect;
  enabled: boolean;
  triggerMode: MetadataRuleTriggerMode;
  triggerInstruction?: string;
}

export const conversationModes = ["factual", "guided", "exploratory"] as const;
export type ConversationMode = (typeof conversationModes)[number];

export const MIN_SUGGESTED_QUESTIONS_COUNT = 1;
export const MAX_SUGGESTED_QUESTIONS_COUNT = 4;
export const DEFAULT_SUGGESTED_QUESTIONS_ENABLED = true;
export const DEFAULT_SUGGESTED_QUESTIONS_COUNT = 3;

interface RetrievalSettingsPayload {
  metadataRules?: unknown;
  semanticRewriteInstructions?: unknown;
  lexicalRewriteInstructions?: unknown;
  conversationMode?: unknown;
  suggestedQuestionsEnabled?: unknown;
  suggestedQuestionsCount?: unknown;
}

interface LegacyMetadataRule {
  id?: unknown;
  field?: unknown;
  valueType?: unknown;
  operator?: unknown;
  value?: unknown;
  combinator?: unknown;
  conditions?: unknown;
  effect?: unknown;
  enabled?: unknown;
  triggerMode?: unknown;
  triggerInstruction?: unknown;
}

export interface RetrievalSettingsRecord {
  workspaceId: string;
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  conversationMode: ConversationMode;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  customInstruction: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetrievalSettingsInput {
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  conversationMode: ConversationMode;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  customInstruction: string;
}

// Kept for internal retrieval tests that still exercise query-derived attribute logic.
export const DEFAULT_SEMANTIC_REWRITE_INSTRUCTIONS =
  "Rewrite for semantic retrieval with the same meaning. Keep the query standalone, preserve proper nouns and technical terms, and avoid adding new topics.";

export const DEFAULT_LEXICAL_REWRITE_INSTRUCTIONS =
  "Rewrite for lexical retrieval using exact literals likely to appear in the corpus. Prefer aliases, abbreviations, citation forms, and corpus-native notation when grounded.";

export const DEFAULT_CONVERSATION_MODE: ConversationMode = "guided";

export const defaultRetrievalSettings = (workspaceId: string): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: false,
  semanticRewriteInstructions: DEFAULT_SEMANTIC_REWRITE_INSTRUCTIONS,
  lexicalRewriteInstructions: DEFAULT_LEXICAL_REWRITE_INSTRUCTIONS,
  conversationMode: DEFAULT_CONVERSATION_MODE,
  suggestedQuestionsEnabled: DEFAULT_SUGGESTED_QUESTIONS_ENABLED,
  suggestedQuestionsCount: DEFAULT_SUGGESTED_QUESTIONS_COUNT,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold,
  rerankTopK: 5,
  citationDisplayEnabled: true,
  metadataRules: [],
  customInstruction: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const normalizeMetadataField = (value: string): string => value.trim();

const normalizeRewriteInstruction = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : fallback;
};

export const createDefaultMetadataRule = (): RetrievalMetadataRule => ({
  id: randomUUID(),
  field: "",
  valueType: "string",
  operator: "equals",
  value: "",
  combinator: "and",
  conditions: [],
  effect: "boost",
  enabled: true,
  triggerMode: "always_on",
});

export const createDefaultMetadataCondition = (): RetrievalMetadataCondition => ({
  id: randomUUID(),
  field: "",
  valueType: "string",
  operator: "equals",
  value: "",
});

const isFieldSupported = (field: string): boolean => /^[A-Za-z0-9_.-]+$/.test(field);

export const allowedOperatorsForValueType = (valueType: MetadataValueType): MetadataRuleOperator[] => {
  if (valueType === "string") {
    return ["equals", "not_equals", "contains", "not_contains"];
  }
  if (valueType === "boolean") {
    return ["equals", "not_equals"];
  }

  return ["equals", "not_equals", "lt", "lte", "gt", "gte"];
};

const isIsoDateLike = (value: string): boolean => /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value.trim());

export const inferMetadataValueType = (value: unknown): MetadataValueType => {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "string" && isIsoDateLike(value) && !Number.isNaN(Date.parse(value))) {
    return "date";
  }

  return "string";
};

const isBooleanLiteral = (value: string): boolean => /^(true|false)$/i.test(value.trim());
const isNumberLiteral = (value: string): boolean => value.trim().length > 0 && Number.isFinite(Number(value));
const isDateLiteral = (value: string): boolean => isIsoDateLike(value) && !Number.isNaN(Date.parse(value));
const normalizeTriggerInstruction = (value: string): string | undefined => {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeMetadataCondition = (candidate: Partial<RetrievalMetadataCondition>): RetrievalMetadataCondition => ({
  id: typeof candidate.id === "string" && candidate.id.trim().length > 0 ? candidate.id.trim() : randomUUID(),
  field: typeof candidate.field === "string" ? normalizeMetadataField(candidate.field) : "",
  valueType: metadataValueTypes.includes(candidate.valueType as MetadataValueType)
    ? (candidate.valueType as MetadataValueType)
    : inferMetadataValueType(candidate.value),
  operator: metadataRuleOperators.includes(candidate.operator as MetadataRuleOperator)
    ? (candidate.operator as MetadataRuleOperator)
    : "equals",
  value: typeof candidate.value === "string" ? normalizeDateRuleValue(candidate.value) : String(candidate.value ?? ""),
});

export const getNormalizedMetadataConditions = (rule: RetrievalMetadataRule): RetrievalMetadataCondition[] => {
  if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
    return rule.conditions.map((condition) => normalizeMetadataCondition(condition));
  }

  return [
    normalizeMetadataCondition({
      field: rule.field,
      valueType: rule.valueType,
      operator: rule.operator,
      value: rule.value,
    }),
  ];
};

export const normalizeMetadataRules = (value: unknown): RetrievalMetadataRule[] => {
  const rawRules: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as RetrievalSettingsPayload).metadataRules)
      ? [...(((value as RetrievalSettingsPayload).metadataRules ?? []) as unknown[])]
      : [];

  const normalizedIds = new Set<string>();
  const normalizedRules: RetrievalMetadataRule[] = [];

  for (const entry of rawRules) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as LegacyMetadataRule;
    const rawConditions = Array.isArray(candidate.conditions) ? candidate.conditions : [];
    const normalizedConditions = rawConditions
      .filter((entry): entry is Partial<RetrievalMetadataCondition> => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeMetadataCondition(entry))
      .filter((entry) => entry.field.length > 0);

    const fallbackCondition = normalizeMetadataCondition({
      field: typeof candidate.field === "string" ? candidate.field : "",
      valueType: candidate.valueType as MetadataValueType | undefined,
      operator: candidate.operator as MetadataRuleOperator | undefined,
      value: typeof candidate.value === "string" ? candidate.value : String(candidate.value ?? ""),
    });

    const conditions =
      normalizedConditions.length > 0
        ? normalizedConditions
        : fallbackCondition.field.length > 0
          ? [fallbackCondition]
          : [];

    const primaryCondition = conditions[0];
    if (!primaryCondition || !isFieldSupported(primaryCondition.field)) {
      continue;
    }

    const ruleId =
      typeof candidate.id === "string" && candidate.id.trim().length > 0 && !normalizedIds.has(candidate.id.trim())
        ? candidate.id.trim()
        : randomUUID();
    normalizedIds.add(ruleId);

    normalizedRules.push({
      id: ruleId,
      field: primaryCondition.field,
      valueType: primaryCondition.valueType,
      operator: primaryCondition.operator,
      value: primaryCondition.value,
      combinator: metadataRuleCombinators.includes(candidate.combinator as MetadataRuleCombinator)
        ? (candidate.combinator as MetadataRuleCombinator)
        : "and",
      conditions,
      effect: metadataRuleEffects.includes(candidate.effect as MetadataRuleEffect)
        ? (candidate.effect as MetadataRuleEffect)
        : "boost",
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
      triggerMode: metadataRuleTriggerModes.includes(candidate.triggerMode as MetadataRuleTriggerMode)
        ? (candidate.triggerMode as MetadataRuleTriggerMode)
        : normalizeTriggerInstruction(typeof candidate.triggerInstruction === "string" ? candidate.triggerInstruction : "")
          ? "match_turn"
          : "always_on",
      triggerInstruction: normalizeTriggerInstruction(
        typeof candidate.triggerInstruction === "string" ? candidate.triggerInstruction : "",
      ),
    });
  }

  return normalizedRules;
};

export const validateRetrievalSettings = (input: RetrievalSettingsInput): RetrievalSettingsInput => {
  if (typeof input.semanticRewriteInstructions !== "string") {
    throw badRequest("semanticRewriteInstructions must be a string");
  }
  if (typeof input.lexicalRewriteInstructions !== "string") {
    throw badRequest("lexicalRewriteInstructions must be a string");
  }
  if (!conversationModes.includes(input.conversationMode)) {
    throw badRequest("conversationMode must be a supported value");
  }
  if (typeof input.suggestedQuestionsEnabled !== "boolean") {
    throw badRequest("suggestedQuestionsEnabled must be a boolean");
  }
  if (!Number.isInteger(input.suggestedQuestionsCount)) {
    throw badRequest("suggestedQuestionsCount must be an integer");
  }
  if (
    input.suggestedQuestionsCount < MIN_SUGGESTED_QUESTIONS_COUNT ||
    input.suggestedQuestionsCount > MAX_SUGGESTED_QUESTIONS_COUNT
  ) {
    throw badRequest(
      `suggestedQuestionsCount must be between ${MIN_SUGGESTED_QUESTIONS_COUNT} and ${MAX_SUGGESTED_QUESTIONS_COUNT}`,
    );
  }
  if (input.semanticRewriteInstructions.length > 2000) {
    throw badRequest("semanticRewriteInstructions must not exceed 2000 characters");
  }
  if (input.lexicalRewriteInstructions.length > 2000) {
    throw badRequest("lexicalRewriteInstructions must not exceed 2000 characters");
  }
  if (input.vectorTopK < 1 || input.vectorTopK > 300) {
    throw badRequest("vectorTopK must be between 1 and 300");
  }
  if (input.similarityThreshold < 0 || input.similarityThreshold > 1) {
    throw badRequest("similarityThreshold must be between 0 and 1");
  }
  if (input.rerankTopK < 1) {
    throw badRequest("rerankTopK must be greater than 0");
  }
  if (input.rerankTopK > RETRIEVAL_BEHAVIOR.rerank.candidateLimit) {
    throw badRequest(`rerankTopK must be at most ${RETRIEVAL_BEHAVIOR.rerank.candidateLimit}`);
  }
  if (!Array.isArray(input.metadataRules)) {
    throw badRequest("metadataRules must be an array");
  }

  const seenRuleIds = new Set<string>();
  for (const rule of input.metadataRules) {
    const conditions = getNormalizedMetadataConditions(rule);
    const normalizedTriggerInstruction = normalizeTriggerInstruction(rule.triggerInstruction ?? "");
    const normalizedTriggerMode =
      metadataRuleTriggerModes.includes(rule.triggerMode)
        ? rule.triggerMode
        : normalizedTriggerInstruction
          ? "match_turn"
          : "always_on";

    if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
      throw badRequest("metadataRules id must be a non-empty string");
    }
    if (seenRuleIds.has(rule.id)) {
      throw badRequest("metadataRules must not contain duplicate ids");
    }
    if (conditions.length === 0) {
      throw badRequest("metadataRules must contain at least one condition");
    }
    if (typeof rule.combinator !== "undefined" && !metadataRuleCombinators.includes(rule.combinator)) {
      throw badRequest("metadataRules combinator must be supported");
    }
    if (!metadataRuleEffects.includes(rule.effect)) {
      throw badRequest("metadataRules effect must be supported");
    }
    if (typeof rule.triggerInstruction !== "undefined" && typeof rule.triggerInstruction !== "string") {
      throw badRequest("metadataRules triggerInstruction must be a string when provided");
    }
    if (normalizedTriggerMode === "match_turn" && !normalizedTriggerInstruction) {
      throw badRequest("metadataRules triggerInstruction must be provided for match_turn rules");
    }
    if (typeof rule.enabled !== "boolean") {
      throw badRequest("metadataRules enabled must be a boolean");
    }

    const seenConditionIds = new Set<string>();
    for (const condition of conditions) {
      if (typeof condition.id !== "string" || condition.id.trim().length === 0) {
        throw badRequest("metadataRules conditions id must be a non-empty string");
      }
      if (seenConditionIds.has(condition.id)) {
        throw badRequest("metadataRules conditions must not contain duplicate ids");
      }
      if (typeof condition.field !== "string" || normalizeMetadataField(condition.field).length === 0) {
        throw badRequest("metadataRules field must be a non-empty string");
      }
      if (!isFieldSupported(normalizeMetadataField(condition.field))) {
        throw badRequest("metadataRules field must use only letters, numbers, dots, underscores, or hyphens");
      }
      if (!metadataValueTypes.includes(condition.valueType)) {
        throw badRequest("metadataRules valueType must be supported");
      }
      if (!metadataRuleOperators.includes(condition.operator)) {
        throw badRequest("metadataRules operator must be supported");
      }
      if (!allowedOperatorsForValueType(condition.valueType).includes(condition.operator)) {
        throw badRequest("metadataRules operator must be valid for the selected valueType");
      }
      if (typeof condition.value !== "string") {
        throw badRequest("metadataRules value must be a string");
      }
      if (condition.valueType === "boolean" && !isBooleanLiteral(condition.value)) {
        throw badRequest("metadataRules boolean values must be true or false");
      }
      if (condition.valueType === "number" && !isNumberLiteral(condition.value)) {
        throw badRequest("metadataRules number values must be numeric");
      }
      if (isDynamicDateToken(condition.value) && condition.valueType !== "date") {
        throw badRequest("metadataRules dynamic date tokens are supported only for date values");
      }
      if (condition.valueType === "date" && !isDateLiteral(condition.value) && !isDynamicDateToken(condition.value)) {
        throw badRequest("metadataRules date values must use ISO format such as 2026-03-26");
      }
      seenConditionIds.add(condition.id);
    }

    seenRuleIds.add(rule.id);
  }

  if (typeof input.customInstruction !== "string") {
    throw badRequest("customInstruction must be a string");
  }
  if (input.customInstruction.length > 2000) {
    throw badRequest("customInstruction must not exceed 2000 characters");
  }

  return {
    ...input,
    semanticRewriteInstructions: normalizeRewriteInstruction(
      input.semanticRewriteInstructions,
      DEFAULT_SEMANTIC_REWRITE_INSTRUCTIONS,
    ),
    lexicalRewriteInstructions: normalizeRewriteInstruction(
      input.lexicalRewriteInstructions,
      DEFAULT_LEXICAL_REWRITE_INSTRUCTIONS,
    ),
    suggestedQuestionsCount: Math.max(
      MIN_SUGGESTED_QUESTIONS_COUNT,
      Math.min(MAX_SUGGESTED_QUESTIONS_COUNT, input.suggestedQuestionsCount),
    ),
    metadataRules: input.metadataRules.map((rule) => ({
      ...rule,
      field: getNormalizedMetadataConditions(rule)[0]?.field ?? "",
      valueType: getNormalizedMetadataConditions(rule)[0]?.valueType ?? "string",
      operator: getNormalizedMetadataConditions(rule)[0]?.operator ?? "equals",
      value: getNormalizedMetadataConditions(rule)[0]?.value ?? "",
      combinator: metadataRuleCombinators.includes(rule.combinator ?? "and")
        ? (rule.combinator ?? "and")
        : "and",
      conditions: getNormalizedMetadataConditions(rule).map((condition) => ({
        ...condition,
        field: normalizeMetadataField(condition.field),
        value: condition.valueType === "date" ? normalizeDateRuleValue(condition.value) : condition.value.trim(),
      })),
      triggerInstruction: normalizeTriggerInstruction(rule.triggerInstruction ?? ""),
      triggerMode: metadataRuleTriggerModes.includes(rule.triggerMode)
        ? rule.triggerMode
        : normalizeTriggerInstruction(rule.triggerInstruction ?? "")
          ? "match_turn"
          : "always_on",
    })),
  };
};
